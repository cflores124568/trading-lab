import json
from threading import Lock
from typing import Any, Optional
import pandas as pd
from services.execution_model import (
    DEFAULT_BACKTEST_EXECUTION_MODE,
    DEFAULT_SPREAD_TICKS,
    DEFAULT_VOLATILE_BAR_EXTRA_TICKS,
    DEFAULT_VOLATILE_BAR_THRESHOLD_TICKS,
    normalize_backtest_execution_mode,
)

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
            cur.execute("ALTER TABLE backtests ADD COLUMN IF NOT EXISTS run_config JSONB")
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
            backtest_id, dataset_id, symbol, replay_context, run_config, strategy_type, strategy,
            prop_firm_rules, status, created_at, trades,
            metrics, prop_firm_eval, equity_curve
        )
        VALUES (%s, %s, %s, %s::jsonb, %s::jsonb, %s, %s::jsonb, %s::jsonb, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb)
        ON CONFLICT (backtest_id) DO UPDATE SET
            dataset_id      = EXCLUDED.dataset_id,
            symbol          = EXCLUDED.symbol,
            replay_context  = EXCLUDED.replay_context,
            run_config      = EXCLUDED.run_config,
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
                    json.dumps(result.get("run_config")),
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
    from services.db import _conn, _read_sql

    sql = "SELECT * FROM backtests WHERE backtest_id = %s"
    with _conn() as conn:
        _ensure_backtests_schema(conn)
    df = _read_sql(sql, params=[backtest_id])

    if df.empty:
        return None

    return _row_to_result(df.iloc[0])


def list_backtests() -> list[dict]:
    """Load all saved backtests newest first.

    This just reads the rows in descending `created_at` order and maps each one
    back into the normal result payload shape, so the router can stay simple
    when it switches over to DB-first reads.
    """
    from services.db import _conn, _read_sql

    sql = "SELECT * FROM backtests ORDER BY created_at DESC"
    with _conn() as conn:
        _ensure_backtests_schema(conn)
    df = _read_sql(sql)

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
        "run_config":      _hydrate_run_config(row),
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


def _hydrate_run_config(row) -> dict:
    raw = _maybe_json(row.get("run_config")) if hasattr(row, "get") else _maybe_json(row["run_config"])
    prop_rules = _maybe_json(row["prop_firm_rules"])
    trades = _maybe_json(row["trades"]) or []

    if isinstance(raw, dict) and raw:
        return {
            "initial_balance": float(raw.get("initial_balance") or prop_rules.get("account_size") or 100_000),
            "position_size": float(raw.get("position_size") or 1.0),
            "commission": float(raw.get("commission") if raw.get("commission") is not None else _infer_trade_commission(trades)),
            "tick_size": float(raw.get("tick_size") or _infer_trade_tick_size(trades)),
            "tick_value": float(raw.get("tick_value") or 12.5),
            "slippage_ticks": float(raw.get("slippage_ticks") if raw.get("slippage_ticks") is not None else 1.0),
            "stop_loss_ticks": float(raw.get("stop_loss_ticks")) if raw.get("stop_loss_ticks") is not None else None,
            "take_profit_ticks": float(raw.get("take_profit_ticks")) if raw.get("take_profit_ticks") is not None else None,
            "execution_mode": normalize_backtest_execution_mode(raw.get("execution_mode")),
            "spread_ticks": max(1, int(raw.get("spread_ticks") or DEFAULT_SPREAD_TICKS)),
            "volatile_bar_threshold_ticks": max(
                0, int(raw.get("volatile_bar_threshold_ticks") or DEFAULT_VOLATILE_BAR_THRESHOLD_TICKS)
            ),
            "volatile_bar_extra_ticks": max(
                0, int(raw.get("volatile_bar_extra_ticks") or DEFAULT_VOLATILE_BAR_EXTRA_TICKS)
            ),
        }

    return {
        "initial_balance": float(prop_rules.get("account_size") or 100_000),
        "position_size": 1.0,
        "commission": float(_infer_trade_commission(trades)),
        "tick_size": float(_infer_trade_tick_size(trades)),
        "tick_value": 12.5,
        "slippage_ticks": 1.0,
        "stop_loss_ticks": None,
        "take_profit_ticks": None,
        "execution_mode": DEFAULT_BACKTEST_EXECUTION_MODE,
        "spread_ticks": DEFAULT_SPREAD_TICKS,
        "volatile_bar_threshold_ticks": DEFAULT_VOLATILE_BAR_THRESHOLD_TICKS,
        "volatile_bar_extra_ticks": DEFAULT_VOLATILE_BAR_EXTRA_TICKS,
    }


def _infer_trade_commission(trades: list[dict]) -> float:
    if trades and trades[0].get("commission") is not None:
        return float(trades[0]["commission"])
    return 5.0


def _infer_trade_tick_size(trades: list[dict]) -> float:
    if trades and trades[0].get("tick_size") is not None:
        return float(trades[0]["tick_size"])
    return 0.25


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
