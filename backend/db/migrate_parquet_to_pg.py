#!/usr/bin/env python3
"""
migrate_parquet_to_pg.py

One-time script to migrate all Databento 1-minute parquet files into my new
ohlcv_1m TimescaleDB hypertable.

Uses COPY (via psycopg2 copy_expert) so it’s fast even with 11M+ rows.
Each symbol is handled independently such that one failure won’t kill the whole run.

Run with --dry-run first to see what it would do. Use --replace if you re-fetched
a symbol and want to wipe the old data before inserting the new.
"""

import argparse
import io
import os
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from dotenv import load_dotenv

load_dotenv()

# onfig 
PARQUET_DIR = Path(__file__).resolve().parent.parent / "data" / "futures_1m"

# Symbol key -> clean symbol name (mirrors data_loader.py)
SYMBOL_MAP: dict[str, str] = {
    "NQ_c_0": "NQ",
    "MNQ_c_0": "MNQ",
    "ES_c_0": "ES",
    "MES_c_0": "MES",
    "GC_c_0": "GC",
    "MGC_c_0": "MGC",
}

# Databento stores prices as fixed-point int64 scaled by 1e9
PRICE_SCALE = 1e9


#  Helpers 
def get_connection():
    """Return a psycopg2 connection using DATABASE_URL from .env."""
    try:
        import psycopg2
    except ImportError:
        print("ERROR: psycopg2 not installed. Run: pip install psycopg2-binary")
        sys.exit(1)

    url = os.environ.get("DATABASE_URL")
    if not url:
        print("ERROR: DATABASE_URL environment variable not set.")
        print("Add it to your .env file like:")
        print("DATABASE_URL=postgresql://user:pass@localhost:5432/trading_lab")
        sys.exit(1)

    return psycopg2.connect(url)


def load_parquet(path: Path, symbol: str) -> pd.DataFrame:
    """Load a Databento parquet file and clean it up for TimescaleDB insertion.

    Converts ts_event/date to proper datetime, scales fixed-point prices to float64,
    adds the symbol column, drops any rows with null OHLCV, and keeps only the
    columns the table actually needs.
    """
    df = pd.read_parquet(path)

    # Timestamp column; Databento usually uses ts_event
    if "ts_event" in df.columns:
        df["ts"] = pd.to_datetime(df["ts_event"])
    elif "date" in df.columns:
        df["ts"] = pd.to_datetime(df["date"])
    else:
        df["ts"] = pd.to_datetime(df.index)

    # Scale prices from fixed-point int64 to real dollars
    price_cols = ["open", "high", "low", "close"]
    for col in price_cols:
        if col in df.columns:
            if df[col].max() > 1e8:  # still in fixed-point
                df[col] = df[col] / PRICE_SCALE
            df[col] = df[col].astype(np.float64)

    if "volume" in df.columns:
        df["volume"] = df["volume"].astype(np.float64)

    df["symbol"] = symbol

    # Drop timezone info (TimescaleDB stores as naive UTC)
    if df["ts"].dt.tz is not None:
        df["ts"] = df["ts"].dt.tz_convert("UTC").dt.tz_localize(None)

    # Keep only columns the table expects
    keep = ["ts", "symbol", "open", "high", "low", "close", "volume"]
    df = df[[c for c in keep if c in df.columns]].copy()

    df.dropna(subset=["open", "high", "low", "close", "volume"], inplace=True)
    df.sort_values("ts", inplace=True)
    df.reset_index(drop=True, inplace=True)

    return df


def get_existing_max_ts(conn) -> dict[str, pd.Timestamp]:
    """Return the latest stored timestamp for each symbol currently in the DB."""
    cur = conn.cursor()
    cur.execute("SELECT symbol, max(ts) FROM ohlcv_1m GROUP BY symbol")
    result = {
        row[0]: pd.Timestamp(row[1]).tz_localize(None) if row[1] is not None else None
        for row in cur.fetchall()
    }
    cur.close()
    return result


def copy_to_db(conn, df: pd.DataFrame, symbol: str, replace: bool) -> int:
    """Bulk COPY a DataFrame into a temp table, then merge into ohlcv_1m.

    If replace=True, deletes existing rows for this symbol first.
    Otherwise, rows are merged with ON CONFLICT so reruns stay idempotent.
    Returns the number of rows inserted or updated by the merge query.
    """
    cur = conn.cursor()

    if replace:
        cur.execute("DELETE FROM ohlcv_1m WHERE symbol = %s", (symbol,))
        print(f" Deleted existing rows for {symbol}")

    cur.execute("""
        CREATE TEMP TABLE staging_ohlcv_1m (
            ts TIMESTAMPTZ NOT NULL,
            symbol TEXT NOT NULL,
            open DOUBLE PRECISION NOT NULL,
            high DOUBLE PRECISION NOT NULL,
            low DOUBLE PRECISION NOT NULL,
            close DOUBLE PRECISION NOT NULL,
            volume DOUBLE PRECISION NOT NULL
        ) ON COMMIT DROP
    """)

    # Build CSV in memory; faster than executemany
    buf = io.StringIO()
    for row in df.itertuples(index=False):
        buf.write(
            f"{row.ts.isoformat()},{row.symbol},"
            f"{row.open},{row.high},{row.low},{row.close},{row.volume}\n"
        )

    buf.seek(0)
    cur.copy_expert(
        """
        COPY staging_ohlcv_1m (ts, symbol, open, high, low, close, volume)
        FROM STDIN WITH (FORMAT csv)
        """,
        buf,
    )

    cur.execute(
        """
        INSERT INTO ohlcv_1m (ts, symbol, open, high, low, close, volume)
        SELECT ts, symbol, open, high, low, close, volume
        FROM staging_ohlcv_1m
        ON CONFLICT (symbol, ts) DO UPDATE SET
            open = EXCLUDED.open,
            high = EXCLUDED.high,
            low = EXCLUDED.low,
            close = EXCLUDED.close,
            volume = EXCLUDED.volume
        """
    )

    rows = cur.rowcount
    conn.commit()
    cur.close()
    return rows


def get_existing_counts(conn) -> dict[str, int]:
    """Return {symbol: row_count} for everything currently in the ohlcv_1m table."""
    cur = conn.cursor()
    cur.execute("SELECT symbol, count(*) FROM ohlcv_1m GROUP BY symbol")
    result = {row[0]: row[1] for row in cur.fetchall()}
    cur.close()
    return result
 
def migrate(symbols_filter: list[str] | None, dry_run: bool, replace: bool) -> None:
    """Run the full parquet → TimescaleDB migration.

    Processes each symbol independently. On reruns it imports only the new tail
    of each parquet file unless --replace is used.
    """
    if not PARQUET_DIR.exists():
        print(f"ERROR: Parquet directory not found: {PARQUET_DIR}")
        sys.exit(1)

    parquet_files = sorted(PARQUET_DIR.glob("*.parquet"))
    if not parquet_files:
        print(f"No parquet files found in {PARQUET_DIR}")
        sys.exit(1)

    # Build list of (path, symbol) we actually want to process
    targets: list[tuple[Path, str]] = []
    for path in parquet_files:
        slug = path.stem
        symbol = SYMBOL_MAP.get(slug)
        if symbol is None:
            print(f" Skipping unknown slug: {slug}")
            continue
        if symbols_filter and symbol not in symbols_filter:
            continue
        targets.append((path, symbol))

    if not targets:
        print("No matching parquet files found.")
        return

    print(f"\n── Trading Lab — Parquet → TimescaleDB Migration ─────────────────")
    print(f" Parquet dir : {PARQUET_DIR}")
    print(f" Symbols     : {[s for _, s in targets]}")
    print(f" Mode        : {'DRY RUN' if dry_run else ('replace' if replace else 'upsert')}")
    print(f"──────────────────────────────────────────────────────────────────\n")

    conn = get_connection()
    existing = get_existing_counts(conn)
    existing_max_ts = get_existing_max_ts(conn)

    total_inserted = 0

    for path, symbol in targets:
        print(f"[{symbol}] Loading {path.name} …")
        t0 = time.perf_counter()
        df = load_parquet(path, symbol)
        elapsed_load = time.perf_counter() - t0

        size_mb = path.stat().st_size / 1024 / 1024
        start_dt = df["ts"].min().strftime("%Y-%m-%d")
        end_dt = df["ts"].max().strftime("%Y-%m-%d")

        print(f" {len(df):>10,} bars | {start_dt} → {end_dt} | {size_mb:.1f} MB | loaded in {elapsed_load:.1f}s")

        delta_df = df
        latest_ts = existing_max_ts.get(symbol)
        if latest_ts is not None and not replace:
            # Include the latest known timestamp so ON CONFLICT can refresh it if
            # Databento ever re-emits the final stored bar with corrected values.
            delta_df = df[df["ts"] >= latest_ts].copy()
            if delta_df.empty:
                print(f" {existing[symbol]:,} rows already in DB — no newer bars found")
                continue
            delta_start = delta_df["ts"].min().strftime("%Y-%m-%d %H:%M")
            delta_end = delta_df["ts"].max().strftime("%Y-%m-%d %H:%M")
            print(f" Preparing incremental load: {len(delta_df):,} candidate bars from {delta_start} → {delta_end}")

        if dry_run:
            if replace:
                print(f" [DRY RUN] Would replace with {len(df):,} rows")
            else:
                print(f" [DRY RUN] Would merge {len(delta_df):,} rows")
            continue

        print(f" Inserting via COPY …", end="", flush=True)
        t1 = time.perf_counter()
        inserted = copy_to_db(conn, delta_df, symbol, replace=replace)
        elapsed_insert = time.perf_counter() - t1
        rate = inserted / elapsed_insert if elapsed_insert > 0 else 0
        print(f" {inserted:,} rows merged in {elapsed_insert:.1f}s ({rate:,.0f} rows/s)")

        total_inserted += inserted

    if conn:
        conn.close()

    print(f"\n── Done ──────────────────────────────────────────────────────────")
    if not dry_run:
        print(f" Total rows inserted: {total_inserted:,}")
    print()


def parse_args():
    p = argparse.ArgumentParser(description="Migrate Databento parquet → TimescaleDB")
    p.add_argument("--symbols", "-s", nargs="+", metavar="SYM",
                   help="Only migrate these symbols (e.g. NQ ES). Default: all.")
    p.add_argument("--dry-run", action="store_true",
                   help="Print what would happen without touching the DB.")
    p.add_argument("--replace", action="store_true",
                   help="Delete existing rows for a symbol before inserting.")
    return p.parse_args()


if __name__ == "__main__":
    args = parse_args()
    migrate(
        symbols_filter=args.symbols,
        dry_run=args.dry_run,
        replace=args.replace,
    )
