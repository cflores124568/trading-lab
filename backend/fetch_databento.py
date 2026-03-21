#!/usr/bin/env python3
'''Helper for fetching, saving, and incrementally updating OHLCV-1m futures data from Databento

#Supported tickers (all on GLBX.MDP3 / CME Globex): NQ, MNQ, ES, MES, GC, MGC

# Usage
# Warning! Check cost before fetching anything... especially in this economy
    #python fetch_databento.py --check-cost --start 2024-01-01

#First time: Fetch once costs are verified:
#       python fetch_databento.py --start 2024-01-01

# Incremental update picks up from last stored bar automatically:
#       python fetch_databento.py --update

# Pull a specific date range:
#       python fetch_databento.py --start 2024-06-01 --end 2024-12-31

# Pull only certain symbols:
#       python fetch_databento.py --update --symbols NQ MNQ GC

# Setup
    pip install databento pandas pyarrow

    Either set your API key as an environment variable:
        export DATABENTO_API_KEY="db-xxxxxxxxxxxx"

    Or pass it directly:
        python fetch_databento.py --update --api-key db-xxxxxxxxxxxx
'''

import argparse
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
import pandas as pd

#Constants
DATASET = "GLBX.MDP3"      #CME Globex captures NQ, MNQ, ES, MES, GC, MGC
SCHEMA = "ohlcv-1m"
STYPE_IN = "continuous"      

#All 6 tickers. Continuous symbology: NQ.c.0 = front-month NQ, etc.
DEFAULT_SYMBOLS = ["NQ.c.0", "MNQ.c.0", "ES.c.0", "MES.c.0", "GC.c.0", "MGC.c.0"]

#One parquet file per symbol facilitates individual loads
DATA_DIR = Path(__file__).parent / "data" / "futures_1m"
COST_CAP_USD = 40.0  #abort if a single fetch costs more than this... 
FALLBACK_START = "2024-01-01T00:00:00"

#Helpers
def parquet_path(symbol: str) -> Path:
    """Return local parquet path for a given symbol slug (e.g. 'NQ.c.0')."""
    safe = symbol.replace(".", "_")   # NQ.c.0 -> NQ_c_0
    return DATA_DIR / f"{safe}.parquet"


def get_last_stored_ts(symbol: str) -> str:
    """
    Return the ISO timestamp of the last stored bar for a symbol.
    Falls back to FALLBACK_START if no data exists yet.
    """
    path = parquet_path(symbol)
    if not path.exists():
        return FALLBACK_START

    df = pd.read_parquet(path, columns=["ts_event"])
    if df.empty:
        return FALLBACK_START

    last = pd.to_datetime(df["ts_event"]).max()
    # Add 1 minute so we don't re-fetch the last bar on the next pull
    last_plus_one = last + pd.Timedelta(minutes=1)
    return last_plus_one.strftime("%Y-%m-%dT%H:%M:%S")


def load_client(api_key: str | None):
    """Import databento and return an authenticated Historical client."""
    try:
        import databento as db
    except ImportError:
        print("ERROR: databento not installed. Run: pip install databento")
        sys.exit(1)

    key = api_key or os.environ.get("DATABENTO_API_KEY")
    if not key:
        print(
            "ERROR: No API key found.\n"
            "Set DATABENTO_API_KEY environment variable or pass --api-key."
        )
        sys.exit(1)

    return db.Historical(key)


def check_cost(client, symbols: list[str], start: str, end: str) -> float:
    """
    Query Databento's cost estimate API and print a breakdown.
    Returns the total estimated cost in USD.
    """
    print(f"\n── Cost check ───────────────────────────────────────────")
    print(f"  Dataset  : {DATASET}")
    print(f"  Schema   : {SCHEMA}")
    print(f"  Symbols  : {symbols}")
    print(f"  Start    : {start}")
    print(f"  End      : {end}")
    print(f"─────────────────────────────────────────────────────────")

    try:
        cost = client.metadata.get_cost(
            dataset = DATASET,
            schema = SCHEMA,
            symbols = symbols,
            stype_in = STYPE_IN,
            start = start,
            end = end,
        )
    except Exception as e:
        print(f"ERROR fetching cost estimate: {e}")
        sys.exit(1)

    print(f"  Estimated cost : ${cost:.4f} USD")
    print(f"  Safety cap     : ${COST_CAP_USD:.2f} USD")

    if cost > COST_CAP_USD:
        print(f"\n   Cost exceeds safety cap of ${COST_CAP_USD:.2f}.")
        print(f"     Raise COST_CAP_USD in this script if you want to proceed.")
    else:
        print(f"\n   Cost is within cap. Safe to pull.")

    return cost


def fetch_and_save(
    client,
    symbols:list[str],
    start: str,
    end: str,
    dry_run: bool = False,
) -> None:
    """
    Fetch OHLCV-1m data for all symbols in one API call, then split by
    symbol and save/append to individual parquet files.

    Databento returns all symbols interleaved in a single response —
    we split on the 'symbol' column after converting to DataFrame.
    """
    cost = check_cost(client, symbols, start, end)

    if dry_run:
        print("\n  Dry run — skipping actual fetch.")
        return

    if cost > COST_CAP_USD:
        print("\nAborting fetch due to cost cap. Use --check-cost to investigate.")
        sys.exit(1)

    if cost == 0.0:
        print("\nNothing new to fetch (cost = $0.00). Already up to date.")
        return

    print(f"\nFetching data...")

    try:
        store = client.timeseries.get_range(
            dataset = DATASET,
            schema = SCHEMA,
            symbols = symbols,
            stype_in = STYPE_IN,
            start = start,
            end = end,
        )
    except Exception as e:
        print(f"ERROR during fetch: {e}")
        sys.exit(1)

    # Convert to DataFrame  prices arrive as fixed-point int64 (÷1e9 = dollars)
    # map_symbols=True adds a human-readable 'symbol' column (e.g. 'NQ') alongside instrument_id
    df = store.to_df(
        price_type = "fixed",     # keep as float — databento-python handles ÷1e9
        map_symbols = True,
        tz = "America/New_York",
    )

    if df.empty:
        print("No data returned for the requested range.")
        return

    df.columns = df.columns.str.lower()

    # ts_event is the index after to_df() reset so we can work with it
    df = df.reset_index()

    #Strip timezone info since tz-sensitive datetimes can cause issues with some pandas ops
    df["ts_event"] = pd.to_datetime(df["ts_event"]).dt.tz_localize(None)

    keep = ["ts_event", "open", "high", "low", "close", "volume", "symbol"]
    df = df[[c for c in keep if c in df.columns]]

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    #Split by symbol and save/append individually
    fetched_symbols = df["symbol"].unique()
    print(f"\nSaving {len(df):,} bars across {len(fetched_symbols)} symbol(s)...\n")

    for sym in fetched_symbols:
        sym_df = df[df["symbol"] == sym].copy()
        path = parquet_path(sym + ".c.0") if not sym.endswith(".c.0") else parquet_path(sym)

        if path.exists():
            existing = pd.read_parquet(path)
            existing["ts_event"] = pd.to_datetime(existing["ts_event"])
            combined = (pd.concat([existing, sym_df]).drop_duplicates(subset=["ts_event"]).sort_values("ts_event").reset_index(drop=True))
        else:
            combined = sym_df.sort_values("ts_event").reset_index(drop=True)

        combined.to_parquet(path, index=False)

        start_dt = combined["ts_event"].min().strftime("%Y-%m-%d")
        end_dt = combined["ts_event"].max().strftime("%Y-%m-%d")
        size_mb = path.stat().st_size / 1024 / 1024

        print(
            f"  {sym:<6}  {len(combined):>8,} bars  "
            f"{start_dt} → {end_dt}  "
            f"({size_mb:.2f} MB)  → {path}"
        )

    print(f"\n✓ Done. Total cost this pull: ${cost:.4f} USD")


#CLI 
def parse_args():
    p = argparse.ArgumentParser(
        description="Fetch and incrementally update Databento OHLCV-1m futures data.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    p.add_argument(
        "--api-key", "-k",
        default=None,
        help="Databento API key. Falls back to DATABENTO_API_KEY env var.",
    )
    p.add_argument(
        "--symbols", "-s",
        nargs="+",
        default=None,
        metavar="SYM",
        help=(
            "Space-separated list of base symbols to fetch. "
            "e.g. --symbols NQ MNQ GC  "
            "Defaults to all 6: NQ MNQ ES MES GC MGC"
        ),
    )
    p.add_argument(
        "--start",
        default=None,
        help="Start date/datetime (ISO 8601). e.g. 2024-01-01 or 2024-01-01T09:30:00",
    )
    p.add_argument(
        "--end",
        default=None,
        help="End date/datetime (ISO 8601). Defaults to now.",
    )
    p.add_argument(
        "--update", "-u",
        action="store_true",
        help=(
            "Incremental update mode. Reads the last stored timestamp per symbol "
            "and fetches only new bars. Ignores --start."
        ),
    )
    p.add_argument(
        "--check-cost",
        action="store_true",
        help="Only estimate cost — do not fetch any data.",
    )
    p.add_argument(
        "--cost-cap",
        type=float,
        default=COST_CAP_USD,
        metavar="USD",
        help=f"Abort if estimated cost exceeds this amount. Default: ${COST_CAP_USD:.2f}",
    )
    p.add_argument(
        "--list",
        action="store_true",
        help="List all locally stored datasets and exit.",
    )
    return p.parse_args()


def list_local_data():
    """Print a summary of all locally stored parquet files."""
    if not DATA_DIR.exists() or not any(DATA_DIR.glob("*.parquet")):
        print("No local data found. Run a fetch first.")
        return

    print(f"\n── Local datasets ({DATA_DIR}) ──────────────────────────")
    print(f"  {'Symbol':<10} {'Bars':>10} {'Start':>12} {'End':>12} {'Size':>8}")
    print(f"  {'-'*10} {'-'*10} {'-'*12} {'-'*12} {'-'*8}")

    total_bars  = 0
    total_bytes = 0

    for path in sorted(DATA_DIR.glob("*.parquet")):
        df = pd.read_parquet(path)
        sym = path.stem.replace("_c_0", "").upper()
        bars = len(df)
        start_dt = pd.to_datetime(df["ts_event"]).min().strftime("%Y-%m-%d")
        end_dt = pd.to_datetime(df["ts_event"]).max().strftime("%Y-%m-%d")
        size_mb = path.stat().st_size / 1024 / 1024

        print(f"  {sym:<10} {bars:>10,} {start_dt:>12} {end_dt:>12} {size_mb:>7.2f}MB")
        total_bars += bars
        total_bytes += path.stat().st_size

    print(f"  {'─'*56}")
    print(f"  {'TOTAL':<10} {total_bars:>10,} {'':>12} {'':>12} {total_bytes/1024/1024:>7.2f}MB")
    print()


def main():
    global COST_CAP_USD

    args = parse_args()
    COST_CAP_USD = args.cost_cap

    if args.list:
        list_local_data()
        return

    #Resolve symbols
    if args.symbols:
        #If user passed base symbols like "NQ MNQ" append .c.0 for continuous
        symbols = [
            s if s.endswith(".c.0") else f"{s}.c.0"
            for s in args.symbols
        ]
    else:
        symbols = DEFAULT_SYMBOLS

    #Resolve date range 
    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
    end = args.end or yesterday
    if args.update:
        # Per-symbol incremental: find the oldest "last stored" date across requested symbols and use that as the global start.
        # Each symbol's data will be deduplicated on merge anyway so over-fetching slightly on the already-up-to-date ones is fine and cheaper than N separate calls.
        starts = [get_last_stored_ts(sym) for sym in symbols]
        start  = min(starts)   # earliest gap = where we need to start fetching
        print(f"Incremental update mode.")
        print(f"Fetching from {start} → {end}")
    else:
        start = args.start or FALLBACK_START

    client = load_client(args.api_key)
    fetch_and_save(client=client, symbols=symbols, start=start, end=end, dry_run=args.check_cost)

if __name__ == "__main__":
    main()