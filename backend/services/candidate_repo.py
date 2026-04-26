import json
from threading import Lock
from typing import Any, Optional

import pandas as pd

_schema_lock = Lock()
_schema_ready = False


def _ensure_candidates_schema(conn) -> None:
    """Create the durable candidate tables without a formal migration layer.

    Phase 2 needs a real handoff record that survives experiment reruns, so I
    keep this bootstrap logic close to the repo for now like the rest of the
    app's local-schema helpers.
    """
    global _schema_ready

    if _schema_ready:
        return

    with _schema_lock:
        if _schema_ready:
            return

        from services.experiment_repo import _ensure_experiments_schema

        _ensure_experiments_schema(conn)

        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS candidates (
                    candidate_id        TEXT PRIMARY KEY,
                    experiment_id       TEXT NOT NULL,
                    experiment_name     TEXT NOT NULL,
                    experiment_run_id   TEXT NOT NULL UNIQUE,
                    backtest_id         TEXT NOT NULL,
                    symbol              TEXT NOT NULL,
                    interval            TEXT NOT NULL,
                    strategy_type       TEXT NOT NULL,
                    strategy_params     JSONB NOT NULL,
                    prop_firm_rules     JSONB NOT NULL,
                    experiment_snapshot JSONB NOT NULL,
                    score               DOUBLE PRECISION,
                    rank                INTEGER,
                    total_pnl           DOUBLE PRECISION,
                    win_rate            DOUBLE PRECISION,
                    max_drawdown        DOUBLE PRECISION,
                    profit_factor       DOUBLE PRECISION,
                    passed              BOOLEAN,
                    metrics             JSONB,
                    prop_firm_eval      JSONB,
                    lifecycle_status    TEXT NOT NULL DEFAULT 'candidate',
                    promotion_reason    TEXT NOT NULL,
                    promoted_by         TEXT NOT NULL DEFAULT 'local-user',
                    promoted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    approved_by         TEXT,
                    approved_at         TIMESTAMPTZ,
                    paper_bot           JSONB,
                    notes               JSONB NOT NULL DEFAULT '[]'::jsonb,
                    audit_log           JSONB NOT NULL DEFAULT '[]'::jsonb,
                    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            cur.execute(
                "ALTER TABLE experiment_runs ADD COLUMN IF NOT EXISTS candidate_id TEXT"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS candidates_updated_at_idx ON candidates (updated_at DESC)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS candidates_status_idx ON candidates (lifecycle_status)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS candidates_experiment_id_idx ON candidates (experiment_id)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS candidates_backtest_id_idx ON candidates (backtest_id)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS experiment_runs_candidate_id_idx ON experiment_runs (candidate_id)"
            )
        conn.commit()
        _schema_ready = True


def save_candidate(candidate: dict) -> None:
    from services.db import _conn

    sql = """
        INSERT INTO candidates (
            candidate_id, experiment_id, experiment_name, experiment_run_id, backtest_id,
            symbol, interval, strategy_type, strategy_params, prop_firm_rules,
            experiment_snapshot, score, rank, total_pnl, win_rate, max_drawdown,
            profit_factor, passed, metrics, prop_firm_eval, lifecycle_status,
            promotion_reason, promoted_by, promoted_at, approved_by, approved_at,
            paper_bot, notes, audit_log, created_at, updated_at
        )
        VALUES (
            %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s, %s,
            %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s, %s, %s, %s,
            %s::jsonb, %s::jsonb, %s::jsonb, %s, %s
        )
        ON CONFLICT (candidate_id) DO UPDATE SET
            experiment_id       = EXCLUDED.experiment_id,
            experiment_name     = EXCLUDED.experiment_name,
            experiment_run_id   = EXCLUDED.experiment_run_id,
            backtest_id         = EXCLUDED.backtest_id,
            symbol              = EXCLUDED.symbol,
            interval            = EXCLUDED.interval,
            strategy_type       = EXCLUDED.strategy_type,
            strategy_params     = EXCLUDED.strategy_params,
            prop_firm_rules     = EXCLUDED.prop_firm_rules,
            experiment_snapshot = EXCLUDED.experiment_snapshot,
            score               = EXCLUDED.score,
            rank                = EXCLUDED.rank,
            total_pnl           = EXCLUDED.total_pnl,
            win_rate            = EXCLUDED.win_rate,
            max_drawdown        = EXCLUDED.max_drawdown,
            profit_factor       = EXCLUDED.profit_factor,
            passed              = EXCLUDED.passed,
            metrics             = EXCLUDED.metrics,
            prop_firm_eval      = EXCLUDED.prop_firm_eval,
            lifecycle_status    = EXCLUDED.lifecycle_status,
            promotion_reason    = EXCLUDED.promotion_reason,
            promoted_by         = EXCLUDED.promoted_by,
            promoted_at         = EXCLUDED.promoted_at,
            approved_by         = EXCLUDED.approved_by,
            approved_at         = EXCLUDED.approved_at,
            paper_bot           = EXCLUDED.paper_bot,
            notes               = EXCLUDED.notes,
            audit_log           = EXCLUDED.audit_log,
            updated_at          = EXCLUDED.updated_at
    """

    with _conn() as conn:
        _ensure_candidates_schema(conn)
        with conn.cursor() as cur:
            cur.execute(
                sql,
                [
                    candidate["candidate_id"],
                    candidate["experiment_id"],
                    candidate["experiment_name"],
                    candidate["experiment_run_id"],
                    candidate["backtest_id"],
                    candidate["symbol"],
                    candidate["interval"],
                    candidate["strategy_type"],
                    json.dumps(candidate.get("strategy_params") or {}),
                    json.dumps(candidate.get("prop_firm_rules") or {}),
                    json.dumps(candidate.get("experiment_snapshot") or {}),
                    candidate.get("score"),
                    candidate.get("rank"),
                    candidate.get("total_pnl"),
                    candidate.get("win_rate"),
                    candidate.get("max_drawdown"),
                    candidate.get("profit_factor"),
                    candidate.get("passed"),
                    json.dumps(candidate.get("metrics")),
                    json.dumps(candidate.get("prop_firm_eval")),
                    candidate["lifecycle_status"],
                    candidate["promotion_reason"],
                    candidate.get("promoted_by", "local-user"),
                    candidate["promoted_at"],
                    candidate.get("approved_by"),
                    candidate.get("approved_at"),
                    json.dumps(candidate.get("paper_bot")),
                    json.dumps(candidate.get("notes") or []),
                    json.dumps(candidate.get("audit_log") or []),
                    candidate["created_at"],
                    candidate["updated_at"],
                ],
            )
        conn.commit()


def get_candidate(candidate_id: str) -> Optional[dict]:
    from services.db import _conn, _read_sql

    sql = "SELECT * FROM candidates WHERE candidate_id = %s"
    with _conn() as conn:
        _ensure_candidates_schema(conn)
    df = _read_sql(sql, params=[candidate_id], parse_dates=["promoted_at", "approved_at", "created_at", "updated_at"])

    if df.empty:
        return None

    return _row_to_candidate(df.iloc[0])


def get_candidate_by_run(experiment_run_id: str) -> Optional[dict]:
    from services.db import _conn, _read_sql

    sql = "SELECT * FROM candidates WHERE experiment_run_id = %s"
    with _conn() as conn:
        _ensure_candidates_schema(conn)
    df = _read_sql(sql, params=[experiment_run_id], parse_dates=["promoted_at", "approved_at", "created_at", "updated_at"])

    if df.empty:
        return None

    return _row_to_candidate(df.iloc[0])


def list_candidates() -> list[dict]:
    from services.db import _conn, _read_sql

    sql = "SELECT * FROM candidates ORDER BY updated_at DESC, promoted_at DESC"
    with _conn() as conn:
        _ensure_candidates_schema(conn)
    df = _read_sql(sql, parse_dates=["promoted_at", "approved_at", "created_at", "updated_at"])

    return [_row_to_candidate(row) for _, row in df.iterrows()]


def _row_to_candidate(row) -> dict:
    return {
        "candidate_id": row["candidate_id"],
        "experiment_id": row["experiment_id"],
        "experiment_name": row["experiment_name"],
        "experiment_run_id": row["experiment_run_id"],
        "backtest_id": row["backtest_id"],
        "symbol": row["symbol"],
        "interval": row["interval"],
        "strategy_type": row["strategy_type"],
        "strategy_params": _maybe_json(row["strategy_params"]),
        "prop_firm_rules": _maybe_json(row["prop_firm_rules"]),
        "experiment_snapshot": _maybe_json(row["experiment_snapshot"]),
        "score": _maybe_float(row["score"]),
        "rank": _maybe_int(row["rank"]),
        "total_pnl": _maybe_float(row["total_pnl"]),
        "win_rate": _maybe_float(row["win_rate"]),
        "max_drawdown": _maybe_float(row["max_drawdown"]),
        "profit_factor": _maybe_float(row["profit_factor"]),
        "passed": row["passed"],
        "metrics": _maybe_json(row["metrics"]),
        "prop_firm_eval": _maybe_json(row["prop_firm_eval"]),
        "lifecycle_status": row["lifecycle_status"],
        "promotion_reason": row["promotion_reason"],
        "promoted_by": row["promoted_by"],
        "promoted_at": _maybe_iso(row["promoted_at"]),
        "approved_by": row["approved_by"],
        "approved_at": _maybe_iso(row["approved_at"]),
        "paper_bot": _maybe_json(row["paper_bot"]),
        "notes": _maybe_json(row["notes"]) or [],
        "audit_log": _maybe_json(row["audit_log"]) or [],
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
