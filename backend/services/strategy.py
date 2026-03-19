import pandas as pd
from schemas import StrategyType


def generate_signals(df: pd.DataFrame, strategy_type: str, params: dict) -> pd.DataFrame:
    """Route to the correct signal generator based on strategy type."""
    df = df.copy()

    if strategy_type == StrategyType.MA_CROSSOVER:
        return _ma_crossover_signals(df, params)
    elif strategy_type == StrategyType.RSI_OVERBOUGHT:
        return _rsi_signals(df, params)
    elif strategy_type == StrategyType.BOLLINGER_BANDS:
        return _bollinger_signals(df, params)
    elif strategy_type == StrategyType.EMA_CROSSOVER:
        return _ema_crossover_signals(df, params)
    else:
        raise ValueError(f"Unknown strategy type: {strategy_type}")


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