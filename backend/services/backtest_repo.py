import json
from threading import Lock
from typing import Any, Optional
import pandas as pd

_schema_lock = Lock()
_schema_ready = False


def _ensure_backtests_schema(conn) -> None:
    """Backfill newer backtest columns for existing local databases.

    Trading Lab is moving quickly and not using a full migration framework yet,
    so this keeps older developer databases compatible with the latest app code.
    """
    global _schema_ready

    if _schema_ready:
        return

    with _schema_lock:
        if _schema_ready:
            return

        with conn.cursor() as cur:
            cur.execute("ALTER TABLE backtests ADD COLUMN IF NOT EXISTS symbol TEXT")
            cur.execute("ALTER TABLE backtests ADD COLUMN IF NOT EXISTS replay_context JSONB")
            cur.execute(
                "CREATE INDEX IF NOT EXISTS backtests_symbol_idx ON backtests (symbol)"
            )
        conn.commit()
        _schema_ready = True

def save_backtest(result: dict) -> None:
    """Save a completed backtest result into Postgres.

    This stays intentionally thin and just writes the same result shape the
    router already returns. The nested pieces get dumped into `jsonb` columns
    so we don't need a whole mapper layer yet.
    """
    from services.db import _conn

    sql = """
        INSERT INTO backtests (
            backtest_id, dataset_id, symbol, replay_context, strategy_type, strategy,
            prop_firm_rules, status, created_at, trades,
            metrics, prop_firm_eval, equity_curve
        )
        VALUES (%s, %s, %s, %s::jsonb, %s, %s::jsonb, %s::jsonb, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb)
        ON CONFLICT (backtest_id) DO UPDATE SET
            dataset_id      = EXCLUDED.dataset_id,
            symbol          = EXCLUDED.symbol,
            replay_context  = EXCLUDED.replay_context,
            strategy_type   = EXCLUDED.strategy_type,
            strategy        = EXCLUDED.strategy,
            prop_firm_rules = EXCLUDED.prop_firm_rules,
            status          = EXCLUDED.status,
            created_at      = EXCLUDED.created_at,
            trades          = EXCLUDED.trades,
            metrics         = EXCLUDED.metrics,
            prop_firm_eval  = EXCLUDED.prop_firm_eval,
            equity_curve    = EXCLUDED.equity_curve
    """

    with _conn() as conn:
        _ensure_backtests_schema(conn)
        with conn.cursor() as cur:
            cur.execute(
                sql,
                [
                    result["backtest_id"],
                    result["dataset_id"],
                    result.get("symbol", ""),
                    json.dumps(result.get("replay_context")),
                    result["strategy"]["type"],
                    json.dumps(result["strategy"]),
                    json.dumps(result["prop_firm_rules"]),
                    result["status"],
                    result["created_at"],
                    json.dumps(result["trades"]),
                    json.dumps(result["metrics"]),
                    json.dumps(result["prop_firm_eval"]),
                    json.dumps(result["equity_curve"]),
                ],
            )
        conn.commit()


def get_backtest(backtest_id: str) -> Optional[dict]:
    """Load one saved backtest by id.

    Reads it straight from the `backtests` table and converts the row back into
    the same dict shape the API already uses, so the rest of the app doesn't
    have to care whether it came from memory or Postgres.
    """
    from services.db import _conn

    sql = "SELECT * FROM backtests WHERE backtest_id = %s"
    with _conn() as conn:
        _ensure_backtests_schema(conn)
        df = pd.read_sql(sql, conn, params=[backtest_id])

    if df.empty:
        return None

    return _row_to_result(df.iloc[0])


def list_backtests() -> list[dict]:
    """Load all saved backtests newest first.

    This just reads the rows in descending `created_at` order and maps each one
    back into the normal result payload shape, so the router can stay simple
    when it switches over to DB-first reads.
    """
    from services.db import _conn

    sql = "SELECT * FROM backtests ORDER BY created_at DESC"
    with _conn() as conn:
        _ensure_backtests_schema(conn)
        df = pd.read_sql(sql, conn)

    return [_row_to_result(row) for _, row in df.iterrows()]


def _row_to_result(row) -> dict:
    """Turn one DB row back into a normal backtest result dict.

    Keeps the keys lined up with the in-memory version and normalizes
    `created_at` into a string, so callers get one consistent shape no matter
    where the result came from.
    """
    return {
        "backtest_id":     row["backtest_id"],
        "dataset_id":      row["dataset_id"],
        "symbol":          row.get("symbol", "") if hasattr(row, "get") else row["symbol"],
        "replay_context":  _maybe_json(row.get("replay_context")) if hasattr(row, "get") else None,
        "strategy":        _maybe_json(row["strategy"]),
        "prop_firm_rules": _maybe_json(row["prop_firm_rules"]),
        "status":          row["status"],
        "created_at": (
            row["created_at"].isoformat()
            if hasattr(row["created_at"], "isoformat")
            else str(row["created_at"])
        ),
        "trades":          _maybe_json(row["trades"]),
        "metrics":         _maybe_json(row["metrics"]),
        "prop_firm_eval":  _maybe_json(row["prop_firm_eval"]),
        "equity_curve":    _maybe_json(row["equity_curve"]),
    }


def _maybe_json(value: Any) -> Any:
    """Leave parsed JSON alone and decode string JSON if needed.

    Depending on the driver setup, `pandas.read_sql` may hand `jsonb` columns
    back as real dict/list objects or as JSON strings. This smooths that out so
    the rest of the code doesn't get weird surprises.
    """
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value
