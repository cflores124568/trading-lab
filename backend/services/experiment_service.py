import uuid
from datetime import datetime
from itertools import product
from typing import Any

from schemas import (
    BacktestRequest,
    ExperimentCreate,
    ExperimentResult,
    Strategy,
)
from services.backtest_service import build_backtest_result, persist_backtest_result
from services.data_loader import get_dataset, load_from_db, normalise_interval
from services.experiment_repo import (
    list_experiment_runs as list_experiment_runs_db,
    replace_experiment_runs as replace_experiment_runs_db,
    save_experiment,
)
from services.experiment_store import (
    add_experiment,
    get_experiment as get_experiment_mem,
    list_experiment_runs as list_experiment_runs_mem,
    replace_experiment_runs as replace_experiment_runs_mem,
)

MAX_EXPERIMENT_RUNS = 250


def create_experiment_record(request: ExperimentCreate) -> dict:
    """Create the saved experiment spec without running it yet.

    I keep this part lightweight on purpose. Phase 1 is about defining a clean
    batch-research job first, then letting the run endpoint fan it out when
    you're ready instead of doing surprise work on create.
    """
    symbols = _normalize_symbols(request.symbols)
    intervals = _normalize_intervals(request.intervals)
    parameter_space = normalize_parameter_space(request.parameter_space)

    now = datetime.utcnow().isoformat()
    result = ExperimentResult(
        experiment_id=str(uuid.uuid4()),
        name=request.name,
        symbols=symbols,
        intervals=intervals,
        strategy_type=request.strategy_type,
        parameter_space=parameter_space,
        start_date=request.start_date,
        end_date=request.end_date,
        prop_firm_rules=request.prop_firm_rules,
        initial_balance=request.initial_balance,
        position_size=request.position_size,
        commission=request.commission,
        scoring_rule=request.scoring_rule,
        status="draft",
        total_runs=0,
        completed_runs=0,
        failed_runs=0,
        best_run_id=None,
        best_backtest_id=None,
        last_run_at=None,
        created_at=now,
        updated_at=now,
    ).model_dump(mode="json")

    add_experiment(result["experiment_id"], result)

    if _db_required():
        save_experiment(result)

    return result


def run_experiment(experiment: dict) -> tuple[dict, list[dict]]:
    """Expand the experiment grid, run saved backtests, and rank the results.

    Each batch run intentionally reuses the normal backtest pipeline and writes
    real saved backtests underneath. That way the experiment layer is just an
    orchestrator around the trusted core, not some second simulator to babysit.
    """
    plans = expand_experiment_runs(experiment)
    now = datetime.utcnow().isoformat()
    running = {
        **experiment,
        "status": "running",
        "updated_at": now,
    }
    _save_experiment_any(running)

    dataset_cache: dict[tuple[str, str], dict] = {}
    runs: list[dict] = []

    for plan in plans:
        run_started_at = datetime.utcnow().isoformat()
        try:
            dataset_info = dataset_cache.get((plan["symbol"], plan["interval"]))
            if dataset_info is None:
                dataset_info = load_from_db(
                    symbol=plan["symbol"],
                    interval=plan["interval"],
                    start_date=experiment.get("start_date"),
                    end_date=experiment.get("end_date"),
                )
                dataset_cache[(plan["symbol"], plan["interval"])] = dataset_info

            dataset = get_dataset(dataset_info["dataset_id"])
            if dataset is None:
                raise RuntimeError(f"Loaded dataset '{dataset_info['dataset_id']}' is no longer available.")

            request = BacktestRequest(
                dataset_id=dataset_info["dataset_id"],
                strategy=Strategy(type=experiment["strategy_type"], params=plan["strategy_params"]),
                prop_firm_rules=experiment["prop_firm_rules"],
                start_date=experiment.get("start_date"),
                end_date=experiment.get("end_date"),
                initial_balance=experiment["initial_balance"],
                position_size=experiment["position_size"],
                commission=experiment["commission"],
            )
            backtest = build_backtest_result(dataset, request)
            persist_backtest_result(backtest)

            runs.append({
                "experiment_run_id": str(uuid.uuid4()),
                "experiment_id": experiment["experiment_id"],
                "backtest_id": backtest["backtest_id"],
                "symbol": plan["symbol"],
                "interval": plan["interval"],
                "strategy_type": experiment["strategy_type"],
                "strategy_params": plan["strategy_params"],
                "dataset_id": dataset_info["dataset_id"],
                "status": "completed",
                "score": score_backtest(backtest, experiment["scoring_rule"]),
                "rank": None,
                "total_pnl": backtest["metrics"]["total_pnl"],
                "win_rate": backtest["metrics"]["win_rate"],
                "max_drawdown": backtest["metrics"]["max_drawdown"],
                "profit_factor": backtest["metrics"]["profit_factor"],
                "passed": backtest["prop_firm_eval"]["passed"],
                "error": None,
                "metrics": backtest["metrics"],
                "prop_firm_eval": backtest["prop_firm_eval"],
                "created_at": run_started_at,
                "updated_at": datetime.utcnow().isoformat(),
            })
        except Exception as exc:
            runs.append({
                "experiment_run_id": str(uuid.uuid4()),
                "experiment_id": experiment["experiment_id"],
                "backtest_id": None,
                "symbol": plan["symbol"],
                "interval": plan["interval"],
                "strategy_type": experiment["strategy_type"],
                "strategy_params": plan["strategy_params"],
                "dataset_id": None,
                "status": "failed",
                "score": None,
                "rank": None,
                "total_pnl": None,
                "win_rate": None,
                "max_drawdown": None,
                "profit_factor": None,
                "passed": None,
                "error": str(exc),
                "metrics": None,
                "prop_firm_eval": None,
                "created_at": run_started_at,
                "updated_at": datetime.utcnow().isoformat(),
            })

    ranked_runs = rank_experiment_runs(runs)
    completed_runs = sum(1 for run in ranked_runs if run["status"] == "completed")
    failed_runs = sum(1 for run in ranked_runs if run["status"] == "failed")
    best_run = next((run for run in ranked_runs if run["status"] == "completed"), None)
    completed_at = datetime.utcnow().isoformat()
    status = "completed" if completed_runs > 0 else "failed"

    updated_experiment = {
        **experiment,
        "status": status,
        "total_runs": len(ranked_runs),
        "completed_runs": completed_runs,
        "failed_runs": failed_runs,
        "best_run_id": best_run["experiment_run_id"] if best_run else None,
        "best_backtest_id": best_run.get("backtest_id") if best_run else None,
        "last_run_at": completed_at,
        "updated_at": completed_at,
    }

    replace_experiment_runs_mem(experiment["experiment_id"], ranked_runs)
    add_experiment(experiment["experiment_id"], updated_experiment)

    if _db_required():
        replace_experiment_runs_db(experiment["experiment_id"], ranked_runs)
        save_experiment(updated_experiment)

    return updated_experiment, ranked_runs


def expand_experiment_runs(experiment: dict) -> list[dict]:
    """Expand one experiment spec into concrete symbol/interval/param jobs."""
    symbols = _normalize_symbols(experiment.get("symbols") or [])
    intervals = _normalize_intervals(experiment.get("intervals") or [])
    parameter_sets = parameter_combinations(experiment.get("parameter_space") or {})
    run_count = len(symbols) * len(intervals) * len(parameter_sets)

    if run_count == 0:
        raise ValueError("Experiment needs at least one symbol, interval, and parameter set.")
    if run_count > MAX_EXPERIMENT_RUNS:
        raise ValueError(
            f"Experiment expands to {run_count} runs. Cap it under {MAX_EXPERIMENT_RUNS} so it stays usable."
        )

    plans = []
    for symbol, interval, params in product(symbols, intervals, parameter_sets):
        plans.append({
            "symbol": symbol,
            "interval": interval,
            "strategy_params": params,
        })
    return plans


def parameter_combinations(parameter_space: dict[str, list[Any]]) -> list[dict[str, Any]]:
    """Turn a parameter grid into concrete strategy param dicts.

    An empty grid is still valid and produces one default param set, which makes
    it easy to batch symbols/intervals around a strategy's baked-in defaults.
    """
    normalized = normalize_parameter_space(parameter_space)
    if not normalized:
        return [{}]

    keys = list(normalized.keys())
    values = [normalized[key] for key in keys]
    return [dict(zip(keys, combo)) for combo in product(*values)]


def normalize_parameter_space(parameter_space: dict[str, list[Any]]) -> dict[str, list[Any]]:
    if not isinstance(parameter_space, dict):
        raise ValueError("parameter_space must be an object of param -> value list.")

    normalized: dict[str, list[Any]] = {}
    for key, values in parameter_space.items():
        if not isinstance(key, str) or not key.strip():
            raise ValueError("parameter_space keys must be non-empty strings.")
        if not isinstance(values, list) or len(values) == 0:
            raise ValueError(f"parameter_space['{key}'] must be a non-empty list.")
        normalized[key.strip()] = values
    return normalized


def rank_experiment_runs(runs: list[dict]) -> list[dict]:
    completed = [run.copy() for run in runs if run["status"] == "completed"]
    failed = [run.copy() for run in runs if run["status"] == "failed"]

    completed.sort(
        key=lambda run: (
            run.get("score") is None,
            -(run.get("score") or float("-inf")),
            run.get("symbol", ""),
            run.get("interval", ""),
        )
    )
    for index, run in enumerate(completed, start=1):
        run["rank"] = index

    for run in failed:
        run["rank"] = None

    return completed + failed


def score_backtest(backtest: dict, scoring_rule: str) -> float:
    metrics = backtest["metrics"]
    prop_eval = backtest["prop_firm_eval"]

    if scoring_rule == "total_pnl":
        return float(metrics["total_pnl"])
    if scoring_rule == "sharpe_ratio":
        return float(metrics["sharpe_ratio"])
    if scoring_rule == "profit_factor":
        return float(metrics["profit_factor"])
    if scoring_rule != "prop_score_v1":
        raise ValueError(f"Unsupported scoring rule '{scoring_rule}'.")

    passed_bonus = 10_000 if prop_eval["passed"] else 0
    return round(
        passed_bonus
        + float(metrics["total_pnl"])
        + float(metrics["profit_factor"]) * 100
        + float(metrics["win_rate"]) * 100
        - float(metrics["max_drawdown"]) * 10_000,
        4,
    )


def list_experiment_runs(experiment_id: str) -> list[dict]:
    if _db_required():
        return list_experiment_runs_db(experiment_id)
    return list_experiment_runs_mem(experiment_id)


def get_experiment_any(experiment_id: str) -> dict | None:
    if _db_required():
        from services.experiment_repo import get_experiment as get_experiment_db

        return get_experiment_db(experiment_id)
    return get_experiment_mem(experiment_id)


def list_experiments_any() -> list[dict]:
    if _db_required():
        from services.experiment_repo import list_experiments as list_experiments_db

        return list_experiments_db()
    from services.experiment_store import list_experiments as list_experiments_mem

    return list_experiments_mem()


def _save_experiment_any(experiment: dict) -> None:
    add_experiment(experiment["experiment_id"], experiment)
    if _db_required():
        save_experiment(experiment)


def _normalize_symbols(symbols: list[str]) -> list[str]:
    normalized = []
    seen = set()
    for symbol in symbols:
        if not isinstance(symbol, str) or not symbol.strip():
            raise ValueError("symbols must contain non-empty strings.")
        value = symbol.strip().upper()
        if value not in seen:
            normalized.append(value)
            seen.add(value)
    if not normalized:
        raise ValueError("symbols must include at least one symbol.")
    return normalized


def _normalize_intervals(intervals: list[str]) -> list[str]:
    normalized = []
    seen = set()
    for interval in intervals:
        value = normalise_interval(interval)
        if value not in seen:
            normalized.append(value)
            seen.add(value)
    if not normalized:
        raise ValueError("intervals must include at least one interval.")
    return normalized


def _db_required() -> bool:
    from services.db import db_configured

    return db_configured()
