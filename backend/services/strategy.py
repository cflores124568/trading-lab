import pandas as pd
from schemas import StrategyType


def generate_signals(df: pd.DataFrame, strategy_type: str, params: dict) -> pd.DataFrame:
    """Route to the correct signal generator based on strategy type."""
    df = df.copy()

    if strategy_type == StrategyType.MA_CROSSOVER:
        df = _ma_crossover_signals(df, params)
    elif strategy_type == StrategyType.RSI_OVERBOUGHT:
        df = _rsi_signals(df, params)
    elif strategy_type == StrategyType.BOLLINGER_BANDS:
        df = _bollinger_signals(df, params)
    elif strategy_type == StrategyType.EMA_CROSSOVER:
        df = _ema_crossover_signals(df, params)
    else:
        raise ValueError(f"Unknown strategy type: {strategy_type}")

    return _apply_shared_signal_filters(df, params)


#MA Crossover
def _ma_crossover_signals(df: pd.DataFrame, params: dict) -> pd.DataFrame:
    """
    Buy  when fast SMA crosses ABOVE slow SMA.
    Sell when fast SMA crosses BELOW slow SMA.
    """
    fast = params.get("fast_period", 9)
    slow = params.get("slow_period", 21)

    fast_col = f"sma_{fast}"
    slow_col = f"sma_{slow}"

    df["signal"] = 0
    df.loc[
        (df[fast_col] > df[slow_col]) &
        (df[fast_col].shift(1) <= df[slow_col].shift(1)),
        "signal"
    ] = 1
    df.loc[
        (df[fast_col] < df[slow_col]) &
        (df[fast_col].shift(1) >= df[slow_col].shift(1)),
        "signal"
    ] = -1

    return df

#EMA Crossover 
def _ema_crossover_signals(df: pd.DataFrame, params: dict) -> pd.DataFrame:
    """
    Buy  when fast EMA crosses ABOVE slow EMA.
    Sell when fast EMA crosses BELOW slow EMA.
    """
    fast = params.get("fast_period", 9)
    slow = params.get("slow_period", 21)
    fast_col = f"ema_{fast}"
    slow_col = f"ema_{slow}"

    if fast_col not in df.columns or slow_col not in df.columns:
        raise ValueError(f"Missing indicator columns: {fast_col}, {slow_col}. Run indicators first.")

    df["signal"] = 0
    df.loc[
        (df[fast_col] > df[slow_col]) &
        (df[fast_col].shift(1) <= df[slow_col].shift(1)),
        "signal"
    ] = 1
    df.loc[
        (df[fast_col] < df[slow_col]) &
        (df[fast_col].shift(1) >= df[slow_col].shift(1)),
        "signal"
    ] = -1
    return df


# RSI Overbought / Oversold 
def _rsi_signals(df: pd.DataFrame, params: dict) -> pd.DataFrame:
    """
    Buy  when RSI crosses BELOW oversold threshold (reversal long).
    Sell when RSI crosses ABOVE overbought threshold (reversal short).
    """
    period      = params.get("period", 14)
    overbought  = params.get("overbought", 70)
    oversold    = params.get("oversold", 30)
    rsi_col     = f"rsi_{period}"

    df["signal"] = 0
    df.loc[
        (df[rsi_col] <= oversold) &
        (df[rsi_col].shift(1) > oversold),
        "signal"
    ] = 1
    df.loc[
        (df[rsi_col] >= overbought) &
        (df[rsi_col].shift(1) < overbought),
        "signal"
    ] = -1

    return df


# ── Bollinger Bands ───────────────────────────────────────────────────────────
def _bollinger_signals(df: pd.DataFrame, params: dict) -> pd.DataFrame:
    """
    Buy  when price touches / crosses BELOW lower band.
    Sell when price touches / crosses ABOVE upper band.
    """
    df["signal"] = 0
    df.loc[df["close"] <= df["bb_lower"],  "signal"] = 1
    df.loc[df["close"] >= df["bb_upper"],  "signal"] = -1

    return df


def _apply_shared_signal_filters(df: pd.DataFrame, params: dict) -> pd.DataFrame:
    """Trim raw signals with a few reusable research filters.

    This keeps the core entry idea simple, but gives me a fast place to bolt on
    "don't take every dumb trigger" rules like trend bias, VWAP alignment,
    volatility floor, and a cooldown after the last entry.
    """
    if "signal" not in df.columns:
        raise ValueError("Missing `signal` column. Generate raw signals first.")

    df["signal"] = df["signal"].astype(int)
    trend_ema_period = _as_int(params.get("trend_ema_period", 0))
    min_atr_percent = _as_float(params.get("min_atr_percent", 0.0))
    vwap_bias = _as_int(params.get("vwap_bias", 0))
    cooldown_bars = _as_int(params.get("cooldown_bars", 0))

    if trend_ema_period > 0:
        trend_col = f"ema_{trend_ema_period}"
        if trend_col not in df.columns:
            raise ValueError(f"Missing trend filter column: {trend_col}. Run indicators first.")
        df.loc[(df["signal"] > 0) & (df["close"] <= df[trend_col]), "signal"] = 0
        df.loc[(df["signal"] < 0) & (df["close"] >= df[trend_col]), "signal"] = 0

    if vwap_bias > 0:
        if "vwap" not in df.columns:
            raise ValueError("Missing `vwap` column. Run indicators first.")
        df.loc[(df["signal"] > 0) & (df["close"] <= df["vwap"]), "signal"] = 0
        df.loc[(df["signal"] < 0) & (df["close"] >= df["vwap"]), "signal"] = 0

    if min_atr_percent > 0:
        atr_period = _as_int(params.get("atr_period", 14))
        atr_col = f"atr_{atr_period}"
        if atr_col not in df.columns:
            raise ValueError(f"Missing ATR filter column: {atr_col}. Run indicators first.")
        atr_percent = (df[atr_col] / df["close"]) * 100.0
        df.loc[atr_percent < min_atr_percent, "signal"] = 0

    if cooldown_bars > 0:
        df["signal"] = _apply_cooldown(df["signal"], cooldown_bars)

    return df


def _apply_cooldown(signal_series: pd.Series, cooldown_bars: int) -> pd.Series:
    values = signal_series.astype(int).tolist()
    remaining = 0

    for index, signal in enumerate(values):
        if signal == 0:
            if remaining > 0:
                remaining -= 1
            continue

        if remaining > 0:
            values[index] = 0
            remaining -= 1
            continue

        remaining = cooldown_bars

    return pd.Series(values, index=signal_series.index, dtype=int)


def _as_int(value, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _as_float(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default
