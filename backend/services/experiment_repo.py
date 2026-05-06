import json
from threading import Lock
from typing import Any, Optional

import pandas as pd

_schema_lock = Lock()
_schema_ready = False


def _ensure_experiments_schema(conn) -> None:
    """Create the experiment tables if they aren't there yet.

    I’m keeping this in-app like the rest of the project for now so local
    databases can pick up the new research tables without a migration detour.
    """
    global _schema_ready

    if _schema_ready:
        return

    with _schema_lock:
        if _schema_ready:
            return

        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS experiments (
                    experiment_id    TEXT PRIMARY KEY,
                    name             TEXT NOT NULL,
                    symbols          JSONB NOT NULL,
                    intervals        JSONB NOT NULL,
                    strategy_type    TEXT NOT NULL,
                    parameter_space  JSONB NOT NULL,
                    start_date       TEXT,
                    end_date         TEXT,
                    prop_firm_rules  JSONB NOT NULL,
                    initial_balance  DOUBLE PRECISION NOT NULL DEFAULT 100000,
                    position_size    DOUBLE PRECISION NOT NULL DEFAULT 1,
                    commission       DOUBLE PRECISION NOT NULL DEFAULT 5,
                    slippage_ticks   DOUBLE PRECISION NOT NULL DEFAULT 1,
                    execution_mode   TEXT NOT NULL DEFAULT 'bar',
                    spread_ticks     INTEGER NOT NULL DEFAULT 1,
                    volatile_bar_threshold_ticks INTEGER NOT NULL DEFAULT 0,
                    volatile_bar_extra_ticks     INTEGER NOT NULL DEFAULT 0,
                    scoring_rule     TEXT NOT NULL DEFAULT 'prop_score_v1',
                    status           TEXT NOT NULL DEFAULT 'draft',
                    total_runs       INTEGER NOT NULL DEFAULT 0,
                    completed_runs   INTEGER NOT NULL DEFAULT 0,
                    failed_runs      INTEGER NOT NULL DEFAULT 0,
                    best_run_id      TEXT,
                    best_backtest_id TEXT,
                    last_run_at      TIMESTAMPTZ,
                    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS experiment_runs (
                    experiment_run_id TEXT PRIMARY KEY,
                    experiment_id     TEXT NOT NULL,
                    candidate_id      TEXT,
                    backtest_id       TEXT,
                    symbol            TEXT NOT NULL,
                    interval          TEXT NOT NULL,
                    strategy_type     TEXT NOT NULL,
                    strategy_params   JSONB NOT NULL,
                    dataset_id        TEXT,
                    status            TEXT NOT NULL,
                    score             DOUBLE PRECISION,
                    rank              INTEGER,
                    total_pnl         DOUBLE PRECISION,
                    win_rate          DOUBLE PRECISION,
                    max_drawdown      DOUBLE PRECISION,
                    profit_factor     DOUBLE PRECISION,
                    passed            BOOLEAN,
                    error             TEXT,
                    metrics           JSONB,
                    prop_firm_eval    JSONB,
                    is_candidate      BOOLEAN NOT NULL DEFAULT FALSE,
                    promoted_at       TIMESTAMPTZ,
                    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            cur.execute(
                "ALTER TABLE experiments ADD COLUMN IF NOT EXISTS slippage_ticks DOUBLE PRECISION NOT NULL DEFAULT 1"
            )
            cur.execute(
                "ALTER TABLE experiments ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'bar'"
            )
            cur.execute(
                "ALTER TABLE experiments ADD COLUMN IF NOT EXISTS spread_ticks INTEGER NOT NULL DEFAULT 1"
            )
            cur.execute(
                "ALTER TABLE experiments ADD COLUMN IF NOT EXISTS volatile_bar_threshold_ticks INTEGER NOT NULL DEFAULT 0"
            )
            cur.execute(
                "ALTER TABLE experiments ADD COLUMN IF NOT EXISTS volatile_bar_extra_ticks INTEGER NOT NULL DEFAULT 0"
            )
            cur.execute(
                "ALTER TABLE experiment_runs ADD COLUMN IF NOT EXISTS candidate_id TEXT"
            )
            cur.execute(
                "ALTER TABLE experiment_runs ADD COLUMN IF NOT EXISTS is_candidate BOOLEAN NOT NULL DEFAULT FALSE"
            )
            cur.execute(
                "ALTER TABLE experiment_runs ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS experiments_updated_at_idx ON experiments (updated_at DESC)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS experiment_runs_experiment_id_idx ON experiment_runs (experiment_id)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS experiment_runs_score_idx ON experiment_runs (experiment_id, score DESC NULLS LAST)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS experiment_runs_candidate_id_idx ON experiment_runs (candidate_id)"
            )
        conn.commit()
        _schema_ready = True


def save_experiment(experiment: dict) -> None:
    from services.db import _conn

    sql = """
        INSERT INTO experiments (
            experiment_id, name, symbols, intervals, strategy_type, parameter_space,
            start_date, end_date, prop_firm_rules, initial_balance, position_size,
            commission, slippage_ticks, execution_mode, spread_ticks,
            volatile_bar_threshold_ticks, volatile_bar_extra_ticks, scoring_rule,
            status, total_runs, completed_runs, failed_runs,
            best_run_id, best_backtest_id, last_run_at, created_at, updated_at
        )
        VALUES (
            %s, %s, %s::jsonb, %s::jsonb, %s, %s::jsonb, %s, %s, %s::jsonb, %s, %s, %s,
            %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
        )
        ON CONFLICT (experiment_id) DO UPDATE SET
            name             = EXCLUDED.name,
            symbols          = EXCLUDED.symbols,
            intervals        = EXCLUDED.intervals,
            strategy_type    = EXCLUDED.strategy_type,
            parameter_space  = EXCLUDED.parameter_space,
            start_date       = EXCLUDED.start_date,
            end_date         = EXCLUDED.end_date,
            prop_firm_rules  = EXCLUDED.prop_firm_rules,
            initial_balance  = EXCLUDED.initial_balance,
            position_size    = EXCLUDED.position_size,
            commission       = EXCLUDED.commission,
            slippage_ticks   = EXCLUDED.slippage_ticks,
            execution_mode   = EXCLUDED.execution_mode,
            spread_ticks     = EXCLUDED.spread_ticks,
            volatile_bar_threshold_ticks = EXCLUDED.volatile_bar_threshold_ticks,
            volatile_bar_extra_ticks     = EXCLUDED.volatile_bar_extra_ticks,
            scoring_rule     = EXCLUDED.scoring_rule,
            status           = EXCLUDED.status,
            total_runs       = EXCLUDED.total_runs,
            completed_runs   = EXCLUDED.completed_runs,
            failed_runs      = EXCLUDED.failed_runs,
            best_run_id      = EXCLUDED.best_run_id,
            best_backtest_id = EXCLUDED.best_backtest_id,
            last_run_at      = EXCLUDED.last_run_at,
            updated_at       = EXCLUDED.updated_at
    """

    with _conn() as conn:
        _ensure_experiments_schema(conn)
        with conn.cursor() as cur:
            cur.execute(
                sql,
                [
                    experiment["experiment_id"],
                    experiment["name"],
                    json.dumps(experiment["symbols"]),
                    json.dumps(experiment["intervals"]),
                    experiment["strategy_type"],
                    json.dumps(experiment["parameter_space"]),
                    experiment.get("start_date"),
                    experiment.get("end_date"),
                    json.dumps(experiment["prop_firm_rules"]),
                    experiment["initial_balance"],
                    experiment["position_size"],
                    experiment["commission"],
                    experiment.get("slippage_ticks", 1.0),
                    experiment.get("execution_mode", "bar"),
                    experiment.get("spread_ticks", 1),
                    experiment.get("volatile_bar_threshold_ticks", 0),
                    experiment.get("volatile_bar_extra_ticks", 0),
                    experiment["scoring_rule"],
                    experiment["status"],
                    experiment.get("total_runs", 0),
                    experiment.get("completed_runs", 0),
                    experiment.get("failed_runs", 0),
                    experiment.get("best_run_id"),
                    experiment.get("best_backtest_id"),
                    experiment.get("last_run_at"),
                    experiment["created_at"],
                    experiment["updated_at"],
                ],
            )
        conn.commit()


def get_experiment(experiment_id: str) -> Optional[dict]:
    from services.db import _conn, _read_sql

    sql = "SELECT * FROM experiments WHERE experiment_id = %s"
    with _conn() as conn:
        _ensure_experiments_schema(conn)
    df = _read_sql(sql, params=[experiment_id], parse_dates=["created_at", "updated_at", "last_run_at"])

    if df.empty:
        return None

    return _row_to_experiment(df.iloc[0])


def list_experiments() -> list[dict]:
    from services.db import _conn, _read_sql

    sql = "SELECT * FROM experiments ORDER BY updated_at DESC"
    with _conn() as conn:
        _ensure_experiments_schema(conn)
    df = _read_sql(sql, parse_dates=["created_at", "updated_at", "last_run_at"])

    return [_row_to_experiment(row) for _, row in df.iterrows()]


def replace_experiment_runs(experiment_id: str, runs: list[dict]) -> None:
    from services.db import _conn

    delete_sql = "DELETE FROM experiment_runs WHERE experiment_id = %s"
    insert_sql = """
        INSERT INTO experiment_runs (
            experiment_run_id, experiment_id, candidate_id, backtest_id, symbol, interval,
            strategy_type, strategy_params, dataset_id, status, score, rank,
            total_pnl, win_rate, max_drawdown, profit_factor, passed, error,
            metrics, prop_firm_eval, is_candidate, promoted_at, created_at, updated_at
        )
        VALUES (
            %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s, %s, %s, %s, %s,
            %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s, %s
        )
    """

    with _conn() as conn:
        _ensure_experiments_schema(conn)
        with conn.cursor() as cur:
            cur.execute(delete_sql, [experiment_id])
            for run in runs:
                cur.execute(
                    insert_sql,
                    [
                        run["experiment_run_id"],
                        run["experiment_id"],
                        run.get("candidate_id"),
                        run.get("backtest_id"),
                        run["symbol"],
                        run["interval"],
                        run["strategy_type"],
                        json.dumps(run.get("strategy_params") or {}),
                        run.get("dataset_id"),
                        run["status"],
                        run.get("score"),
                        run.get("rank"),
                        run.get("total_pnl"),
                        run.get("win_rate"),
                        run.get("max_drawdown"),
                        run.get("profit_factor"),
                        run.get("passed"),
                        run.get("error"),
                        json.dumps(run.get("metrics")),
                        json.dumps(run.get("prop_firm_eval")),
                        run.get("is_candidate", False),
                        run.get("promoted_at"),
                        run["created_at"],
                        run["updated_at"],
                    ],
                )
        conn.commit()


def list_experiment_runs(experiment_id: str) -> list[dict]:
    from services.db import _conn, _read_sql

    sql = """
        SELECT *
        FROM experiment_runs
        WHERE experiment_id = %s
        ORDER BY rank NULLS LAST, score DESC NULLS LAST, created_at
    """
    with _conn() as conn:
        _ensure_experiments_schema(conn)
    df = _read_sql(sql, params=[experiment_id], parse_dates=["created_at", "updated_at"])

    return [_row_to_run(row) for _, row in df.iterrows()]


def _row_to_experiment(row) -> dict:
    return {
        "experiment_id": row["experiment_id"],
        "name": row["name"],
        "symbols": _maybe_json(row["symbols"]),
        "intervals": _maybe_json(row["intervals"]),
        "strategy_type": row["strategy_type"],
        "parameter_space": _maybe_json(row["parameter_space"]),
        "start_date": row["start_date"],
        "end_date": row["end_date"],
        "prop_firm_rules": _maybe_json(row["prop_firm_rules"]),
        "initial_balance": float(row["initial_balance"]),
        "position_size": float(row["position_size"]),
        "commission": float(row["commission"]),
        "slippage_ticks": float(row.get("slippage_ticks") or 1.0) if hasattr(row, "get") else float(row["slippage_ticks"]),
        "execution_mode": str(row.get("execution_mode") or "bar") if hasattr(row, "get") else str(row["execution_mode"]),
        "spread_ticks": int(row.get("spread_ticks") or 1) if hasattr(row, "get") else int(row["spread_ticks"]),
        "volatile_bar_threshold_ticks": int(row.get("volatile_bar_threshold_ticks") or 0) if hasattr(row, "get") else int(row["volatile_bar_threshold_ticks"]),
        "volatile_bar_extra_ticks": int(row.get("volatile_bar_extra_ticks") or 0) if hasattr(row, "get") else int(row["volatile_bar_extra_ticks"]),
        "scoring_rule": row["scoring_rule"],
        "status": row["status"],
        "total_runs": int(row["total_runs"]),
        "completed_runs": int(row["completed_runs"]),
        "failed_runs": int(row["failed_runs"]),
        "best_run_id": row["best_run_id"],
        "best_backtest_id": row["best_backtest_id"],
        "last_run_at": _maybe_iso(row.get("last_run_at") if hasattr(row, "get") else row["last_run_at"]),
        "created_at": _maybe_iso(row["created_at"]),
        "updated_at": _maybe_iso(row["updated_at"]),
    }


def _row_to_run(row) -> dict:
    return {
        "experiment_run_id": row["experiment_run_id"],
        "experiment_id": row["experiment_id"],
        "candidate_id": row.get("candidate_id") if hasattr(row, "get") else row["candidate_id"],
        "backtest_id": row["backtest_id"],
        "symbol": row["symbol"],
        "interval": row["interval"],
        "strategy_type": row["strategy_type"],
        "strategy_params": _maybe_json(row["strategy_params"]),
        "dataset_id": row["dataset_id"],
        "status": row["status"],
        "score": _maybe_float(row["score"]),
        "rank": _maybe_int(row["rank"]),
        "total_pnl": _maybe_float(row["total_pnl"]),
        "win_rate": _maybe_float(row["win_rate"]),
        "max_drawdown": _maybe_float(row["max_drawdown"]),
        "profit_factor": _maybe_float(row["profit_factor"]),
        "passed": row["passed"],
        "error": row["error"],
        "metrics": _maybe_json(row["metrics"]),
        "prop_firm_eval": _maybe_json(row["prop_firm_eval"]),
        "is_candidate": bool(row["is_candidate"]),
        "promoted_at": _maybe_iso(row.get("promoted_at") if hasattr(row, "get") else row["promoted_at"]),
        "created_at": _maybe_iso(row["created_at"]),
        "updated_at": _maybe_iso(row["updated_at"]),
    }


def _maybe_json(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def _maybe_iso(value: Any) -> str | None:
    if value is None or pd.isna(value):
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _maybe_float(value: Any) -> float | None:
    if value is None:
        return None
    return float(value)


def _maybe_int(value: Any) -> int | None:
    if value is None:
        return None
    return int(value)
