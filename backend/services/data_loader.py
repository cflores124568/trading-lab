import io
import uuid
from datetime import datetime
from pathlib import Path
import numpy as np
import pandas as pd
from services.dataset_store import dataset_store
import yfinance as yf
from fastapi import HTTPException

_PARQUET_DIR = Path(__file__).resolve().parent.parent / "data" / "futures_1m"
REQUIRED_COLUMNS = {"open", "high", "low", "close", "volume"}
# Canonical interval strings used in backend

VALID_INTERVALS: set[str] = {"1min", "5min", "10min", "15min", "30min", "1h", "4h", "1d", "1w"} #All values must also appear in RESAMPLE_RULES
# Map frontend Interval.value aliases canonical backend string
# constants.ts uses short aliases (value="1m") for URLs/selectors but sends
# resampleRule ("1min") to the API.  Accept both so neither the router nor
# the frontend has to do any translation.
_NORMALISE_INTERVAL: dict[str, str] = {
    # Short aliases -> canonical 
    "1m": "1min",
    "5m": "5min",
    "10m": "10min",
    "15m": "15min",
    "30m": "30min",
    #Already canonical since identity entries always let normalise() succeed
    "1min": "1min",
    "5min": "5min",
    "10min": "10min",
    "15min": "15min",
    "30min": "30min",
    "1h": "1h",
    "4h": "4h",
    "1d": "1d",
    "1w": "1w",
    #yfinance alias used by LIVE_CHART_INTERVALS
    "1wk": "1w",
}
# Pandas resample frequendcy string for each canonical intergal
_RESAMPLE_RULES: dict[str, str] = {
    "1min": "1min",
    "5min": "5min",
    "10min": "10min",
    "15min": "15min",
    "30min": "30min",
    "1h": "1h",
    "4h": "4h",
    # "1d" and "1w" use session-aware groupby (see resample_ohlcv), not this map,
    # but they're included so VALID_INTERVALS stays the single source of truth.
    "1d": "1D",
    "1w": "1W-MON"
}

# Databento continuous contract -> human readable contract
# Mirrors DATABENTO_SYMBOLS in frontend/src/constants.ts.
# GC is included even though it's missing data, Databento Comex/Globex issue
# load_parquet will still work, the user just gets fewer bars than expected.
_PARQUET_SYMBOLS: dict[str, str] = {
    "NQ_c_0": "NQ",
    "MNQ_c_0": "MNQ",
    "ES_c_0": "ES",
    "MES_c_0": "MES",
    "GC_c_0": "GC",
    "MGC_c_0": "MGC"
}

FUTURES_SYMBOLS = { #yfinance tickers for live chart only, not backtesting
    "NQ": "NQ=F",
    "MNQ": "MNQ=F",
    "ES": "ES=F",
    "MES": "MES=F",
    "GC": "GC=F",
    "MGC": "MGC=F",
}

FREQ_MAP = {
    "1min":  "1min",
    "5min":  "5min",
    "10min": "10min",
    "15min": "15min",
    "30min": "30min",
    "1h": "1h",
    "4h": "4h",
    # 1d and 1w intentionally excluded; generate_sample_data produces 1-min bars,
    # callers resample themselves via resample_ohlcv if they want bigger bars.
}

def normalise_interval(raw: str) -> str:
    """Translate any interval string the frontend might send into the canonical backend form.
 
    Accepts both short aliases like `"1m"`, `"15m"` and the canonical forms like `"1min"`,
    `"15min"`, plus yfinance quirks like `"1wk"`. Raises ValueError for anything unknown
    so bad input fails loudly instead of silently doing nothing.
    """
    canonical = _NORMALISE_INTERVAL.get(raw)
    if canonical is None:
        raise ValueError(
            f"Unkown interval `{raw}`."
            f"Valid values: {sorted(_NORMALISE_INTERVAL)}"
        )
    return canonical

#Lazy import to keep dataset_store import at call time so works regadless of import location
def _store():
    try:
        from services.dataset_store import dataset_store
    except ImportError:
        from dataset_store import dataset_store
    return dataset_store

#Internal helpers
def _extract_arrays(df: pd.DataFrame) -> dict:
    """Pull OHLCV columns out as contiguous float64 numpy arrays.
 
    Pre-extracting these avoids repeated `.to_numpy()` calls later and
    gives the C++ kernel the memory layout it wants; no copies at call time.
    """
    return {    #Convert candle columns to numpy arrays to avoid repeated function calls from indicators 
        "open": np.ascontiguousarray(df["open"].to_numpy(np.float64)), #Force float64 and continguos memory for quicker C++
        "high": np.ascontiguousarray(df["high"].to_numpy(np.float64)),
        "low": np.ascontiguousarray(df["low"].to_numpy(np.float64)), 
        "close": np.ascontiguousarray(df["close"].to_numpy(np.float64)),
        "volume": np.ascontiguousarray(df["volume"].to_numpy(np.float64)),
    }

def _store_dataset(df: pd.DataFrame, name: str, source: str="parquet") -> dict:
    dataset_id = str(uuid.uuid4())
    info = {
        "dataset_id": dataset_id,
        "name": name,
        "rows": len(df),
        "columns": list(df.columns),
        "start_date": df.index.min().isoformat(),
        "end_date": df.index.max().isoformat(),
        "uploaded_at": datetime.utcnow().isoformat(),
        "source": source
    }
    _store()[dataset_id] = {
        "info": info,
        "df": df,
        "arrays": _extract_arrays(df)
    }
    return info

#OHLCV resampler
def resample_ohlcv(df: pd.DataFrame, interval: str) -> pd.DataFrame:
    """Resample 1-minute OHLCV DataFrame to longer intervals up to weekly 

    Accepts aliases like `"1m"` or canonical strings like `"1min"` — both work fine.
    Intraday intervals use pandas resample. Daily and weekly use session-aware groupby
    instead because `resample("1D")` spans midnight-to-midnight, which drags in the
    overnight session and gives you wrong OHLC for futures. Grouping by calendar date
    fixes that. Incomplete bars at the head/tail (too few source 1-min bars) get dropped
    so you don't end up with stub candles messing up your indicators.
    """
    interval = normalise_interval(interval)

    agg_funcs: dict[str, str] = {
        "open": "first",
        "high": "max",
        "low": "min",
        "close": "last",
        "volume": "sum"
    }
    # Used vectorized .agg(dict) from day 1 instead of .apply() or manual loops
    # because preprocessing years of 1m futures data needs to be instant
    # The real speed bottleneck is my C++ kernel anyway this just keeps Python out of the way.   
    agg={k: v for k, v in agg_funcs.items() if k in df.columns}

    #  Daily and weekly: session-aware groupby 
    # constants.ts marks these as resampleRule: null because a plain
    # pd.resample("1D") creates bars that span midnight→midnight, which
    # includes the overnight session and gives wrong OHLC for futures.
    # Grouping by calendar date instead respects RTH session boundaries.
    if interval in ("1d", "1w"):
        min_bars = 30 if interval == "1d" else 100

        if interval == "1d":
            group_key = df.index.date   #Calendar date of each 1m bar
        else:
            group_key = df.index.to_series().dt.to_period("W").dt.start_time.values #ISO week start (Monday) for each bar
        
        grouped = df.groupby(group_key)
        bar_counts = grouped["close"].count()

        resampled_rows = []
        for period, grp in grouped:
            if bar_counts[period] < min_bars:
                continue #drop incomplete sessions at head/tail
            resampled_rows.append({
                "date": pd.Timestamp(period),
                "open": grp["open"].iloc[0] if "open" in grp else float("nan"),
                "high": grp["high"].max() if "high" in grp else float("nan"),
                "low": grp["low"].min()   if "low" in grp else float("nan"),
                "close": grp["close"].iloc[-1] if "close"  in grp else float("nan"),
                "volume": grp["volume"].sum()  if "volume" in grp else 0.0,
            })
 
        if not resampled_rows:
            return pd.DataFrame(columns=list(agg.keys()))
 
        out = pd.DataFrame(resampled_rows).set_index("date")
        out.index.name = "date"
        return out[list(agg.keys())]
 
    # Intraday: standard pandas resample 
    rule = _RESAMPLE_RULES[interval]
    resampled = df.resample(rule).agg(agg)
    resampled.dropna(subset=["close"], inplace=True)
    return resampled

#Parquet loader for Databento 
def list_parquet_symbols() -> list[dict]:
    """Scan the parquet directory and return metadata for each futures dataset.

    Each file corresponds to a Databento continuous contract (e.g. "NQ_c_0").
    The returned metadata includes:

    - symbol_key: canonical dataset identifier (e.g. "NQ_c_0")
    - symbol: human-readable symbol (e.g. "NQ")
    - path: file location
    - rows: number of bars
    - start_date / end_date: timestamp range
    - size_mb: file size

    Only the `ts_event` column is read so the scan remains fast even with
    multi-million-row parquet files.
    """
    if not _PARQUET_DIR.exists():
        return []
 
    results = []
    for path in sorted(_PARQUET_DIR.glob("*.parquet")):
        slug = path.stem                            # "NQ_c_0"
        label = _PARQUET_SYMBOLS.get(slug, slug)    # "NQ"
 
        try:
            # Read only the timestamp column to get range without loading all data
            meta_df = pd.read_parquet(path, columns=["ts_event"])
            ts = pd.to_datetime(meta_df["ts_event"])
            results.append({
                "slug": slug,
                "symbol": label,
                "path": str(path),
                "rows": len(meta_df),
                "start_date": ts.min().isoformat(),
                "end_date": ts.max().isoformat(),
                "size_mb": round(path.stat().st_size / 1024 / 1024, 2),
            })
        except Exception as exc:
            # Surface a warning but don't crash the whole list
            results.append({
                "slug": slug,
                "symbol": label,
                "path": str(path),
                "error": str(exc),
            })
 
    return results

def load_parquet(
    symbol: str,
    interval: str  = "1min",
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict:
    """Load a Databento parquet dataset for a futures symbol.

    Accepts either the short symbol ("NQ", "ES") or the canonical dataset key
    ("NQ_c_0"). The loader:

    - normalises Databento timestamps (`ts_event`) to `date`
    - removes timezone information
    - drops unused columns
    - validates required OHLCV fields
    - optionally slices by date range
    - resamples to larger intervals if requested

    The dataset is registered in `dataset_store` and a DatasetInfo
    metadata dict is returned.
    """
    # Resolve user symbol -> canoncial parquet dataset key
    # Accept either "NQ" or "NQ_c_0"
    symbol_key = symbol if symbol.endswith("_c_0") else f"{symbol}_c_0"
 
    # Validate it's a symbol we know about
    known_symbol_keys = set(_PARQUET_SYMBOLS.keys())
    if symbol_key not in known_symbol_keys:
        valid = [_PARQUET_SYMBOLS[s] for s in known_symbol_keys]
        raise ValueError(
            f"Unknown symbol '{symbol}'. Valid symbols: {valid}"
        )
 
    path = _PARQUET_DIR / f"{symbol_key}.parquet"
    if not path.exists():
        raise FileNotFoundError(
            f"Parquet file not found for '{symbol}' at {path}. "
            "Run fetch_databento.py to download data first."
        )
 
    # Accept both canonical ("1min") and short alias ("1m") forms
    interval = normalise_interval(interval)
 
    # Read parquet 
    df = pd.read_parquet(path)
 
    # Databento stores the bar timestamp in 'ts_event'; normalise to 'date'
    if "ts_event" in df.columns:
        df["ts_event"] = pd.to_datetime(df["ts_event"])
        df.set_index("ts_event", inplace=True)
        df.index.name = "date"
    elif "date" in df.columns:
        df["date"] = pd.to_datetime(df["date"])
        df.set_index("date", inplace=True)
    else:
        # Fallback: assume the index is already a DatetimeIndex
        df.index = pd.to_datetime(df.index)
        df.index.name = "date"
 
    # Drop tz info for consistent downstream behaviour
    if df.index.tz is not None:
        df.index = df.index.tz_localize(None)
 
    # Column normalisation 
    df.columns = df.columns.str.lower()
 
    # Databento OHLCV-1m columns are already open/high/low/close/volume.
    # Drop any extra columns (symbol, instrument_id, etc.) we don't need.
    ohlcv_cols = [c for c in ["open", "high", "low", "close", "volume"] if c in df.columns]
    df = df[ohlcv_cols].copy()
 
    missing = REQUIRED_COLUMNS - set(df.columns)
    if missing:
        raise ValueError(
            f"Parquet file for '{symbol}' is missing required columns: {missing}"
        )
 
    # Cast to float64 for C++/NumPy safety
    df[list(REQUIRED_COLUMNS)] = df[list(REQUIRED_COLUMNS)].astype(np.float64)
 
    # Sort & deduplicate
    df.sort_index(inplace=True)
    if df.index.duplicated().any():
        df = df[~df.index.duplicated(keep="last")]
 
    # Slice dates
    if start_date:
        df = df.loc[start_date:]
    if end_date:
        df = df.loc[:end_date]
 
    if df.empty:
        raise ValueError(
            f"No data for '{symbol}' in the requested date range "
            f"({start_date or 'start'} → {end_date or 'end'})."
        )
 
    # Resample if trading intervals > 1m
    if interval != "1min":
        df = resample_ohlcv(df, interval)
 
    if df.empty:
        raise ValueError(
            f"Resampling to '{interval}' produced an empty DataFrame. "
            "Try a wider date range."
        )
 
    # Register & return 
    label = _PARQUET_SYMBOLS.get(symbol_key, symbol)
    name = f"{label} {interval} (Databento)"
    return _store_dataset(df, name=name, source="databento")

def get_candles(
    dataset_id: str,
    interval: str = "1min",
    start_date: str | None = None,
    end_date: str | None = None,
    limit: int | None = None,
) -> list[dict]:
    """Fetch bars from a loaded dataset in Lightweight Charts expected format
 
    Returns a list of `{ time, open, high, low, close, volume }` dicts where `time`
    is unix seconds, what the chart library wants, not ISO strings. Slices by
    date first, then resamples on the fly if the requested interval is bigger than the
    stored resolution, then applies `limit` to cap the response to the most recent N bars.
    Nothing gets stored, it's just a read + reshape.
    """
    dataset = get_dataset(dataset_id)
    df = dataset["df"].copy()
 
    # Normalise interval alias before any resampling
    if interval:
        interval = normalise_interval(interval)
 
    if start_date:
        df = df.loc[start_date:]
    if end_date:
        df = df.loc[:end_date]
 
    if interval not in ("1min", None):
        df = resample_ohlcv(df, interval)
 
    if limit is not None and limit > 0:
        df = df.tail(limit)
 
    # Convert DatetimeIndex to unix seconds per Lightweight Charts needs
    df = df.reset_index()
    time_col = df.columns[0]                        # 'date' or 'ts_event'
    df[time_col] = pd.to_datetime(df[time_col])
 
    records = []
    for row in df.itertuples(index=False):
        ts = getattr(row, time_col)
        records.append({
            "time": int(ts.timestamp()),
            "open": round(float(row.open), 2),
            "high": round(float(row.high), 2),
            "low":  round(float(row.low), 2),
            "close": round(float(row.close), 2),
            "volume": int(row.volume),
        })
 
    return records
 
def fetch_yfinance_intraday(
        symbol_key: str, 
        interval: str="5m",
        period: str ="60d"
    ) -> tuple[pd.DataFrame, dict]:
    """Pull recent OHLCV bars from Yahoo Finance for a supported futures symbol.
 
    Only useful for the live chart preview. yfinance tickers like `"NQ=F"` aren't
    valid for backtesting. 
    Flattens the MultiIndex yfinance ≥0.2 sometimes returns,normalises column names 
    to lowercase and returns the DataFrame plus a metadata dict.
    Raises HTTPException (not ValueError) so FastAPI can surface it cleanly.
    """
    if symbol_key not in FUTURES_SYMBOLS:
        raise HTTPException(400, f"Unsupported symbol: {symbol_key}. Use: {list(FUTURES_SYMBOLS.keys())}")
    
    ticker = FUTURES_SYMBOLS[symbol_key]
    try:
        raw = yf.download(
            tickers=ticker,
            period=period,
            interval=interval,
            progress=False,
            repair=True,
            auto_adjust=True,
            prepost=False
        )
        if raw.empty:
            raise ValueError("No data returned from Yahoo Finance!")
        # yfinance >= 0.2 may return a MultiIndex so flatten it
        if isinstance(raw.columns, pd.MultiIndex):
            raw.columns = raw.columns.get_level_values(0)
        df = raw[["Open", "High", "Low", "Close", "Volume"]].copy()
        df.index.name = "timestamp"
        df.reset_index(inplace=True)
        df["timestamp"] = df["timestamp"].dt.strftime("%Y-%m-%d %H:%M:%S")
        metadata = {
            "source": "yfinance",
            "symbol": ticker,
            "interval": interval,
            "fetched_at": datetime.utcnow().isoformat(),
            "rows": len(df),
        }
        return df, metadata
    except Exception as e:
        raise HTTPException(503, f"yfinance fetch failed: {str(e)}")

def load_csv(file_bytes: bytes, name: str) -> dict:
    """Parse raw CSV bytes into a validated OHLCV dataset and register it in the store.
 
    Handles messy real-world CSVs — trims column names, coerces dates and numerics with
    `errors='coerce'` so bad rows fail loudly with a count instead of silently dropping.
    Also checks for high < low and negative volume since those will silently destroy
    backtest results if they slip through. Returns the same DatasetInfo dict shape as
    every other loader.
    """
    if not file_bytes:
        raise ValueError("File is empty.")
    if not name or not name.strip():
        raise ValueError("Dataset name cannot be empty.")

    try:
        buf = io.BytesIO(file_bytes)
        header = pd.read_csv(buf, nrows=0)
        buf.seek(0)  #rewind so we can read the full file next
    except Exception as e:
        raise ValueError(f"Failed to read CSV file: {e}") from e

    cols = header.columns.str.strip().str.lower()
    if cols.empty:
        raise ValueError("CSV file has no columns.")

    date_col = next((c for c in ["date", "datetime"] if c in cols), None)

    try:
        df = pd.read_csv(buf, parse_dates=[date_col] if date_col else [])
    except Exception as e:
        raise ValueError(f"Failed to parse CSV: {e}") from e

    #Normalize again on full df since read_csv doesn't inherit our earlier header inspection
    df.columns = df.columns.str.strip().str.lower()

    if df.empty:
        raise ValueError("CSV file contains no data rows.")

    missing = REQUIRED_COLUMNS - set(df.columns)
    if missing:
        raise ValueError(f"CSV missing required columns: {missing}. Expected: {REQUIRED_COLUMNS}")

    if "date" not in df.columns and "datetime" not in df.columns:
        raise ValueError("CSV needs a 'date' or 'datetime' column.")

    #errors='coerce' turns unparseable dates into NaT, so we can count bad rows 
    time_col = "date" if "date" in df.columns else "datetime"
    df[time_col] = pd.to_datetime(df[time_col], errors='coerce')

    invalid_dates = df[time_col].isna().sum()
    if invalid_dates == len(df):
        raise ValueError(f"Column '{time_col}' contains no valid dates.")
    if invalid_dates > 0:
        raise ValueError(
            f"Column '{time_col}' contains {invalid_dates} unparseable date(s). "
            "Ensure all rows have a valid date/datetime value."
        )

    #Same coerce method for numeric columns to turn bad values into NaN 
    for col in REQUIRED_COLUMNS:
        df[col] = pd.to_numeric(df[col], errors='coerce')
        bad_rows = df[col].isna().sum()
        if bad_rows == len(df):
            raise ValueError(f"Column '{col}' contains no valid numeric values.")
        if bad_rows > 0:
            raise ValueError(
                f"Column '{col}' contains {bad_rows} non-numeric value(s). "
                "All OHLCV columns must be numeric."
            )
        
    # Use float64 to prevent hidden conversipns when passing arrays to numpy or C++
    df[list(REQUIRED_COLUMNS)] = df[list(REQUIRED_COLUMNS)].astype(np.float64)

    if (df["high"] < df["low"]).any():
        raise ValueError("Data integrity error: some 'high' values are less than 'low' values.")
    if (df["volume"] < 0).any():
        raise ValueError("Data integrity error: 'volume' column contains negative values.")

    df.set_index(time_col, inplace=True)
    df.sort_index(inplace=True)

    # Duplicate timestamps would cause subtle bugs in backtesting and indicator calculations
    if df.index.duplicated().any():
        dupe_count = df.index.duplicated().sum()
        raise ValueError(
            f"Timestamp index contains {dupe_count} duplicate(s). "
            "Each row must have a unique timestamp."
        )
    
    return _store_dataset(df, name=name, source="csv")

def generate_sample_data(
    name: str = "NQ_sample_1min",
    bars: int = 2000,
    interval: str = "1min",
    base_price: float = 20500.0,
    seed: int = 42,
) -> dict:
    """Generate synthetic OHLCV bars using GBM with a bit of mean reversion.
 
    Seeded so the same inputs always produce the same data — keeps tests reproducible.
    Uses `bdate_range` so you don't get weekend bars. The mean reversion term stops
    prices from drifting too far from `base_price` over long runs. Good enough for
    strategy smoke tests; not a real market simulator.
    """
    if not name or not name.strip():
        raise ValueError("Dataset name cannot be empty.")
    if not isinstance(bars, int) or bars < 2:
        raise ValueError(f"'bars' must be an integer >= 2, got {bars!r}.")
    if bars > 1_000_000:
        raise ValueError(f"'bars' exceeds maximum allowed value of 1,000,000 (got {bars}).")
    if interval not in FREQ_MAP:
        raise ValueError(f"Invalid interval '{interval}'. Must be one of: {list(FREQ_MAP)}.")
    if not isinstance(base_price, (int, float)) or base_price <= 0:
        raise ValueError(f"'base_price' must be a positive number, got {base_price!r}.")
    if not isinstance(seed, int) or seed < 0:
        raise ValueError(f"'seed' must be a non-negative integer, got {seed!r}.")

    # Seeded RNG means the same inputs always produce the same data to keeps tests reproducible
    rng = np.random.default_rng(seed)
    freq = FREQ_MAP.get(interval, "1min")
    dates = pd.bdate_range(start="2024-01-02 09:30", periods=bars, freq=freq)

    #GBM (Geometric Brownian Motion), standard model for simulating asset prices
    # Added a small mean-reversion term so prices don't drift too far from base price
    dt = 1.0 / (bars / 5)   # time step — smaller = smoother simulation
    vol = 0.22               #annualized volatility (~22%, typical for NQ)
    drift = 0.08             #annualized drift (~8% upward trend)
    mean_rev = 0.025         #how strongly prices are pulled back toward base_price

    prices = np.zeros(bars)
    prices[0] = base_price

    for i in range(1, bars):
        dW = rng.normal(0, np.sqrt(dt))  # random shock at each time step
        revert = mean_rev * (base_price - prices[i - 1]) * dt
        prices[i] = prices[i - 1] * np.exp((drift - 0.5 * vol**2) * dt + vol * dW) + revert

    #Extreme parameter changes could theoretically break the simulation, so we validate output
    if not np.all(np.isfinite(prices)):
        raise RuntimeError("Price simulation produced non-finite values (NaN or Inf). Check simulation parameters.")
    if np.any(prices <= 0):
        raise RuntimeError("Price simulation produced zero or negative prices. Check simulation parameters.")

    #Derive OHLC by adding small noise around the close; real bars deviate from close by small amounts
    noise_range = prices * 0.0025
    highs = prices + rng.uniform(0, 1, bars) * noise_range
    lows  = prices - rng.uniform(0, 1, bars) * noise_range
    opens = prices + rng.normal(0, 0.5, bars) * noise_range
    volume = rng.integers(800, 120_000, size=bars).astype(float)

    df = pd.DataFrame(
        {"open": opens, "high": highs, "low": lows, "close": prices, "volume": volume},
        index=dates,
    )
    df.index.name = "date"

    return _store_dataset(df, name=name, source="synthetic")

def get_dataset(dataset_id: str) -> dict:
    """Look up a dataset by ID and return the full store entry (info + df + arrays).
 
    Raises KeyError if the ID doesn't exist — callers (routers) catch that and return 404.
    """
    if not dataset_id or not isinstance(dataset_id, str):
        raise ValueError("'dataset_id' must be a non-empty string.")
    store = _store()
    if dataset_id not in store:
        raise KeyError(f"Dataset '{dataset_id}' not found.")
    return store[dataset_id]


def list_datasets() -> list[dict]:
    #Return DatasetInfo dict for every dataset in memory
    return [v["info"] for v in _store().values()]