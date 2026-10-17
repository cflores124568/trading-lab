"""Completed-bar entry strategies for a same-day New York session.

Timestamps label bar starts. Aware timestamps are converted to New York;
naive timestamps are interpreted as UTC, matching the Databento loader.
These generate entries only; exits remain the shared engine's responsibility.
"""

import math
import re

import numpy as np
import pandas as pd


SESSION_STRATEGIES = {"orb", "vwap_mean_reversion"}


def _number(params: dict, key: str, default: float, *, minimum: float = 0,
            maximum: float | None = None, integer: bool = False) -> float:
    raw = params.get(key, default)
    try:
        value = float(raw)
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f"{key} must be a finite number.") from None
    if isinstance(raw, bool) or not math.isfinite(value):
        raise ValueError(f"{key} must be a finite number.")
    if value < minimum or (maximum is not None and value > maximum):
        raise ValueError(f"{key} must be between {minimum} and {maximum if maximum is not None else 'infinity'}.")
    if integer and not value.is_integer():
        raise ValueError(f"{key} must be a whole number.")
    return value


def _clock_minutes(params: dict, key: str, default: int) -> int:
    clock = int(_number(params, key, default, maximum=2359, integer=True))
    hours, minutes = divmod(clock, 100)
    if minutes >= 60:
        raise ValueError(f"{key} must be a valid HHMM time in New York (for example 930).")
    return hours * 60 + minutes


def validate_session_params(strategy_type: str, params: dict) -> tuple[int, int]:
    start = _clock_minutes(params, "session_start", 930)
    end = _clock_minutes(params, "session_end", 1600)
    if end <= start:
        raise ValueError("Session end must be after session start on the same New York day.")
    if strategy_type == "orb":
        minutes = _number(params, "opening_range_minutes", 15, minimum=1, integer=True)
        if minutes >= end - start:
            raise ValueError("Opening range must be shorter than the entry session.")
        _number(params, "breakout_buffer_percent", 0, maximum=10)
    else:
        _number(params, "entry_deviation_percent", 0.1, minimum=0.001, maximum=10)
        warmup = _number(params, "warmup_minutes", 15, integer=True)
        if warmup >= end - start:
            raise ValueError("VWAP warmup must be shorter than the entry session.")
        if _number(params, "vwap_bias", 0, maximum=1, integer=True) != 0:
            raise ValueError("VWAP alignment cannot be enabled for VWAP mean reversion: it blocks fade entries.")
    _number(params, "trend_ema_period", 0, integer=True)
    _number(params, "cooldown_bars", 0, integer=True)
    _number(params, "min_atr_percent", 0)
    _number(params, "atr_period", 14, minimum=1, integer=True)
    _number(params, "vwap_bias", 0, maximum=1, integer=True)
    return start, end


def _bar_minutes(df: pd.DataFrame) -> int:
    interval = df.attrs.get("bar_interval")
    if interval:
        match = re.fullmatch(r"(\d+)(min|m|h)", str(interval))
        if not match:
            raise ValueError("ORB and VWAP mean reversion require intraday minute/hour bars.")
        minutes = int(match[1]) * (60 if match[2] == "h" else 1)
    elif len(df) >= 2:
        minutes = float((df.index[1:] - df.index[:-1]).min().total_seconds()) / 60
    else:
        raise ValueError("Session strategies need an explicit bar interval for a single bar.")
    if minutes <= 0 or minutes > 60 or int(minutes) != minutes:
        raise ValueError("Session strategies require whole-minute intraday bars of at most one hour.")
    return int(minutes)


def add_session_indicators(df: pd.DataFrame, strategy_type: str, params: dict) -> pd.DataFrame:
    start, end = validate_session_params(strategy_type, params)
    if not isinstance(df.index, pd.DatetimeIndex) or not df.index.is_monotonic_increasing or not df.index.is_unique:
        raise ValueError("Session strategies require sorted, unique datetime bars.")
    duration = _bar_minutes(df)
    if duration >= end - start:
        raise ValueError("Bar interval must be shorter than the entry session.")
    local = df.index
    if local.tz is None:
        local = local.tz_localize("UTC")
    local = local.tz_convert("America/New_York")
    elapsed = np.asarray(local.hour * 60 + local.minute - start)
    inside = (elapsed >= 0) & (elapsed + duration <= end - start)
    if np.any(inside & ((elapsed % duration != 0) | (local.second != 0) | (local.microsecond != 0))):
        raise ValueError("Bar boundaries must align with the New York session start. Choose a smaller interval or adjust the session start.")

    # Entry signals are evaluated at bar close and filled at the next open.
    # Do not send a new entry on the last bar of the session.
    df["session_entry_allowed"] = inside & (elapsed + duration < end - start)
    df["session_elapsed_minutes"] = elapsed + duration
    df["session_day"] = local.date
    df["vwap"] = np.nan
    session = df.loc[inside, ["high", "low", "close", "volume", "session_day"]].copy()
    session["elapsed"] = elapsed[inside]
    keys = session["session_day"]
    # A window that starts mid-session cannot reconstruct that day's VWAP.
    complete_start = session.groupby("session_day")["elapsed"].transform("min").eq(0)
    typical_volume = (session["high"] + session["low"] + session["close"]) / 3 * session["volume"]
    volume = session["volume"].groupby(keys).cumsum()
    session_vwap = typical_volume.groupby(keys).cumsum() / volume.where(volume > 0)
    df.loc[inside, "vwap"] = session_vwap.where(complete_start).to_numpy()

    if strategy_type == "orb":
        opening_minutes = int(float(params.get("opening_range_minutes", 15)))
        if opening_minutes % duration != 0:
            raise ValueError("Opening range minutes must be a multiple of the bar interval. Use 1m/5m/15m for a 15-minute range.")
        opening = session.loc[session["elapsed"] < opening_minutes]
        ranges = opening.groupby("session_day").agg(
            high=("high", "max"), low=("low", "min"), count=("close", "size"), first=("elapsed", "min")
        )
        ranges = ranges.loc[(ranges["count"] == opening_minutes // duration) & (ranges["first"] == 0)]
        ready = inside & (elapsed >= opening_minutes)
        # Levels are exposed only after the full opening window has closed.
        df["orb_high"] = np.where(ready, df["session_day"].map(ranges["high"]), np.nan)
        df["orb_low"] = np.where(ready, df["session_day"].map(ranges["low"]), np.nan)
    return df


def generate_session_signals(df: pd.DataFrame, strategy_type: str, params: dict) -> pd.DataFrame:
    validate_session_params(strategy_type, params)
    required = {"session_entry_allowed", "session_elapsed_minutes", "session_day", "vwap"}
    if strategy_type == "orb":
        required |= {"orb_high", "orb_low"}
    if not required.issubset(df.columns):
        raise ValueError("Missing session indicators. Run indicators first.")
    same_day = df["session_day"].eq(df["session_day"].shift())
    allowed = df["session_entry_allowed"]
    df["signal"] = 0
    if strategy_type == "orb":
        buffer = float(params.get("breakout_buffer_percent", 0)) / 100
        upper = df["orb_high"] * (1 + buffer)
        lower = df["orb_low"] * (1 - buffer)
        previous_close = df["close"].shift()
        df.loc[allowed & same_day & (df["close"] > upper) & (previous_close <= upper), "signal"] = 1
        df.loc[allowed & same_day & (df["close"] < lower) & (previous_close >= lower), "signal"] = -1
    else:
        deviation = 100 * (df["close"] / df["vwap"] - 1)
        threshold = float(params.get("entry_deviation_percent", 0.1))
        ready = allowed & df["session_elapsed_minutes"].ge(float(params.get("warmup_minutes", 15))) & deviation.notna()
        previous_ready = ready.shift(fill_value=False) & same_day
        previous = deviation.shift()
        df.loc[ready & (deviation <= -threshold) & (~previous_ready | (previous > -threshold)), "signal"] = 1
        df.loc[ready & (deviation >= threshold) & (~previous_ready | (previous < threshold)), "signal"] = -1
    return df
