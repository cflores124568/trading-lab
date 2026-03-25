"""
PostgreSQL / TimescaleDB connection pool + fast OHLCV query helpers.

This is now the single source of truth for all database access. It replaces the
old parquet + Python resample path with time_bucket() SQL queries that are both
faster and way more memory-efficient.
"""

from __future__ import annotations
import os
from contextlib import contextmanager
from typing import Generator

import numpy as np
import pandas as pd

# ── Connection pool (lazy init) ───────────────────────────────────────────────
_pool = None  # psycopg2.pool.ThreadedConnectionPool


def _init_pool() -> None:
    """Lazy-init the connection pool the first time we actually need the DB.

    This keeps imports fast and lets unit tests run without a real database
    (the pool only gets created on first query).
    """
    global _pool
    if _pool is not None:
        return  # already initialized

    try:
        from psycopg2 import pool as pg_pool
    except ImportError as exc:
        raise ImportError(
            "psycopg2 is required for database access. "
            "Run: pip install psycopg2-binary"
        ) from exc

    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL environment variable is not set. "
            "Add it to your .env file."
        )

    # Creates 1–10 warm connections that we reuse instead of opening new ones
    # every time. ThreadedConnectionPool is safe for multi-threaded web apps.
    _pool = pg_pool.ThreadedConnectionPool(minconn=1, maxconn=10, dsn=url)


@contextmanager
def _conn() -> Generator:
    """Borrow a connection from the pool (creating the pool if needed) and
    always return it afterwards, even if an error occurs.
    """
    _init_pool()
    conn = _pool.getconn()
    try:
        yield conn
    except Exception:
        conn.rollback()
        raise
    finally:
        _pool.putconn(conn)


# ── Interval → time_bucket string ────────────────────────────────────────────
_BUCKET_MAP: dict[str, str] = {
    "1min": "1 minute",
    "5min": "5 minutes",
    "10min": "10 minutes",
    "15min": "15 minutes",
    "30min": "30 minutes",
    "1h": "1 hour",
    "4h": "4 hours",
    "1d": "1 day",
    "1w": "1 week",
}


def _bucket(interval: str) -> str:
    """Convert our canonical interval into a TimescaleDB time_bucket string."""
    b = _BUCKET_MAP.get(interval)
    if b is None:
        raise ValueError(
            f"Unknown interval '{interval}'. "
            f"Valid: {list(_BUCKET_MAP.keys())}"
        )
    return b


# ── Public query helpers ──────────────────────────────────────────────────────
def get_ohlcv(
    symbol: str,
    interval: str = "1min",
    start_date: str | None = None,
    end_date: str | None = None,
    limit: int | None = None,
) -> pd.DataFrame:
    """Fetch OHLCV bars for a symbol from TimescaleDB.

    For 1min it reads straight from ohlcv_1m. For everything else it uses
    time_bucket() to aggregate on the fly — much faster and lighter than
    doing it in pandas.

    Returns a DataFrame with DatetimeIndex named 'ts' and columns
    [open, high, low, close, volume].
    """
    bucket = _bucket(interval)

    params: list = [symbol]
    date_filter = ""
    if start_date:
        params.append(start_date)
        date_filter += " AND ts >= %s"
    if end_date:
        params.append(end_date)
        date_filter += " AND ts <= %s"

    limit_clause = ""
    if limit:
        params.append(limit)
        limit_clause = "LIMIT %s"

    if interval == "1min":
        # Direct read — no aggregation needed
        sql = f"""
            SELECT ts, open, high, low, close, volume
            FROM ohlcv_1m
            WHERE symbol = %s
            {date_filter}
            ORDER BY ts
            {limit_clause}
        """
    else:
        # Aggregate on the DB side — this is the big win
        sql = f"""
            SELECT
                time_bucket('{bucket}', ts) AS ts,
                first(open, ts) AS open,
                max(high) AS high,
                min(low) AS low,
                last(close, ts) AS close,
                sum(volume) AS volume
            FROM ohlcv_1m
            WHERE symbol = %s
            {date_filter}
            GROUP BY 1
            ORDER BY 1
            {limit_clause}
        """

    with _conn() as conn:
        df = pd.read_sql(sql, conn, params=params, parse_dates=["ts"])

    df.set_index("ts", inplace=True)
    df.index.name = "ts"

    # Ensure float64 so NumPy and later code stay happy
    for col in ["open", "high", "low", "close", "volume"]:
        if col in df.columns:
            df[col] = df[col].astype(np.float64)

    return df


def list_db_symbols() -> list[dict]:
    """Return metadata for every symbol that has data in the DB.

    Joins with the symbols table for full_name / tick info and includes
    row count + date range. Returns list of dicts that match the DatasetInfo
    shape so the frontend doesn't need changes.
    """
    sql = """
        SELECT
            o.symbol,
            s.full_name,
            s.exchange,
            s.tick_size,
            s.tick_value,
            count(*) AS rows,
            min(o.ts) AS start_date,
            max(o.ts) AS end_date
        FROM ohlcv_1m o
        LEFT JOIN symbols s USING (symbol)
        GROUP BY o.symbol, s.full_name, s.exchange, s.tick_size, s.tick_value
        ORDER BY o.symbol
    """

    with _conn() as conn:
        df = pd.read_sql(sql, conn)

    results = []
    for _, row in df.iterrows():
        results.append({
            "symbol": row["symbol"],
            "full_name": row.get("full_name") or row["symbol"],
            "exchange": row.get("exchange") or "CME",
            "tick_size": float(row.get("tick_size") or 0.25),
            "tick_value": float(row.get("tick_value") or 12.50),
            "rows": int(row["rows"]),
            "start_date": row["start_date"].isoformat() if hasattr(row["start_date"], "isoformat") else str(row["start_date"]),
            "end_date": row["end_date"].isoformat() if hasattr(row["end_date"], "isoformat") else str(row["end_date"]),
        })

    return results


def get_symbol_info(symbol: str) -> dict | None:
    """Return metadata for a single symbol, or None if not found."""
    sql = """
        SELECT
            s.symbol, s.full_name, s.exchange,
            s.tick_size, s.tick_value,
            count(o.ts) AS rows,
            min(o.ts) AS start_date,
            max(o.ts) AS end_date
        FROM symbols s
        LEFT JOIN ohlcv_1m o USING (symbol)
        WHERE s.symbol = %s
        GROUP BY s.symbol, s.full_name, s.exchange, s.tick_size, s.tick_value
    """

    with _conn() as conn:
        df = pd.read_sql(sql, conn, params=[symbol.upper()])

    if df.empty:
        return None

    row = df.iloc[0]
    return {
        "symbol": row["symbol"],
        "full_name": row["full_name"],
        "exchange": row["exchange"],
        "tick_size": float(row["tick_size"]),
        "tick_value": float(row["tick_value"]),
        "rows": int(row["rows"]),
        "start_date": row["start_date"].isoformat() if hasattr(row["start_date"], "isoformat") else None,
        "end_date": row["end_date"].isoformat() if hasattr(row["end_date"], "isoformat") else None,
    }


def health_check() -> dict:
    """Quick DB health check returns status and row count per symbol

    Used by the /health endpoint.
    """
    try:
        sql = """
            SELECT symbol, count(*) AS rows
            FROM ohlcv_1m
            GROUP BY symbol
            ORDER BY symbol
        """
        with _conn() as conn:
            df = pd.read_sql(sql, conn)

        return {
            "db_status": "ok",
            "symbols": df.set_index("symbol")["rows"].to_dict(),
        }
    except Exception as exc:
        return {"db_status": "error", "detail": str(exc)}