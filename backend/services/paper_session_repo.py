import json
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from threading import Lock
from typing import Any, Optional

import pandas as pd

_schema_lock = Lock()
_schema_ready = False


class PaperSessionWriteConflict(RuntimeError):
    """A session changed after the snapshot being saved was read."""


class RunnerLeaseLost(RuntimeError):
    """A worker may no longer commit its tentative bar."""


@dataclass
class _RunnerWriteGuard:
    paper_session_id: str
    starting_version: int
    expected_version: int


_runner_write_guard: ContextVar[_RunnerWriteGuard | None] = ContextVar(
    "paper_runner_write_guard", default=None
)


def _ensure_paper_sessions_schema(conn) -> None:
    """Bootstrap the paper session tables close to the repo code for now.

    This is still early-phase product plumbing, so I keep the schema helper
    beside the save/load code like the rest of the app instead of pretending
    we already have a full migration story.
    """
    global _schema_ready

    if _schema_ready:
        return

    with _schema_lock:
        if _schema_ready:
            return

        from services.candidate_repo import _ensure_candidates_schema

        _ensure_candidates_schema(conn)

        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS paper_sessions (
                    paper_session_id TEXT PRIMARY KEY,
                    candidate_id     TEXT NOT NULL UNIQUE,
                    paper_bot_id     TEXT,
                    name             TEXT NOT NULL,
                    symbol           TEXT NOT NULL,
                    interval         TEXT NOT NULL,
                    strategy_type    TEXT NOT NULL,
                    strategy_params  JSONB NOT NULL,
                    prop_firm_rules  JSONB NOT NULL,
                    guardrails       JSONB NOT NULL DEFAULT '{}'::jsonb,
                    status           TEXT NOT NULL DEFAULT 'draft',
                    state_version    BIGINT NOT NULL DEFAULT 0,
                    commission       DOUBLE PRECISION NOT NULL DEFAULT 5,
                    tick_value       DOUBLE PRECISION NOT NULL DEFAULT 1,
                    tick_size        DOUBLE PRECISION NOT NULL DEFAULT 0.25,
                    spread_ticks     INTEGER NOT NULL DEFAULT 1,
                    volatile_bar_threshold_ticks INTEGER NOT NULL DEFAULT 0,
                    volatile_bar_extra_ticks     INTEGER NOT NULL DEFAULT 0,
                    resting_fill_mode TEXT NOT NULL DEFAULT 'touch',
                    current_position JSONB NOT NULL DEFAULT '{}'::jsonb,
                    active_order     JSONB NOT NULL DEFAULT '{}'::jsonb,
                    active_orders    JSONB NOT NULL DEFAULT '[]'::jsonb,
                    last_quote       JSONB NOT NULL DEFAULT '{}'::jsonb,
                    trade_log        JSONB NOT NULL DEFAULT '[]'::jsonb,
                    equity_curve     JSONB NOT NULL DEFAULT '[]'::jsonb,
                    metrics_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
                    guardrail_state  JSONB NOT NULL DEFAULT '{}'::jsonb,
                    runner_state     JSONB NOT NULL DEFAULT '{}'::jsonb,
                    last_bar_time    TIMESTAMPTZ,
                    last_event_at    TIMESTAMPTZ,
                    created_by       TEXT NOT NULL DEFAULT 'local-user',
                    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            cur.execute(
                "ALTER TABLE paper_sessions ADD COLUMN IF NOT EXISTS state_version BIGINT NOT NULL DEFAULT 0"
            )
            cur.execute(
                "ALTER TABLE paper_sessions ADD COLUMN IF NOT EXISTS commission DOUBLE PRECISION NOT NULL DEFAULT 5"
            )
            cur.execute(
                "ALTER TABLE paper_sessions ADD COLUMN IF NOT EXISTS tick_value DOUBLE PRECISION NOT NULL DEFAULT 1"
            )
            cur.execute(
                "ALTER TABLE paper_sessions ADD COLUMN IF NOT EXISTS tick_size DOUBLE PRECISION NOT NULL DEFAULT 0.25"
            )
            cur.execute(
                "ALTER TABLE paper_sessions ADD COLUMN IF NOT EXISTS spread_ticks INTEGER NOT NULL DEFAULT 1"
            )
            cur.execute(
                "ALTER TABLE paper_sessions ADD COLUMN IF NOT EXISTS volatile_bar_threshold_ticks INTEGER NOT NULL DEFAULT 0"
            )
            cur.execute(
                "ALTER TABLE paper_sessions ADD COLUMN IF NOT EXISTS volatile_bar_extra_ticks INTEGER NOT NULL DEFAULT 0"
            )
            cur.execute(
                "ALTER TABLE paper_sessions ADD COLUMN IF NOT EXISTS resting_fill_mode TEXT NOT NULL DEFAULT 'touch'"
            )
            cur.execute(
                "ALTER TABLE paper_sessions ADD COLUMN IF NOT EXISTS active_order JSONB NOT NULL DEFAULT '{}'::jsonb"
            )
            cur.execute(
                "ALTER TABLE paper_sessions ADD COLUMN IF NOT EXISTS active_orders JSONB NOT NULL DEFAULT '[]'::jsonb"
            )
            cur.execute(
                "ALTER TABLE paper_sessions ADD COLUMN IF NOT EXISTS last_quote JSONB NOT NULL DEFAULT '{}'::jsonb"
            )
            cur.execute(
                "ALTER TABLE paper_sessions ADD COLUMN IF NOT EXISTS trade_log JSONB NOT NULL DEFAULT '[]'::jsonb"
            )
            cur.execute(
                "ALTER TABLE paper_sessions ADD COLUMN IF NOT EXISTS equity_curve JSONB NOT NULL DEFAULT '[]'::jsonb"
            )
            cur.execute(
                "ALTER TABLE paper_sessions ADD COLUMN IF NOT EXISTS runner_state JSONB NOT NULL DEFAULT '{}'::jsonb"
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS paper_events (
                    paper_event_id   TEXT PRIMARY KEY,
                    paper_session_id TEXT NOT NULL,
                    candidate_id     TEXT NOT NULL,
                    event_type       TEXT NOT NULL,
                    actor            TEXT NOT NULL DEFAULT 'local-user',
                    summary          TEXT NOT NULL,
                    payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
                    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS paper_runner_leases (
                    paper_session_id TEXT PRIMARY KEY,
                    owner_id          TEXT NOT NULL,
                    lease_token       TEXT NOT NULL UNIQUE,
                    acquired_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    heartbeat_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    expires_at        TIMESTAMPTZ NOT NULL
                )
                """
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS paper_sessions_updated_at_idx ON paper_sessions (updated_at DESC)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS paper_sessions_status_idx ON paper_sessions (status)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS paper_events_session_created_idx ON paper_events (paper_session_id, created_at DESC)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS paper_events_candidate_created_idx ON paper_events (candidate_id, created_at DESC)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS paper_runner_leases_expires_idx ON paper_runner_leases (expires_at)"
            )
        conn.commit()
        _schema_ready = True


@contextmanager
def locked_paper_session_transaction(paper_session_id: str):
    """Serialize session controls and decision resolution across API processes."""
    from services.db import _conn, transaction

    with _conn() as conn:
        _ensure_paper_sessions_schema(conn)
    with transaction() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT paper_session_id FROM paper_sessions WHERE paper_session_id = %s FOR UPDATE",
                [paper_session_id],
            )
            if cur.fetchone() is None:
                raise LookupError(f"Paper session '{paper_session_id}' not found.")
        yield


@contextmanager
def guarded_runner_transaction(
    paper_session_id: str,
    *,
    owner_id: str,
    lease_token: str,
    expected_version: int | None = None,
):
    """Fence every write in one worker bar at its final database commit.

    Session saves compare versions and retain their row lock until commit.
    The final lease row lock serializes revocation/takeover with publication;
    clock_timestamp() checks actual expiry, not transaction-start time.
    """
    from services.backtest_repo import _ensure_backtests_schema
    from services.db import _conn, transaction

    with _conn() as conn:
        _ensure_paper_sessions_schema(conn)
        # End-of-window parity may read a backtest inside the transaction.
        _ensure_backtests_schema(conn)

    with transaction() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT state_version FROM paper_sessions WHERE paper_session_id = %s",
                [paper_session_id],
            )
            row = cur.fetchone()
        if row is None:
            raise LookupError(f"Paper session '{paper_session_id}' not found.")
        version = int(row[0])
        if expected_version is not None and version != expected_version:
            raise PaperSessionWriteConflict(
                "Paper session changed before the worker could commit. Retry with current state."
            )
        guard = _RunnerWriteGuard(paper_session_id, version, version)
        token = _runner_write_guard.set(guard)
        try:
            yield guard
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT state_version FROM paper_sessions WHERE paper_session_id = %s FOR UPDATE",
                    [paper_session_id],
                )
                row = cur.fetchone()
                if row is None or int(row[0]) != guard.expected_version:
                    raise PaperSessionWriteConflict(
                        "Paper session changed before the worker could commit. Retry with current state."
                    )
                cur.execute(
                    "SELECT lease_token FROM paper_runner_leases WHERE paper_session_id = %s FOR UPDATE",
                    [paper_session_id],
                )
                cur.fetchone()
                cur.execute(
                    """SELECT 1 FROM paper_runner_leases
                    WHERE paper_session_id = %s AND owner_id = %s
                      AND lease_token = %s AND expires_at > clock_timestamp()""",
                    [paper_session_id, owner_id, lease_token],
                )
                if cur.fetchone() is None:
                    raise RunnerLeaseLost("The paper runner lease expired or changed before commit.")
        finally:
            _runner_write_guard.reset(token)


def save_paper_session(session: dict) -> None:
    from services.db import _conn

    expected_version = session.get("_state_version")
    guard = _runner_write_guard.get()
    if guard is not None:
        if session["paper_session_id"] != guard.paper_session_id:
            raise PaperSessionWriteConflict("A worker cannot write another paper session.")
        # A helper rereading newer state must not silently adopt a concurrent
        # pause/kill-switch version and continue the old worker operation.
        if expected_version != guard.expected_version:
            raise PaperSessionWriteConflict(
                "Paper session changed during worker advancement. Retry with current state."
            )

    sql = """
        INSERT INTO paper_sessions (
            paper_session_id, candidate_id, paper_bot_id, name, symbol, interval,
            strategy_type, strategy_params, prop_firm_rules, guardrails, status,
            commission, tick_value, tick_size, spread_ticks,
            volatile_bar_threshold_ticks, volatile_bar_extra_ticks, resting_fill_mode,
            current_position, active_order, last_quote, trade_log, equity_curve,
            active_orders, metrics_snapshot, guardrail_state, runner_state, last_bar_time,
            last_event_at, created_by, created_at, updated_at
        )
        VALUES (
            %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s,
            %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb,
            %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s, %s, %s, %s, %s
        )
        ON CONFLICT (paper_session_id) DO UPDATE SET
            candidate_id     = EXCLUDED.candidate_id,
            paper_bot_id     = EXCLUDED.paper_bot_id,
            name             = EXCLUDED.name,
            symbol           = EXCLUDED.symbol,
            interval         = EXCLUDED.interval,
            strategy_type    = EXCLUDED.strategy_type,
            strategy_params  = EXCLUDED.strategy_params,
            prop_firm_rules  = EXCLUDED.prop_firm_rules,
            guardrails       = EXCLUDED.guardrails,
            status           = EXCLUDED.status,
            commission       = EXCLUDED.commission,
            tick_value       = EXCLUDED.tick_value,
            tick_size        = EXCLUDED.tick_size,
            spread_ticks     = EXCLUDED.spread_ticks,
            volatile_bar_threshold_ticks = EXCLUDED.volatile_bar_threshold_ticks,
            volatile_bar_extra_ticks     = EXCLUDED.volatile_bar_extra_ticks,
            resting_fill_mode = EXCLUDED.resting_fill_mode,
            current_position = EXCLUDED.current_position,
            active_order     = EXCLUDED.active_order,
            active_orders    = EXCLUDED.active_orders,
            last_quote       = EXCLUDED.last_quote,
            trade_log        = EXCLUDED.trade_log,
            equity_curve     = EXCLUDED.equity_curve,
            metrics_snapshot = EXCLUDED.metrics_snapshot,
            guardrail_state  = EXCLUDED.guardrail_state,
            runner_state     = EXCLUDED.runner_state,
            last_bar_time    = EXCLUDED.last_bar_time,
            last_event_at    = EXCLUDED.last_event_at,
            created_by       = EXCLUDED.created_by,
            updated_at       = EXCLUDED.updated_at,
            state_version    = paper_sessions.state_version + 1
        WHERE paper_sessions.state_version = %s
        RETURNING state_version
    """

    with _conn() as conn:
        _ensure_paper_sessions_schema(conn)
        with conn.cursor() as cur:
            cur.execute(
                sql,
                [
                    session["paper_session_id"],
                    session["candidate_id"],
                    session.get("paper_bot_id"),
                    session["name"],
                    session["symbol"],
                    session["interval"],
                    session["strategy_type"],
                    json.dumps(session.get("strategy_params") or {}),
                    json.dumps(session.get("prop_firm_rules") or {}),
                    json.dumps(session.get("guardrails") or {}),
                    session["status"],
                    float(session.get("commission") or 5.0),
                    float(session.get("tick_value") or 1.0),
                    float(session.get("tick_size") or 0.25),
                    int(session.get("spread_ticks") or 1),
                    int(session.get("volatile_bar_threshold_ticks") or 0),
                    int(session.get("volatile_bar_extra_ticks") or 0),
                    session.get("resting_fill_mode") or "touch",
                    json.dumps(session.get("current_position") or {}),
                    json.dumps(session.get("active_order") or {}),
                    json.dumps(session.get("last_quote") or {}),
                    json.dumps(session.get("trade_log") or []),
                    json.dumps(session.get("equity_curve") or []),
                    json.dumps(session.get("active_orders") or []),
                    json.dumps(session.get("metrics_snapshot") or {}),
                    json.dumps(session.get("guardrail_state") or {}),
                    json.dumps(session.get("runner_state") or {}),
                    session.get("last_bar_time"),
                    session.get("last_event_at"),
                    session.get("created_by", "local-user"),
                    session["created_at"],
                    session["updated_at"],
                    expected_version,
                ],
            )
            row = cur.fetchone()
            if row is None:
                raise PaperSessionWriteConflict(
                    "Paper session changed since it was loaded. Retry with current state."
                )
            session["_state_version"] = int(row[0])
            if guard is not None:
                guard.expected_version = session["_state_version"]
        conn.commit()


def append_paper_event(event: dict) -> None:
    from services.db import _conn

    sql = """
        INSERT INTO paper_events (
            paper_event_id, paper_session_id, candidate_id, event_type,
            actor, summary, payload, created_at
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s)
        ON CONFLICT (paper_event_id) DO NOTHING
    """

    with _conn() as conn:
        _ensure_paper_sessions_schema(conn)
        with conn.cursor() as cur:
            cur.execute(
                sql,
                [
                    event["paper_event_id"],
                    event["paper_session_id"],
                    event["candidate_id"],
                    event["event_type"],
                    event.get("actor", "local-user"),
                    event["summary"],
                    json.dumps(event.get("payload") or {}),
                    event["created_at"],
                ],
            )
        conn.commit()


def get_paper_event(paper_event_id: str) -> Optional[dict]:
    from services.db import _conn, _read_sql

    sql = "SELECT * FROM paper_events WHERE paper_event_id = %s"
    with _conn() as conn:
        _ensure_paper_sessions_schema(conn)
    df = _read_sql(sql, params=[paper_event_id], parse_dates=["created_at"])
    if df.empty:
        return None
    return _row_to_event(df.iloc[0])


def get_policy_decision_resolution(paper_session_id: str, decision_id: str) -> Optional[dict]:
    """Read the durable receipt, including resolutions written by older code."""
    from services.db import _conn, _read_sql

    with _conn() as conn:
        _ensure_paper_sessions_schema(conn)
    df = _read_sql(
        """SELECT * FROM paper_events
        WHERE paper_session_id = %s AND event_type = 'policy_decision_resolved'
          AND payload->'decision'->>'decision_id' = %s
        ORDER BY created_at ASC LIMIT 1""",
        params=[paper_session_id, decision_id],
        parse_dates=["created_at"],
    )
    return None if df.empty else _row_to_event(df.iloc[0])


def policy_decision_has_execution(paper_session_id: str, decision_id: str) -> bool:
    """Detect pre-upgrade effects whose resolution receipt never committed."""
    from services.db import _conn, _read_sql

    with _conn() as conn:
        _ensure_paper_sessions_schema(conn)
    return not _read_sql(
        """SELECT 1 FROM paper_events
        WHERE paper_session_id = %s AND payload->>'approved_decision_id' = %s LIMIT 1""",
        params=[paper_session_id, decision_id],
    ).empty


def get_paper_session(paper_session_id: str) -> Optional[dict]:
    from services.db import _conn, _read_sql

    sql = "SELECT * FROM paper_sessions WHERE paper_session_id = %s"
    with _conn() as conn:
        _ensure_paper_sessions_schema(conn)
    df = _read_sql(
        sql,
        params=[paper_session_id],
        parse_dates=["last_bar_time", "last_event_at", "created_at", "updated_at"],
    )
    if df.empty:
        return None
    return _row_to_session(df.iloc[0])


def get_paper_session_by_candidate(candidate_id: str) -> Optional[dict]:
    from services.db import _conn, _read_sql

    sql = "SELECT * FROM paper_sessions WHERE candidate_id = %s"
    with _conn() as conn:
        _ensure_paper_sessions_schema(conn)
    df = _read_sql(
        sql,
        params=[candidate_id],
        parse_dates=["last_bar_time", "last_event_at", "created_at", "updated_at"],
    )
    if df.empty:
        return None
    return _row_to_session(df.iloc[0])


def list_paper_sessions() -> list[dict]:
    from services.db import _conn, _read_sql

    sql = "SELECT * FROM paper_sessions ORDER BY updated_at DESC, created_at DESC"
    with _conn() as conn:
        _ensure_paper_sessions_schema(conn)
    df = _read_sql(sql, parse_dates=["last_bar_time", "last_event_at", "created_at", "updated_at"])
    return [_row_to_session(row) for _, row in df.iterrows()]


def list_paper_events(paper_session_id: str) -> list[dict]:
    from services.db import _conn, _read_sql

    sql = """
        SELECT *
        FROM paper_events
        WHERE paper_session_id = %s
        ORDER BY created_at ASC
    """
    with _conn() as conn:
        _ensure_paper_sessions_schema(conn)
    df = _read_sql(sql, params=[paper_session_id], parse_dates=["created_at"])
    return [_row_to_event(row) for _, row in df.iterrows()]


def _row_to_session(row) -> dict:
    return {
        "paper_session_id": row["paper_session_id"],
        "candidate_id": row["candidate_id"],
        "paper_bot_id": row["paper_bot_id"],
        "name": row["name"],
        "symbol": row["symbol"],
        "interval": row["interval"],
        "strategy_type": row["strategy_type"],
        "strategy_params": _maybe_json(row["strategy_params"]) or {},
        "prop_firm_rules": _maybe_json(row["prop_firm_rules"]) or {},
        "guardrails": _maybe_json(row["guardrails"]) or {},
        "status": row["status"],
        "_state_version": int(row.get("state_version") or 0),
        "commission": float(row.get("commission") or 5.0),
        "tick_value": float(row.get("tick_value") or 1.0),
        "tick_size": float(row.get("tick_size") or 0.25),
        "spread_ticks": int(row.get("spread_ticks") or 1),
        "volatile_bar_threshold_ticks": int(row.get("volatile_bar_threshold_ticks") or 0),
        "volatile_bar_extra_ticks": int(row.get("volatile_bar_extra_ticks") or 0),
        "resting_fill_mode": row.get("resting_fill_mode") or "touch",
        "current_position": _maybe_json(row["current_position"]) or {},
        "active_order": _maybe_json(row.get("active_order")) or {},
        "active_orders": _maybe_json(row.get("active_orders")) or [],
        "last_quote": _maybe_json(row.get("last_quote")) or {},
        "trade_log": _maybe_json(row.get("trade_log")) or [],
        "equity_curve": _maybe_json(row.get("equity_curve")) or [],
        "metrics_snapshot": _maybe_json(row["metrics_snapshot"]) or {},
        "guardrail_state": _maybe_json(row["guardrail_state"]) or {},
        "runner_state": _maybe_json(row.get("runner_state")) or {},
        "last_bar_time": _maybe_iso(row["last_bar_time"]),
        "last_event_at": _maybe_iso(row["last_event_at"]),
        "created_by": row["created_by"],
        "created_at": _maybe_iso(row["created_at"]),
        "updated_at": _maybe_iso(row["updated_at"]),
    }


def _row_to_event(row) -> dict:
    return {
        "paper_event_id": row["paper_event_id"],
        "paper_session_id": row["paper_session_id"],
        "candidate_id": row["candidate_id"],
        "event_type": row["event_type"],
        "actor": row["actor"],
        "summary": row["summary"],
        "payload": _maybe_json(row["payload"]) or {},
        "created_at": _maybe_iso(row["created_at"]),
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
