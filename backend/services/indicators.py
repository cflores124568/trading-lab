import numpy as np
import pandas as pd

try:
    import pandas_ta as ta          
except ImportError:                 
    raise ImportError(
        "pandas-ta is required.  Run: pip install pandas-ta"
    )

#Private NumPy kernels for future C++ swap points
def _sma(closes: np.ndarray, period: int) -> np.ndarray:
    out = np.full_like(closes, np.nan, dtype=float)
    if period <= 0:
        return out
    csum = np.cumsum(closes, dtype=float)
    csum[period:] = csum[period:] - csum[:-period]
    out[period - 1:] = csum[period - 1:] / period
    return out

def _ema(closes: np.ndarray, period: int) -> np.ndarray:
    out = np.full_like(closes, np.nan, dtype=float)
    if period <= 0 or len(closes) < period:
        return out
    k = 2.0 / (period + 1)
    #seed with SMA of first period bars
    out[period - 1] = np.mean(closes[:period])
    for i in range(period, len(closes)):
        out[i] = closes[i] * k + out[i - 1] * (1.0 - k)
    return out

#Delegate to pandas-ta for now
def _rsi(closes: np.ndarray, period: int) -> np.ndarray:
    return pd.Series(closes).ta.rsi(length=period).to_numpy()

def _bbands(closes: np.ndarray, period: int, std_dev: float) -> dict:
    bb = pd.Series(closes).ta.bbands(length=period, std=std_dev)
    rename = {
        f"BBL_{period}_{std_dev}": "bb_lower",
        f"BBM_{period}_{std_dev}": "bb_mid",
        f"BBU_{period}_{std_dev}": "bb_upper",
    }
    bb = bb.rename(columns=rename)[["bb_lower", "bb_mid", "bb_upper"]]
    return {
        "bb_lower": bb["bb_lower"].to_numpy(),
        "bb_mid":   bb["bb_mid"].to_numpy(),
        "bb_upper": bb["bb_upper"].to_numpy(),
    }

#VWAP = cumsum(typical_price * volume) / cumsum(volume)
#Typical price = (high + low + close) / 3.
# Resets each session. Caller is responsible for passing only the bars belonging to a single trading session.
def _vwap(
    highs:   np.ndarray,
    lows:    np.ndarray,
    closes:  np.ndarray,
    volumes: np.ndarray,
) -> np.ndarray:
    typical = (highs + lows + closes) / 3.0
    cum_tp_vol = np.cumsum(typical * volumes)
    cum_vol    = np.cumsum(volumes)
    # Avoid division by zero on zero-volume bars
    out = np.where(cum_vol > 0, cum_tp_vol / cum_vol, np.nan)
    return out

#Public DataFrame API 
#Add SMA/EMA fast and slow columns. Mutating df in-place
def add_moving_averages(df: pd.DataFrame, fast: int = 9, slow: int = 21) -> pd.DataFrame:
    if "close" not in df.columns:
        raise KeyError("DataFrame must contain a 'close' column")
    closes = df["close"].to_numpy()
    df[f"sma_{fast}"] = _sma(closes, fast)
    df[f"sma_{slow}"] = _sma(closes, slow)
    return df

def add_ema(df: pd.DataFrame, fast: int = 9, slow: int = 21) -> pd.DataFrame:
    if "close" not in df.columns:
        raise KeyError("DataFrame must contain a 'close' column")
    closes = df["close"].to_numpy()
    df[f"ema_{fast}"] = _ema(closes, fast)
    df[f"ema_{slow}"] = _ema(closes, slow)
    return df

#Additional indicators
def add_rsi(df: pd.DataFrame, period: int = 14) -> pd.DataFrame:
    if "close" not in df.columns:
        raise KeyError("DataFrame must contain a 'close' column")
    closes = df["close"].to_numpy()
    df[f"rsi_{period}"] = _rsi(closes, period)
    return df

def add_bollinger_bands(df: pd.DataFrame, period: int = 20, std_dev: float = 2.0) -> pd.DataFrame:
    if "close" not in df.columns:
        raise KeyError("DataFrame must contain a 'close' column")
    closes = df["close"].to_numpy()
    bands = _bbands(closes, period, std_dev)
    df["bb_lower"] = bands["bb_lower"]
    df["bb_mid"]   = bands["bb_mid"]
    df["bb_upper"] = bands["bb_upper"]
    return df

#Add VWAP column
#Requires 'high', 'low', 'close', and 'volume' columns
#Assumes the dataframe contains bars from a single trading session
#For multi-session data, call this per-session after grouping by date
def add_vwap(df: pd.DataFrame) -> pd.DataFrame:
    required = {"high", "low", "close", "volume"}
    missing  = required - set(df.columns)
    if missing:
        raise KeyError(f"DataFrame is missing columns required for VWAP: {missing}")

    df["vwap"] = _vwap(
        df["high"].to_numpy(),
        df["low"].to_numpy(),
        df["close"].to_numpy(),
        df["volume"].to_numpy(),
    )
    return df

#Attach every indicator the strategy might need
def add_all_indicators(df: pd.DataFrame, params: dict, strategy_type=None) -> pd.DataFrame:
    from schemas import StrategyType

    fast       = params.get("fast_period", 9)
    slow       = params.get("slow_period", 21)
    rsi_period = params.get("rsi_period", 14)
    bb_period  = params.get("bb_period", 20)
    bb_std     = params.get("std_dev", 2.0)

    # Compute only what the strategy needs, or everything if unspecified
    if strategy_type in (None, StrategyType.MA_CROSSOVER):
        df = add_moving_averages(df, fast=fast, slow=slow)

    if strategy_type in (None, StrategyType.EMA_CROSSOVER):
        df = add_ema(df, fast=fast, slow=slow)

    if strategy_type in (None, StrategyType.RSI_OVERBOUGHT):
        df = add_rsi(df, period=rsi_period)

    if strategy_type in (None, StrategyType.BOLLINGER_BANDS):
        df = add_bollinger_bands(df, period=bb_period, std_dev=bb_std)

    # VWAP always — useful for context even across strategies
    df = df.groupby(df.index.date, group_keys=False).apply(add_vwap)

    return df