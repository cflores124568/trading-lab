import json
from threading import Lock
from typing import Any, Optional

_schema_lock = Lock()
_schema_ready = False


def _ensure_replay_sessions_schema(conn) -> None:
    global _schema_ready

    if _schema_ready:
        return

    with _schema_lock:
        if _schema_ready:
            return

        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS replay_sessions (
                    replay_session_id TEXT PRIMARY KEY,
                    name              TEXT NOT NULL,
                    symbol            TEXT NOT NULL,
                    interval          TEXT NOT NULL,
                    start_date        TEXT,
                    end_date          TEXT,
                    source_backtest   JSONB,
                    prop_firm_rules   JSONB NOT NULL,
                    commission        DOUBLE PRECISION NOT NULL DEFAULT 5,
                    tick_value        DOUBLE PRECISION NOT NULL,
                    tick_size         DOUBLE PRECISION NOT NULL DEFAULT 0.25,
                    spread_ticks      INTEGER NOT NULL DEFAULT 1,
                    current_bar_index INTEGER NOT NULL DEFAULT 0,
                    status            TEXT NOT NULL DEFAULT 'active',
                    actions           JSONB NOT NULL,
                    active_order      JSONB,
                    execution_events  JSONB NOT NULL DEFAULT '[]'::jsonb,
                    trades            JSONB NOT NULL,
                    metrics           JSONB NOT NULL,
                    prop_firm_eval    JSONB NOT NULL,
                    equity_curve      JSONB NOT NULL,
                    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            cur.execute("ALTER TABLE replay_sessions ADD COLUMN IF NOT EXISTS source_backtest JSONB")
            cur.execute(
                "ALTER TABLE replay_sessions ADD COLUMN IF NOT EXISTS tick_size DOUBLE PRECISION NOT NULL DEFAULT 0.25"
            )
            cur.execute(
                "ALTER TABLE replay_sessions ADD COLUMN IF NOT EXISTS spread_ticks INTEGER NOT NULL DEFAULT 1"
            )
            cur.execute("ALTER TABLE replay_sessions ADD COLUMN IF NOT EXISTS active_order JSONB")
            cur.execute(
                "ALTER TABLE replay_sessions ADD COLUMN IF NOT EXISTS execution_events JSONB NOT NULL DEFAULT '[]'::jsonb"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS replay_sessions_updated_at_idx ON replay_sessions (updated_at DESC)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS replay_sessions_symbol_idx ON replay_sessions (symbol)"
            )
        conn.commit()
        _schema_ready = True


def save_replay_session(result: dict) -> None:
    from services.db import _conn

    sql = """
        INSERT INTO replay_sessions (
            replay_session_id, name, symbol, interval, start_date, end_date,
            source_backtest, prop_firm_rules, commission, tick_value,
            tick_size, spread_ticks, current_bar_index, status, actions,
            active_order, execution_events, trades, metrics, prop_firm_eval,
            equity_curve, created_at, updated_at
        )
        VALUES (
            %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s, %s,
            %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb,
            %s::jsonb, %s::jsonb, %s, %s
        )
        ON CONFLICT (replay_session_id) DO UPDATE SET
            name              = EXCLUDED.name,
            symbol            = EXCLUDED.symbol,
            interval          = EXCLUDED.interval,
            start_date        = EXCLUDED.start_date,
            end_date          = EXCLUDED.end_date,
            source_backtest   = EXCLUDED.source_backtest,
            prop_firm_rules   = EXCLUDED.prop_firm_rules,
            commission        = EXCLUDED.commission,
            tick_value        = EXCLUDED.tick_value,
            tick_size         = EXCLUDED.tick_size,
            spread_ticks      = EXCLUDED.spread_ticks,
            current_bar_index = EXCLUDED.current_bar_index,
            status            = EXCLUDED.status,
            actions           = EXCLUDED.actions,
            active_order      = EXCLUDED.active_order,
            execution_events  = EXCLUDED.execution_events,
            trades            = EXCLUDED.trades,
            metrics           = EXCLUDED.metrics,
            prop_firm_eval    = EXCLUDED.prop_firm_eval,
            equity_curve      = EXCLUDED.equity_curve,
            updated_at        = EXCLUDED.updated_at
    """

    with _conn() as conn:
        _ensure_replay_sessions_schema(conn)
        with conn.cursor() as cur:
            cur.execute(
                sql,
                [
                    result["replay_session_id"],
                    result["name"],
                    result["symbol"],
                    result["interval"],
                    result.get("start_date"),
                    result.get("end_date"),
                    json.dumps(result.get("source_backtest")),
                    json.dumps(result["prop_firm_rules"]),
                    result["commission"],
                    result["tick_value"],
                    result.get("tick_size", 0.25),
                    result.get("spread_ticks", 1),
                    result["current_bar_index"],
                    result["status"],
                    json.dumps(result["actions"]),
                    json.dumps(result.get("active_order")),
                    json.dumps(result.get("execution_events") or []),
                    json.dumps(result["trades"]),
                    json.dumps(result["metrics"]),
                    json.dumps(result["prop_firm_eval"]),
                    json.dumps(result["equity_curve"]),
                    result["created_at"],
                    result["updated_at"],
                ],
            )
        conn.commit()


def get_replay_session(replay_session_id: str) -> Optional[dict]:
    from services.db import _conn, _read_sql

    sql = "SELECT * FROM replay_sessions WHERE replay_session_id = %s"
    with _conn() as conn:
        _ensure_replay_sessions_schema(conn)
    df = _read_sql(sql, params=[replay_session_id])

    if df.empty:
        return None

    return _row_to_result(df.iloc[0])


def list_replay_sessions() -> list[dict]:
    from services.db import _conn, _read_sql

    sql = "SELECT * FROM replay_sessions ORDER BY updated_at DESC"
    with _conn() as conn:
        _ensure_replay_sessions_schema(conn)
    df = _read_sql(sql)

    return [_row_to_result(row) for _, row in df.iterrows()]


def _row_to_result(row) -> dict:
    return {
        "replay_session_id": row["replay_session_id"],
        "name": row["name"],
        "symbol": row["symbol"],
        "interval": row["interval"],
        "start_date": row["start_date"],
        "end_date": row["end_date"],
        "source_backtest": _maybe_json(row.get("source_backtest")) if hasattr(row, "get") else None,
        "prop_firm_rules": _maybe_json(row["prop_firm_rules"]),
        "commission": float(row["commission"]),
        "tick_value": float(row["tick_value"]),
        "tick_size": float(row.get("tick_size") or 0.25),
        "spread_ticks": int(row.get("spread_ticks") or 1),
        "current_bar_index": int(row["current_bar_index"]),
        "status": row["status"],
        "actions": _maybe_json(row["actions"]),
        "active_order": _maybe_json(row.get("active_order")) if hasattr(row, "get") else None,
        "execution_events": _maybe_json(row.get("execution_events")) if hasattr(row, "get") else [],
        "trades": _maybe_json(row["trades"]),
        "metrics": _maybe_json(row["metrics"]),
        "prop_firm_eval": _maybe_json(row["prop_firm_eval"]),
        "equity_curve": _maybe_json(row["equity_curve"]),
        "created_at": (
            row["created_at"].isoformat()
            if hasattr(row["created_at"], "isoformat")
            else str(row["created_at"])
        ),
        "updated_at": (
            row["updated_at"].isoformat()
            if hasattr(row["updated_at"], "isoformat")
            else str(row["updated_at"])
        ),
    }


def _maybe_json(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value
