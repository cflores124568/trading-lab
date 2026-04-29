import itertools
from typing import Any

import numpy as np
import pandas as pd

from schemas import BacktestRequest
from services.backtest_service import build_backtest_result
from services.data_loader import get_dataset

DEFAULT_MONTE_CARLO_SIMULATIONS = 200
DEFAULT_PARAMETER_SWEEP_LIMIT = 15
DEFAULT_WALK_FORWARD_FOLDS = 3
DEFAULT_RANKING_RULE = "prop_score_v1"


def analyze_backtest_robustness(
    backtest: dict,
    *,
    monte_carlo_simulations: int = DEFAULT_MONTE_CARLO_SIMULATIONS,
    parameter_sweep_limit: int = DEFAULT_PARAMETER_SWEEP_LIMIT,
    walk_forward_folds: int = DEFAULT_WALK_FORWARD_FOLDS,
) -> dict:
    """Run the next layer of sanity checks around one saved backtest.

    This keeps the saved run as the anchor, then adds three pressure tests on
    top: random trade-path sims, a local param neighborhood sweep, and a simple
    walk-forward loop that re-picks params on train data before scoring the next
    untouched chunk. It's still lightweight, but it stops one clean equity curve
    from doing all the talking by itself.
    """
    dataset = get_dataset(backtest["dataset_id"])
    request, warnings = _request_from_backtest(backtest)
    strategy_type = backtest["strategy"]["type"]
    base_params = backtest["strategy"].get("params") or {}
    seed = _seed_from_backtest(backtest["backtest_id"])

    parameter_runs = _run_parameter_sweep(
        dataset=dataset,
        request=request,
        strategy_type=strategy_type,
        base_params=base_params,
        limit=parameter_sweep_limit,
    )
    monte_carlo = _run_monte_carlo(
        backtest=backtest,
        initial_balance=request.initial_balance,
        simulations=monte_carlo_simulations,
        seed=seed,
    )
    walk_forward = _run_walk_forward(
        dataset=dataset,
        request=request,
        strategy_type=strategy_type,
        base_params=base_params,
        limit=parameter_sweep_limit,
        folds=walk_forward_folds,
    )

    return {
        "backtest_id": backtest["backtest_id"],
        "symbol": backtest.get("symbol"),
        "strategy_type": strategy_type,
        "run_config": {
            "initial_balance": request.initial_balance,
            "position_size": request.position_size,
            "commission": request.commission,
            "tick_size": request.tick_size,
            "tick_value": request.tick_value,
            "slippage_ticks": request.slippage_ticks,
        },
        "baseline": {
            "total_pnl": float(backtest["metrics"]["total_pnl"]),
            "max_drawdown": float(backtest["metrics"]["max_drawdown"]),
            "profit_factor": float(backtest["metrics"]["profit_factor"]),
            "win_rate": float(backtest["metrics"]["win_rate"]),
            "total_trades": int(backtest["metrics"]["total_trades"]),
            "passed": bool(backtest["prop_firm_eval"]["passed"]),
        },
        "monte_carlo": monte_carlo,
        "parameter_sweep": _summarize_parameter_sweep(backtest, parameter_runs),
        "walk_forward": walk_forward,
        "warnings": warnings,
    }


def _request_from_backtest(backtest: dict) -> tuple[BacktestRequest, list[str]]:
    """Rebuild the original run request as honestly as the saved row allows."""
    run_config = backtest.get("run_config") or {}
    trades = backtest.get("trades") or []
    warnings: list[str] = []

    initial_balance = float(
        run_config.get("initial_balance")
        or backtest["prop_firm_rules"].get("account_size")
        or 100_000
    )
    position_size = float(run_config.get("position_size") or 1.0)
    commission = float(
        run_config.get("commission")
        if run_config.get("commission") is not None
        else (trades[0].get("commission") if trades and trades[0].get("commission") is not None else 5.0)
    )
    tick_value = float(run_config.get("tick_value") or 12.5)
    tick_size = float(run_config.get("tick_size") or 0.25)
    slippage_ticks = float(run_config.get("slippage_ticks") or 1.0)

    if not run_config:
        warnings.append(
            "This backtest predates persisted run config, so robustness reruns assume "
            "`position_size=1`, `tick_size=0.25`, `tick_value=12.5`, and "
            "`slippage_ticks=1` unless the saved row says otherwise."
        )

    return BacktestRequest(
        dataset_id=backtest["dataset_id"],
        strategy=backtest["strategy"],
        prop_firm_rules=backtest["prop_firm_rules"],
        start_date=backtest.get("replay_context", {}).get("start_date") if backtest.get("replay_context") else None,
        end_date=backtest.get("replay_context", {}).get("end_date") if backtest.get("replay_context") else None,
        initial_balance=initial_balance,
        position_size=position_size,
        commission=commission,
        tick_size=tick_size,
        tick_value=tick_value,
        slippage_ticks=slippage_ticks,
    ), warnings


def _run_monte_carlo(
    *,
    backtest: dict,
    initial_balance: float,
    simulations: int,
    seed: int,
) -> list[dict]:
    """Stress the saved trade list with a couple of random path assumptions."""
    trades = backtest.get("trades") or []
    if not trades:
        return [{
            "key": "no_trades",
            "label": "No trades to simulate",
            "simulations": 0,
            "total_pnl": _distribution([0.0]),
            "max_drawdown": _distribution([0.0]),
            "profitable_rate": 0.0,
            "worse_than_base_drawdown_rate": 0.0,
            "note": "This run never closed a trade, so Monte Carlo doesn't have anything real to reshuffle.",
        }]

    pnls = np.array([float(trade["pnl"]) for trade in trades], dtype=np.float64)
    base_drawdown = float(backtest["metrics"]["max_drawdown"])
    rng = np.random.default_rng(seed)
    scenarios: list[dict] = []

    for key, label, sampler, note in [
        (
            "shuffle",
            "Trade order shuffle",
            lambda local_rng: local_rng.permutation(pnls),
            "Same trade outcomes, different order. Ending PnL stays fixed here, so this mostly tells you how path-dependent the drawdown is.",
        ),
        (
            "bootstrap",
            "Bootstrap resample",
            lambda local_rng: local_rng.choice(pnls, size=len(pnls), replace=True),
            "Resamples trades with replacement so the ending PnL can drift too. It's not market magic, but it does show how much your edge leans on one lucky sample.",
        ),
    ]:
        total_pnls: list[float] = []
        max_drawdowns: list[float] = []
        profitable = 0
        worse_than_base = 0

        for _ in range(simulations):
            sampled = sampler(rng)
            equity_curve = _equity_from_trade_pnls(initial_balance, sampled)
            total_pnl = float(np.sum(sampled))
            max_drawdown = _max_drawdown(equity_curve)

            total_pnls.append(round(total_pnl, 4))
            max_drawdowns.append(round(max_drawdown, 6))
            if total_pnl > 0:
                profitable += 1
            if max_drawdown > base_drawdown:
                worse_than_base += 1

        scenarios.append({
            "key": key,
            "label": label,
            "simulations": simulations,
            "total_pnl": _distribution(total_pnls),
            "max_drawdown": _distribution(max_drawdowns),
            "profitable_rate": round(profitable / simulations, 4),
            "worse_than_base_drawdown_rate": round(worse_than_base / simulations, 4),
            "note": note,
        })

    return scenarios


def _run_parameter_sweep(
    *,
    dataset: dict,
    request: BacktestRequest,
    strategy_type: str,
    base_params: dict[str, Any],
    limit: int,
) -> list[dict]:
    """Run a small local parameter grid around the saved setup."""
    candidates = _generate_parameter_candidates(strategy_type, base_params, limit)
    runs: list[dict] = []

    for params in candidates:
        candidate_request = BacktestRequest(
            **{
                **request.model_dump(),
                "strategy": {"type": strategy_type, "params": params},
            }
        )
        result = build_backtest_result(dataset, candidate_request)
        runs.append(_summarize_run(result, params))

    runs.sort(key=lambda run: (-run["score"], run["max_drawdown"], -run["profit_factor"]))
    for index, run in enumerate(runs, start=1):
        run["rank"] = index
    return runs


def _summarize_parameter_sweep(backtest: dict, runs: list[dict]) -> dict:
    """Collapse the local sweep into something the UI can scan quickly."""
    if not runs:
        return {
            "ranking_rule": DEFAULT_RANKING_RULE,
            "total_runs": 0,
            "profitable_rate": 0.0,
            "passing_rate": 0.0,
            "baseline_rank": None,
            "median_score": 0.0,
            "median_total_pnl": 0.0,
            "top_runs": [],
            "bottom_run": None,
            "note": "No local parameter candidates were available for this strategy.",
        }

    scores = np.array([run["score"] for run in runs], dtype=np.float64)
    pnls = np.array([run["total_pnl"] for run in runs], dtype=np.float64)
    profitable = sum(1 for run in runs if run["total_pnl"] > 0)
    passing = sum(1 for run in runs if run["passed"])
    base_params = backtest["strategy"].get("params") or {}
    baseline_rank = next((run["rank"] for run in runs if run["params"] == base_params), None)

    return {
        "ranking_rule": DEFAULT_RANKING_RULE,
        "total_runs": len(runs),
        "profitable_rate": round(profitable / len(runs), 4),
        "passing_rate": round(passing / len(runs), 4),
        "baseline_rank": baseline_rank,
        "median_score": round(float(np.median(scores)), 4),
        "median_total_pnl": round(float(np.median(pnls)), 4),
        "top_runs": [_strip_run(run) for run in runs[:5]],
        "bottom_run": _strip_run(runs[-1]),
        "note": "This is a local neighborhood check, not a giant optimizer. The point is to see whether the saved params look sturdy or weirdly lucky.",
    }


def _run_walk_forward(
    *,
    dataset: dict,
    request: BacktestRequest,
    strategy_type: str,
    base_params: dict[str, Any],
    limit: int,
    folds: int,
) -> dict:
    """Re-pick params on train chunks, then score them on the next untouched chunk."""
    df = dataset["df"]
    segments = folds + 2
    if len(df) < max(segments * 40, 120):
        return {
            "ranking_rule": DEFAULT_RANKING_RULE,
            "folds_requested": folds,
            "folds_completed": 0,
            "profitable_rate": 0.0,
            "passing_rate": 0.0,
            "total_test_pnl": 0.0,
            "average_test_score": 0.0,
            "average_test_pnl": 0.0,
            "folds": [],
            "note": "Not enough bars yet for a useful walk-forward split. This wants at least a few meaningful train and test chunks.",
        }

    boundaries = np.linspace(0, len(df), segments + 1, dtype=int)
    folds_out: list[dict] = []
    candidates = _generate_parameter_candidates(strategy_type, base_params, limit)

    for fold_index in range(folds):
        train_end = int(boundaries[fold_index + 2])
        test_end = int(boundaries[fold_index + 3])
        train_df = df.iloc[:train_end].copy()
        test_df = df.iloc[train_end:test_end].copy()

        if train_df.empty or test_df.empty:
            continue

        train_dataset = _dataset_from_frame(dataset, train_df)
        test_dataset = _dataset_from_frame(dataset, test_df)

        ranked_train_runs = []
        for params in candidates:
            train_request = BacktestRequest(
                **{
                    **request.model_dump(),
                    "strategy": {"type": strategy_type, "params": params},
                }
            )
            train_result = build_backtest_result(train_dataset, train_request)
            ranked_train_runs.append(_summarize_run(train_result, params))

        ranked_train_runs.sort(key=lambda run: (-run["score"], run["max_drawdown"], -run["profit_factor"]))
        best_train = ranked_train_runs[0]

        test_request = BacktestRequest(
            **{
                **request.model_dump(),
                "strategy": {"type": strategy_type, "params": best_train["params"]},
            }
        )
        test_result = build_backtest_result(test_dataset, test_request)
        test_summary = _summarize_run(test_result, best_train["params"])

        folds_out.append({
            "fold_index": fold_index + 1,
            "train_start": _iso(train_df.index[0]),
            "train_end": _iso(train_df.index[-1]),
            "test_start": _iso(test_df.index[0]),
            "test_end": _iso(test_df.index[-1]),
            "selected_params": best_train["params"],
            "train_score": best_train["score"],
            "test_score": test_summary["score"],
            "test_total_pnl": test_summary["total_pnl"],
            "test_max_drawdown": test_summary["max_drawdown"],
            "test_passed": test_summary["passed"],
            "test_trades": test_summary["total_trades"],
        })

    if not folds_out:
        return {
            "ranking_rule": DEFAULT_RANKING_RULE,
            "folds_requested": folds,
            "folds_completed": 0,
            "profitable_rate": 0.0,
            "passing_rate": 0.0,
            "total_test_pnl": 0.0,
            "average_test_score": 0.0,
            "average_test_pnl": 0.0,
            "folds": [],
            "note": "Walk-forward couldn't produce any non-empty folds from this saved dataset.",
        }

    profitable = sum(1 for fold in folds_out if fold["test_total_pnl"] > 0)
    passing = sum(1 for fold in folds_out if fold["test_passed"])
    total_test_pnl = sum(float(fold["test_total_pnl"]) for fold in folds_out)
    average_test_score = float(np.mean([fold["test_score"] for fold in folds_out]))
    average_test_pnl = float(np.mean([fold["test_total_pnl"] for fold in folds_out]))

    return {
        "ranking_rule": DEFAULT_RANKING_RULE,
        "folds_requested": folds,
        "folds_completed": len(folds_out),
        "profitable_rate": round(profitable / len(folds_out), 4),
        "passing_rate": round(passing / len(folds_out), 4),
        "total_test_pnl": round(total_test_pnl, 4),
        "average_test_score": round(average_test_score, 4),
        "average_test_pnl": round(average_test_pnl, 4),
        "folds": folds_out,
        "note": "Each fold re-picks params on the train chunk only, then scores the next untouched chunk out of sample.",
    }


def _summarize_run(result: dict, params: dict[str, Any]) -> dict:
    """Trim one backtest result down to the bits the robustness views need."""
    score = _score_backtest(result)
    return {
        "params": params,
        "score": round(score, 4),
        "total_pnl": float(result["metrics"]["total_pnl"]),
        "max_drawdown": float(result["metrics"]["max_drawdown"]),
        "profit_factor": float(result["metrics"]["profit_factor"]),
        "passed": bool(result["prop_firm_eval"]["passed"]),
        "total_trades": int(result["metrics"]["total_trades"]),
    }


def _score_backtest(result: dict) -> float:
    from services.experiment_service import score_backtest

    return float(score_backtest(result, DEFAULT_RANKING_RULE))


def _strip_run(run: dict) -> dict:
    return {
        "rank": int(run["rank"]),
        "params": run["params"],
        "score": float(run["score"]),
        "total_pnl": float(run["total_pnl"]),
        "max_drawdown": float(run["max_drawdown"]),
        "profit_factor": float(run["profit_factor"]),
        "passed": bool(run["passed"]),
    }


def _generate_parameter_candidates(strategy_type: str, base_params: dict[str, Any], limit: int) -> list[dict[str, Any]]:
    """Build a tight local grid around the saved params instead of going huge."""
    keys = list(base_params.keys())
    if not keys:
        return [dict(base_params)]

    values_by_key = {
        key: _candidate_values(key, base_params[key])
        for key in keys
    }

    combos = []
    seen: set[tuple[tuple[str, Any], ...]] = set()
    for raw_combo in itertools.product(*(values_by_key[key] for key in keys)):
        candidate = dict(zip(keys, raw_combo))
        if not _candidate_is_valid(strategy_type, candidate):
            continue

        normalized_items = tuple(sorted((key, _normalize_number(value)) for key, value in candidate.items()))
        if normalized_items in seen:
            continue
        seen.add(normalized_items)
        combos.append(candidate)

    combos.sort(key=lambda combo: (_param_distance(combo, base_params), tuple(str(combo[key]) for key in keys)))

    if dict(base_params) not in combos:
        combos.insert(0, dict(base_params))

    trimmed = combos[:limit]
    if dict(base_params) not in trimmed:
        trimmed[-1] = dict(base_params)

    trimmed.sort(key=lambda combo: (_param_distance(combo, base_params), tuple(str(combo[key]) for key in keys)))
    return trimmed


def _candidate_values(key: str, base_value: Any) -> list[Any]:
    value = float(base_value)

    if key in {"fast_period", "slow_period", "rsi_period", "bb_period", "atr_period"}:
        return _unique_numbers([max(2, round(value - 2)), max(2, round(value)), max(2, round(value + 2))], integer=True)
    if key == "std_dev":
        return _unique_numbers([max(0.5, value - 0.5), value, min(5.0, value + 0.5)], integer=False)
    if key == "overbought":
        return _unique_numbers([max(55, value - 5), value, min(95, value + 5)], integer=True)
    if key == "oversold":
        return _unique_numbers([max(5, value - 5), value, min(45, value + 5)], integer=True)

    return _unique_numbers([value], integer=float(value).is_integer())


def _candidate_is_valid(strategy_type: str, params: dict[str, Any]) -> bool:
    if strategy_type in {"ma_crossover", "ema_crossover"}:
        fast = int(params.get("fast_period", 0))
        slow = int(params.get("slow_period", 0))
        return fast >= 2 and slow > fast

    if strategy_type == "rsi_overbought":
        overbought = float(params.get("overbought", 70))
        oversold = float(params.get("oversold", 30))
        return oversold < overbought

    return True


def _param_distance(candidate: dict[str, Any], base_params: dict[str, Any]) -> float:
    distance = 0.0
    for key, base_value in base_params.items():
        candidate_value = candidate.get(key, base_value)
        distance += abs(float(candidate_value) - float(base_value))
    return distance


def _unique_numbers(values: list[float], *, integer: bool) -> list[Any]:
    out: list[Any] = []
    seen: set[float] = set()
    for value in values:
        normalized = int(round(value)) if integer else round(float(value), 4)
        if normalized in seen:
            continue
        seen.add(normalized)
        out.append(normalized)
    return out


def _normalize_number(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 6)
    return value


def _dataset_from_frame(dataset: dict, df: pd.DataFrame) -> dict:
    info = {
        **dataset["info"],
        "start_date": _iso(df.index[0]),
        "end_date": _iso(df.index[-1]),
        "rows": len(df),
    }
    return {
        "info": info,
        "df": df.copy(),
    }


def _distribution(values: list[float]) -> dict:
    arr = np.array(values, dtype=np.float64)
    return {
        "p05": round(float(np.percentile(arr, 5)), 4),
        "median": round(float(np.percentile(arr, 50)), 4),
        "p95": round(float(np.percentile(arr, 95)), 4),
        "worst": round(float(np.min(arr)), 4),
        "best": round(float(np.max(arr)), 4),
    }


def _equity_from_trade_pnls(initial_balance: float, pnls: np.ndarray) -> list[float]:
    equity = [float(initial_balance)]
    balance = float(initial_balance)
    for pnl in pnls:
        balance += float(pnl)
        equity.append(balance)
    return equity


def _max_drawdown(equity_curve: list[float]) -> float:
    if len(equity_curve) < 2:
        return 0.0

    eq = np.array(equity_curve, dtype=np.float64)
    peak = np.maximum.accumulate(eq)
    drawdown = np.divide(
        peak - eq,
        peak,
        out=np.zeros_like(eq, dtype=np.float64),
        where=peak != 0,
    )
    return float(np.max(drawdown))


def _seed_from_backtest(backtest_id: str) -> int:
    compact = "".join(ch for ch in backtest_id if ch.isalnum())
    return int(compact[:12], 16) if compact else 42


def _iso(value: Any) -> str:
    return value.isoformat() if hasattr(value, "isoformat") else str(value)
