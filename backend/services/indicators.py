import numpy as np
import pandas as pd

#Private NumPy kernels 
#operating on raw numpy arrays for speed and C++ portability
def _sma(closes: np.ndarray, period: int) -> np.ndarray:
    #Via cumulative sum O(n), no rolling window overhead
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

def _rsi(closes: np.ndarray, period: int) -> np.ndarray:
    #Relative Strength Index — Wilder smoothing (RMA), same as TradingView. 
    # Uses Wilder's smoothing (equivalent to EMA with alpha = 1/period) rather

    out = np.full_like(closes, np.nan, dtype=float)
    if period <= 0 or len(closes) < period + 1:
        return out
 
    deltas = np.diff(closes.astype(float))
    gains = np.where(deltas > 0, deltas,  0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)
    #Seed: simple average of first period's gains/losses
    avg_gain = np.mean(gains[:period])
    avg_loss = np.mean(losses[:period])
 
    # Wilder smoothing for remaining bars
    alpha = 1.0 / period
    for i in range(period, len(deltas)):
        avg_gain = alpha * gains[i]  + (1.0 - alpha) * avg_gain
        avg_loss = alpha * losses[i] + (1.0 - alpha) * avg_loss
        if avg_loss == 0.0:
            out[i + 1] = 100.0
        else:
            rs = avg_gain / avg_loss
            out[i + 1] = 100.0 - (100.0 / (1.0 + rs))
 
    return out

def _bbands(closes: np.ndarray, period: int, std_dev: float) -> dict:
    '''Bollinger Bands where
    Middle = SMA(period)
    Upper = Middle + std_dev * rolling_std(period)
    Lower = Middle - std_dev * rolling_std(period)
    '''
    bb = pd.Series(closes).ta.bbands(length=period, std=std_dev)
    rename = {
        f"BBL_{period}_{std_dev}": "bb_lower",
        f"BBM_{period}_{std_dev}": "bb_mid",
        f"BBU_{period}_{std_dev}": "bb_upper",
    }
    bb = bb.rename(columns=rename)[["bb_lower", "bb_mid", "bb_upper"]]
    return {
        "bb_lower": bb["bb_lower"].to_numpy(),
        "bb_mid": bb["bb_mid"].to_numpy(),
        "bb_upper": bb["bb_upper"].to_numpy(),
    }

def _atr(
    highs: np.ndarray,
    lows: np.ndarray,
    closes: np.ndarray,
    period: int,
) -> np.ndarray:
    """
    Using Wilder smoothing
 
    True Range = max(
        high - low,
        |high - prev_close|,
        |low  - prev_close|
    )
 
    First bar is NaN (no previous close), first `period` bars use simple average
    to seed Wilder smoothing.
    """
    out = np.full_like(closes, np.nan, dtype=float)
    if period <= 0 or len(closes) < period + 1:
        return out
 
    n = len(closes)
    tr = np.full(n, np.nan, dtype=float)
 
    for i in range(1, n):
        hl = highs[i] - lows[i]
        h_pc = abs(highs[i] - closes[i - 1])
        l_pc = abs(lows[i] - closes[i - 1])
        tr[i] = max(hl, h_pc, l_pc)
 
    # Seed with simple mean of first `period` true ranges
    out[period] = np.mean(tr[1 : period + 1])
 
    # Wilder smoothing
    alpha = 1.0 / period
    for i in range(period + 1, n):
        out[i] = alpha * tr[i] + (1.0 - alpha) * out[i - 1]
 
    return out

#VWAP = cumsum(typical_price * volume) / cumsum(volume)
# where typical price = (high + low + close) / 3
#Resets each session. You're responsible for passing only the bars belonging to a single trading session.
def _vwap(
    highs: np.ndarray,
    lows: np.ndarray,
    closes: np.ndarray,
    volumes: np.ndarray,
) -> np.ndarray:
    typical = (highs + lows + closes) / 3.0
    cum_tp_vol = np.cumsum(typical * volumes)
    cum_vol = np.cumsum(volumes)
    # Avoid division by zero on zero-volume bars
    return np.where(cum_vol > 0, cum_tp_vol / cum_vol, np.nan)

#Public DataFrame API 
#Add SMA/EMA fast and slow columns. Mutating df in-place
def add_moving_averages(df: pd.DataFrame, fast: int = 9, slow: int=21) -> pd.DataFrame:
    if "close" not in df.columns:
        raise KeyError("DataFrame must contain a 'close' column")
    closes = df["close"].to_numpy()
    df[f"sma_{fast}"] = _sma(closes, fast)
    df[f"sma_{slow}"] = _sma(closes, slow)
    return df

def add_ema(df: pd.DataFrame, fast: int=9, slow: int=21) -> pd.DataFrame:
    if "close" not in df.columns:
        raise KeyError("DataFrame must contain a 'close' column")
    closes = df["close"].to_numpy(dtype=np.float64)
    df[f"ema_{fast}"] = _ema(closes, fast)
    df[f"ema_{slow}"] = _ema(closes, slow)
    return df


def add_ema_period(df: pd.DataFrame, period: int) -> pd.DataFrame:
    if "close" not in df.columns:
        raise KeyError("DataFrame must contain a 'close' column")
    if period <= 0:
        return df

    column = f"ema_{period}"
    if column in df.columns:
        return df

    closes = df["close"].to_numpy(dtype=np.float64)
    df[column] = _ema(closes, period)
    return df

#Additional indicators
def add_rsi(df: pd.DataFrame, period: int=14) -> pd.DataFrame:
    if "close" not in df.columns:
        raise KeyError("DataFrame must contain a 'close' column")
    closes = df["close"].to_numpy(dtype=np.float64)
    df[f"rsi_{period}"] = _rsi(closes, period)
    return df

def add_bollinger_bands(df: pd.DataFrame, period: int=20, std_dev: float=2.0) -> pd.DataFrame:
    if "close" not in df.columns:
        raise KeyError("DataFrame must contain a 'close' column")
    closes = df["close"].to_numpy()
    bands = _bbands(closes, period, std_dev)
    df["bb_lower"] = bands["bb_lower"]
    df["bb_mid"] = bands["bb_mid"]
    df["bb_upper"] = bands["bb_upper"]
    return df

def add_atr(df: pd.DataFrame, period: int=14) -> pd.DataFrame:
    required = {"high", "low", "close"}
    missing  = required - set(df.columns)
    if missing:
        raise KeyError(f"DataFrame is missing columns required for ATR: {missing}")
    df[f"atr_{period}"] = _atr(
        df["high"].to_numpy(dtype=np.float64),
        df["low"].to_numpy(dtype=np.float64),
        df["close"].to_numpy(dtype=np.float64),
        period,
    )
    return df

#Must be called per session; use groupby(date).apply(add_vwap) for multiday data
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

    fast: int = params.get("fast_period", 9)
    slow: int = params.get("slow_period", 21)
    rsi_period: int = params.get("rsi_period", 14)
    bb_period: int = params.get("bb_period", 20)
    bb_std: float = params.get("std_dev", 2.0)
    atr_period: int = params.get("atr_period", 14)
    trend_ema_period: int = int(params.get("trend_ema_period", 0) or 0)

    # Compute only what the strategy needs, with VWAP and ATR always set
    #Regardless of naked /cluttered chart, every trader can benefit from these 2 indicators 
    if strategy_type in (None, StrategyType.MA_CROSSOVER):
        df = add_moving_averages(df, fast=fast, slow=slow)

    if strategy_type in (None, StrategyType.EMA_CROSSOVER):
        df = add_ema(df, fast=fast, slow=slow)

    if strategy_type in (None, StrategyType.RSI_OVERBOUGHT):
        df = add_rsi(df, period=rsi_period)

    if strategy_type in (None, StrategyType.BOLLINGER_BANDS):
        df = add_bollinger_bands(df, period=bb_period, std_dev=bb_std)

    if trend_ema_period > 0:
        df = add_ema_period(df, trend_ema_period)

    df = add_atr(df, period=atr_period)
    df = df.groupby(df.index.date, group_keys=False).apply(add_vwap)

    return df
