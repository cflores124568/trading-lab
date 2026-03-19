import io
import uuid
from datetime import datetime
import numpy as np
import pandas as pd
from services.dataset_store import dataset_store
import yfinance as yf
from fastapi import HTTPException

#The columns every OHLCV dataset must have to be usable by our strategies
REQUIRED_COLUMNS = {"open", "high", "low", "close", "volume"}
VALID_INTERVALS = {"1min", "5min", "15min", "1h"}
FREQ_MAP = {"1min": "1min", "5min": "5min", "15min": "15min", "1h": "1h"}

FUTURES_SYMBOLS = { #Bread and butter pairs
    "NQ": "NQ=F",
    "MNQ": "MNQ=F",
    "GC": "GC=F",
    "MGC": "MGC=F",
}

def _extract_arrays(df: pd.DataFrame) -> dict:
    return {    #Convert candle columns to numpy arrays to avoid repeated function calls from indicators 
        "open": np.ascontiguousarray(df["open"].to_numpy(np.float64)), #Force float64 and continguos memory for quicker C++
        "high": np.ascontiguousarray(df["high"].to_numpy(np.float64)),
        "low": np.ascontiguousarray(df["low"].to_numpy(np.float64)), 
        "close": np.ascontiguousarray(df["close"].to_numpy(np.float64)),
        "volume": np.ascontiguousarray(df["volume"].to_numpy(np.float64)),
    }

def fetch_yfinance_intraday(symbol_key: str, interval: str="5m",period: str ="60d") -> tuple[pd.DataFrame, dict]:
    if symbol_key not in FUTURES_SYMBOLS:
        raise HTTPException(400, f"Unsupported symbol: {symbol_key}. Use: {list(FUTURES_SYMBOLS.keys())}")
    ticker = FUTURES_SYMBOLS[symbol_key]
    try:
        df = yf.download(
            tickers=ticker,
            period=period,
            interval=interval,
            progress=False,
            repair=True,
            auto_adjust=True,
            prepost=False
        )
        if df.empty:
            raise valueError("No data returned from Yahoo Finance!")
        df = df[["Open", "High", "Low", "Close", "Volume"]].copy()
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
    if not file_bytes:
        raise ValueError("File is empty.")
    if not name or not name.strip():
        raise ValueError("Dataset name cannot be empty.")

    #Wrap bytes in a buffer so pandas can treat it like a file object
    #Peek at just the header first to inspect columns before loading everything
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

    #errors='coerce' turns unparseable dates into NaT instead of crashing
    #so we can count bad rows and give a helpful error message
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
        #Use float64 to prevent hidden conversipns when passing arrays to numpy or C++
        df[list(REQUIRED_COLUMNS)] = df[list(REQUIRED_COLUMNS)].astype(np.float64)
        bad_rows = df[col].isna().sum()
        if bad_rows == len(df):
            raise ValueError(f"Column '{col}' contains no valid numeric values.")
        if bad_rows > 0:
            raise ValueError(
                f"Column '{col}' contains {bad_rows} non-numeric value(s). "
                "All OHLCV columns must be numeric."
            )

    if (df["high"] < df["low"]).any():
        raise ValueError("Data integrity error: some 'high' values are less than 'low' values.")
    if (df["volume"] < 0).any():
        raise ValueError("Data integrity error: 'volume' column contains negative values.")

    df.set_index(time_col, inplace=True)
    df.sort_index(inplace=True)

    #Duplicate timestamps would cause subtle bugs in backtesting and indicator calculations
    if df.index.duplicated().any():
        dupe_count = df.index.duplicated().sum()
        raise ValueError(
            f"Timestamp index contains {dupe_count} duplicate(s). "
            "Each row must have a unique timestamp."
        )

    dataset_id = str(uuid.uuid4())
    info = {
        "dataset_id": dataset_id,
        "name": name.strip(),
        "rows": len(df),
        "columns": list(df.columns),
        "start_date": df.index.min().isoformat(),
        "end_date": df.index.max().isoformat(),
        "uploaded_at": datetime.utcnow().isoformat(),
    }

    dataset_store[dataset_id] = {
        "info": info, 
        "df": df, #Convenient for pandas
        "arrays": _extract_arrays(df) #Fasterer for indicators and my future C++ kernels 
    }
     
    return info


def generate_sample_data(
    name: str = "NQ_sample_1min",
    bars: int = 2000,
    interval: str = "1min",
    base_price: float = 20500.0,
    seed: int = 42,
) -> dict:
    if not name or not name.strip():
        raise ValueError("Dataset name cannot be empty.")
    if not isinstance(bars, int) or bars < 2:
        raise ValueError(f"'bars' must be an integer >= 2, got {bars!r}.")
    if bars > 1_000_000:
        raise ValueError(f"'bars' exceeds maximum allowed value of 1,000,000 (got {bars}).")
    if interval not in VALID_INTERVALS:
        raise ValueError(f"Invalid interval '{interval}'. Must be one of: {VALID_INTERVALS}.")
    if not isinstance(base_price, (int, float)) or base_price <= 0:
        raise ValueError(f"'base_price' must be a positive number, got {base_price!r}.")
    if not isinstance(seed, int) or seed < 0:
        raise ValueError(f"'seed' must be a non-negative integer, got {seed!r}.")

    # Seeded RNG means the same inputs always produce the same data — keeps tests reproducible
    rng = np.random.default_rng(seed)
    freq = FREQ_MAP[interval]

    # bdate_range generates business-day-aware timestamps so we don't get bars on weekends
    try:
        dates = pd.bdate_range(start="2024-01-02 09:30", periods=bars, freq=freq)
    except Exception as e:
        raise ValueError(f"Failed to generate date range: {e}") from e

    if len(dates) == 0:
        raise ValueError("Generated date range is empty. Check 'bars' and 'interval' parameters.")

    #GBM (Geometric Brownian Motion), the standard model for simulating asset prices
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
        prices[i] = prices[i - 1] * np.exp((drift - 0.5 * vol ** 2) * dt + vol * dW) + revert

    #Extreme parameter changes could theoretically break the simulation, so we validate output
    if not np.all(np.isfinite(prices)):
        raise RuntimeError("Price simulation produced non-finite values (NaN or Inf). Check simulation parameters.")
    if np.any(prices <= 0):
        raise RuntimeError("Price simulation produced zero or negative prices. Check simulation parameters.")

    #Derive OHLC by adding small noise around the close; real bars deviate from close by small amounts
    noise_range = prices * 0.0025
    highs  = prices + rng.uniform(0, 1, bars) * noise_range
    lows   = prices - rng.uniform(0, 1, bars) * noise_range
    opens  = prices + rng.normal(0, 0.5, bars) * noise_range
    volume = rng.integers(800, 120_000, size=bars).astype(float)

    df = pd.DataFrame(
        {"open": opens, "high": highs, "low": lows, "close": prices, "volume": volume},
        index=dates,
    )
    df.index.name = "date"

    dataset_id = str(uuid.uuid4())
    info = {
        "dataset_id": dataset_id,
        "name": name.strip(),
        "rows": len(df),
        "columns": list(df.columns),
        "start_date": df.index.min().isoformat(),
        "end_date": df.index.max().isoformat(),
        "uploaded_at": datetime.utcnow().isoformat(),
    }

    dataset_store[dataset_id] = {
        "info": info,
        "df": df,
        "arrays": _extract_arrays(df)
    }
    return info


def get_dataset(dataset_id: str) -> dict:
    if not dataset_id or not isinstance(dataset_id, str):
        raise ValueError("'dataset_id' must be a non-empty string.")
    if dataset_id not in dataset_store:
        raise KeyError(f"Dataset '{dataset_id}' not found.")
    return dataset_store[dataset_id]


def list_datasets() -> list[dict]:
    return [v["info"] for v in dataset_store.values()]