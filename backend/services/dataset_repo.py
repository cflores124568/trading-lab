import json
from threading import Lock
from typing import Any, Optional

import pandas as pd

_schema_lock = Lock()
_schema_ready = False


def _ensure_datasets_schema(conn) -> None:
    """Keep the dataset registry table in sync for local dev databases.

    I'm still avoiding a full migration stack here, so this backfills the bits
    the loader now needs to make `dataset_id` more honest across restarts.
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
                CREATE TABLE IF NOT EXISTS datasets (
                    dataset_id     TEXT PRIMARY KEY,
                    name           TEXT NOT NULL,
                    source_kind    TEXT NOT NULL,
                    symbol         TEXT,
                    interval       TEXT,
                    rows           INTEGER NOT NULL DEFAULT 0,
                    columns_json   JSONB NOT NULL DEFAULT '[]'::jsonb,
                    start_date     TIMESTAMPTZ,
                    end_date       TIMESTAMPTZ,
                    locator        JSONB,
                    is_rebuildable BOOLEAN NOT NULL DEFAULT FALSE,
                    uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            cur.execute("ALTER TABLE datasets ADD COLUMN IF NOT EXISTS symbol TEXT")
            cur.execute("ALTER TABLE datasets ADD COLUMN IF NOT EXISTS interval TEXT")
            cur.execute("ALTER TABLE datasets ADD COLUMN IF NOT EXISTS rows INTEGER NOT NULL DEFAULT 0")
            cur.execute(
                "ALTER TABLE datasets ADD COLUMN IF NOT EXISTS columns_json JSONB NOT NULL DEFAULT '[]'::jsonb"
            )
            cur.execute("ALTER TABLE datasets ADD COLUMN IF NOT EXISTS start_date TIMESTAMPTZ")
            cur.execute("ALTER TABLE datasets ADD COLUMN IF NOT EXISTS end_date TIMESTAMPTZ")
            cur.execute("ALTER TABLE datasets ADD COLUMN IF NOT EXISTS locator JSONB")
            cur.execute(
                "ALTER TABLE datasets ADD COLUMN IF NOT EXISTS is_rebuildable BOOLEAN NOT NULL DEFAULT FALSE"
            )
            cur.execute("ALTER TABLE datasets ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()")
            cur.execute("ALTER TABLE datasets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()")
            cur.execute(
                "CREATE INDEX IF NOT EXISTS datasets_uploaded_at_idx ON datasets (uploaded_at DESC)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS datasets_source_kind_idx ON datasets (source_kind)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS datasets_symbol_idx ON datasets (symbol)"
            )
        conn.commit()
        _schema_ready = True


def save_dataset_info(info: dict, locator: dict | None = None) -> None:
    """Persist dataset metadata plus a rebuild locator when we have one.

    The loader still caches hot DataFrames in memory, but this row is the durable
    breadcrumb that lets us recover the dataset later instead of treating the id
    like a one-process secret.
    """
    from services.db import _conn

    sql = """
        INSERT INTO datasets (
            dataset_id, name, source_kind, symbol, interval, rows, columns_json,
            start_date, end_date, locator, is_rebuildable, uploaded_at, updated_at
        )
        VALUES (
            %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s::jsonb, %s, %s, %s
        )
        ON CONFLICT (dataset_id) DO UPDATE SET
            name           = EXCLUDED.name,
            source_kind    = EXCLUDED.source_kind,
            symbol         = EXCLUDED.symbol,
            interval       = EXCLUDED.interval,
            rows           = EXCLUDED.rows,
            columns_json   = EXCLUDED.columns_json,
            start_date     = EXCLUDED.start_date,
            end_date       = EXCLUDED.end_date,
            locator        = EXCLUDED.locator,
            is_rebuildable = EXCLUDED.is_rebuildable,
            uploaded_at    = EXCLUDED.uploaded_at,
            updated_at     = EXCLUDED.updated_at
    """

    uploaded_at = info.get("uploaded_at")
    with _conn() as conn:
        _ensure_datasets_schema(conn)
        with conn.cursor() as cur:
            cur.execute(
                sql,
                [
                    info["dataset_id"],
                    info["name"],
                    info.get("source", "unknown"),
                    info.get("symbol"),
                    info.get("interval"),
                    int(info.get("rows", 0)),
                    json.dumps(info.get("columns", [])),
                    info.get("start_date"),
                    info.get("end_date"),
                    json.dumps(locator),
                    bool(locator),
                    uploaded_at,
                    uploaded_at,
                ],
            )
        conn.commit()


def get_dataset_record(dataset_id: str) -> Optional[dict]:
    """Load one dataset registry row by id."""
    from services.db import _conn, _read_sql

    sql = "SELECT * FROM datasets WHERE dataset_id = %s"
    with _conn() as conn:
        _ensure_datasets_schema(conn)
    df = _read_sql(
        sql,
        params=[dataset_id],
        parse_dates=["start_date", "end_date", "uploaded_at", "updated_at"],
    )

    if df.empty:
        return None

    return _row_to_record(df.iloc[0])


def list_datasets() -> list[dict]:
    """Return every persisted dataset newest first."""
    from services.db import _conn, _read_sql

    sql = "SELECT * FROM datasets ORDER BY uploaded_at DESC"
    with _conn() as conn:
        _ensure_datasets_schema(conn)
    df = _read_sql(
        sql,
        parse_dates=["start_date", "end_date", "uploaded_at", "updated_at"],
    )

    return [_row_to_record(row) for _, row in df.iterrows()]


def _row_to_record(row) -> dict:
    """Turn one dataset row back into our normal metadata shape."""
    return {
        "dataset_id": row["dataset_id"],
        "name": row["name"],
        "source": row["source_kind"],
        "symbol": row.get("symbol") if hasattr(row, "get") else row["symbol"],
        "interval": row.get("interval") if hasattr(row, "get") else row["interval"],
        "rows": int(row.get("rows", 0) if hasattr(row, "get") else row["rows"]),
        "columns": _maybe_json(row.get("columns_json")) if hasattr(row, "get") else _maybe_json(row["columns_json"]),
        "start_date": _maybe_iso(row.get("start_date")) if hasattr(row, "get") else _maybe_iso(row["start_date"]),
        "end_date": _maybe_iso(row.get("end_date")) if hasattr(row, "get") else _maybe_iso(row["end_date"]),
        "uploaded_at": _maybe_iso(row.get("uploaded_at")) if hasattr(row, "get") else _maybe_iso(row["uploaded_at"]),
        "updated_at": _maybe_iso(row.get("updated_at")) if hasattr(row, "get") else _maybe_iso(row["updated_at"]),
        "locator": _maybe_json(row.get("locator")) if hasattr(row, "get") else _maybe_json(row["locator"]),
        "is_rebuildable": bool(
            row.get("is_rebuildable", False) if hasattr(row, "get") else row["is_rebuildable"]
        ),
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
