import uuid
from datetime import datetime
from itertools import product
from typing import Any

import numpy as np

from schemas import (
    BacktestRequest,
    ExperimentCreate,
    ExperimentResult,
    Strategy,
)
from services.backtest_engine import run_backtest_batch
from services.backtest_service import (
    complete_backtest_result,
    persist_backtest_result,
    prepare_backtest_frame,
)
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
        slippage_ticks=request.slippage_ticks,
        execution_mode=request.execution_mode,
        spread_ticks=request.spread_ticks,
        volatile_bar_threshold_ticks=request.volatile_bar_threshold_ticks,
        volatile_bar_extra_ticks=request.volatile_bar_extra_ticks,
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

    # Phase 1: prepare every plan's frame and signals in Python. This is
    # where indicators and signal generation happen, so failures here stay
    # scoped to the one plan that caused them.
    dataset_cache: dict[tuple[str, str], dict] = {}
    entries: list[dict] = []

    for plan in plans:
        run_started_at = datetime.utcnow().isoformat()
        entry: dict[str, Any] = {"plan": plan, "created_at": run_started_at, "error": None}
        entries.append(entry)
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
                slippage_ticks=experiment.get("slippage_ticks") or 1.0,
                tick_size=dataset_info.get("tick_size") or 0.25,
                tick_value=dataset_info.get("tick_value") or 12.5,
                execution_mode=str(experiment.get("execution_mode") or "bar"),
                spread_ticks=max(1, int(experiment.get("spread_ticks") or 1)),
                volatile_bar_threshold_ticks=max(0, int(experiment.get("volatile_bar_threshold_ticks") or 0)),
                volatile_bar_extra_ticks=max(0, int(experiment.get("volatile_bar_extra_ticks") or 0)),
            )
            frame = prepare_backtest_frame(dataset, request)
            entry.update({
                "dataset_info": dataset_info,
                "dataset": dataset,
                "request": request,
                "signals": frame["signal"].to_numpy(dtype=np.int32),
                "frame": frame,
            })
        except Exception as exc:
            entry["error"] = str(exc)

    # Phase 2: hand each dataset group to the batch engine in one call.
    # Plans in a group share the same OHLC window, so the C++ pool reads one
    # set of price arrays across every core instead of copying per run. Only
    # one representative frame per group survives — the rest just needed to
    # give up their signal column.
    groups: dict[str, dict] = {}
    for entry in entries:
        if entry["error"] is not None:
            continue
        group = groups.setdefault(
            entry["dataset_info"]["dataset_id"],
            {"frame": entry["frame"], "entries": []},
        )
        group["entries"].append(entry)
        entry["frame"] = None

    for group in groups.values():
        group_entries = group["entries"]
        request = group_entries[0]["request"]
        try:
            engine_results = run_backtest_batch(
                group["frame"],
                [group_entry["signals"] for group_entry in group_entries],
                initial_balance=request.initial_balance,
                position_size=request.position_size,
                commission=request.commission,
                tick_size=request.tick_size,
                tick_value=request.tick_value,
                slippage_ticks=request.slippage_ticks,
                stop_loss_ticks=request.stop_loss_ticks,
                take_profit_ticks=request.take_profit_ticks,
                execution_mode=request.execution_mode,
                spread_ticks=request.spread_ticks,
                volatile_bar_threshold_ticks=request.volatile_bar_threshold_ticks,
                volatile_bar_extra_ticks=request.volatile_bar_extra_ticks,
            )
            for group_entry, engine_result in zip(group_entries, engine_results):
                group_entry["engine_result"] = engine_result
        except Exception as exc:
            for group_entry in group_entries:
                group_entry["error"] = str(exc)

    # Phase 3: metrics, prop eval, and persistence per plan, in plan order.
    runs: list[dict] = []
    for entry in entries:
        if entry["error"] is None:
            try:
                group = groups[entry["dataset_info"]["dataset_id"]]
                backtest = complete_backtest_result(
                    group["frame"],
                    entry["engine_result"],
                    entry["dataset"],
                    entry["request"],
                )
                persist_backtest_result(backtest)
                runs.append(_completed_run_entry(experiment, entry, backtest))
                continue
            except Exception as exc:
                entry["error"] = str(exc)
        runs.append(_failed_run_entry(experiment, entry))

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


def _completed_run_entry(experiment: dict, entry: dict, backtest: dict) -> dict:
    plan = entry["plan"]
    return {
        "experiment_run_id": str(uuid.uuid4()),
        "experiment_id": experiment["experiment_id"],
        "candidate_id": None,
        "backtest_id": backtest["backtest_id"],
        "symbol": plan["symbol"],
        "interval": plan["interval"],
        "strategy_type": experiment["strategy_type"],
        "strategy_params": plan["strategy_params"],
        "dataset_id": entry["dataset_info"]["dataset_id"],
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
        "is_candidate": False,
        "promoted_at": None,
        "created_at": entry["created_at"],
        "updated_at": datetime.utcnow().isoformat(),
    }


def _failed_run_entry(experiment: dict, entry: dict) -> dict:
    plan = entry["plan"]
    return {
        "experiment_run_id": str(uuid.uuid4()),
        "experiment_id": experiment["experiment_id"],
        "candidate_id": None,
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
        "error": entry["error"],
        "metrics": None,
        "prop_firm_eval": None,
        "is_candidate": False,
        "promoted_at": None,
        "created_at": entry["created_at"],
        "updated_at": datetime.utcnow().isoformat(),
    }


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


def get_experiment_run(experiment_id: str, experiment_run_id: str) -> dict | None:
    runs = list_experiment_runs(experiment_id)
    return next(
        (run.copy() for run in runs if run["experiment_run_id"] == experiment_run_id),
        None,
    )


def update_experiment_run_candidate_state(
    experiment_id: str,
    experiment_run_id: str,
    *,
    candidate_id: str | None,
    is_candidate: bool,
    promoted_at: str | None,
    strict: bool = True,
) -> dict | None:
    """Mirror candidate state back onto the saved experiment result row.

    The candidate record is the real Phase 2 source of truth, but keeping a
    light pointer on the experiment run makes the ranking table much easier to
    scan without forcing every page to do extra joins.
    """
    experiment = get_experiment_any(experiment_id)
    if experiment is None:
        raise LookupError(f"Experiment '{experiment_id}' not found.")

    runs = list_experiment_runs(experiment_id)
    if not runs:
        raise ValueError("This experiment does not have saved runs yet.")

    now = datetime.utcnow().isoformat()
    updated_run = None
    next_runs: list[dict] = []

    for run in runs:
        next_run = run.copy()
        if next_run["experiment_run_id"] == experiment_run_id:
            if next_run["status"] != "completed" or not next_run.get("backtest_id"):
                raise ValueError("Only completed runs with saved backtests can become candidates.")
            next_run["candidate_id"] = candidate_id
            next_run["is_candidate"] = is_candidate
            next_run["promoted_at"] = promoted_at if is_candidate else None
            next_run["updated_at"] = now
            updated_run = next_run
        next_runs.append(next_run)

    if updated_run is None:
        if not strict:
            return None
        raise LookupError(
            f"Experiment run '{experiment_run_id}' was not found in experiment '{experiment_id}'."
        )

    replace_experiment_runs_mem(experiment_id, next_runs)
    updated_experiment = {
        **experiment,
        "updated_at": now,
    }
    add_experiment(experiment_id, updated_experiment)

    if _db_required():
        replace_experiment_runs_db(experiment_id, next_runs)
        save_experiment(updated_experiment)

    return updated_run


def set_experiment_run_candidate(
    experiment_id: str,
    experiment_run_id: str,
    is_candidate: bool,
) -> dict | None:
    return update_experiment_run_candidate_state(
        experiment_id,
        experiment_run_id,
        candidate_id=None,
        is_candidate=is_candidate,
        promoted_at=datetime.utcnow().isoformat() if is_candidate else None,
    )


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
