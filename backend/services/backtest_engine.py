
#Python wrapper for C++ pybind11 kernel
from __future__ import annotations
from typing import List
import math
import numpy as np
import pandas as pd
from services.execution_model import (
    DEFAULT_BACKTEST_EXECUTION_MODE,
    DEFAULT_SPREAD_TICKS,
    DEFAULT_VOLATILE_BAR_EXTRA_TICKS,
    DEFAULT_VOLATILE_BAR_THRESHOLD_TICKS,
    normalize_backtest_execution_mode,
    synthetic_quote_for_bar,
)

#Try to import compiled C++ kernel
try:
    import backtest_core as _core      #built via CMakeLists.txt
    _CPP_AVAILABLE = True
except ImportError:
    _CPP_AVAILABLE = False

# A stale .so from before the batch entry point still works for single runs,
# so batch availability gets its own flag instead of piggybacking.
_CPP_BATCH_AVAILABLE = _CPP_AVAILABLE and hasattr(_core, "run_backtest_batch")

# Public API  

def run_backtest(
    df:              pd.DataFrame,
    initial_balance: float = 100_000,
    position_size:   int = 1,
    commission:      float = 5.0,
    tick_size:       float = 0.25,
    tick_value:      float = 12.50,
    slippage_ticks:  float = 1.0,
    stop_loss_ticks: float | None = None,
    take_profit_ticks: float | None = None,
    execution_mode: str = DEFAULT_BACKTEST_EXECUTION_MODE,
    spread_ticks: int = DEFAULT_SPREAD_TICKS,
    volatile_bar_threshold_ticks: int = DEFAULT_VOLATILE_BAR_THRESHOLD_TICKS,
    volatile_bar_extra_ticks: int = DEFAULT_VOLATILE_BAR_EXTRA_TICKS,
    *,
    stop_loss_atr: float | None = None,
    take_profit_atr: float | None = None,
    trailing_stop_atr: float | None = None,
    trailing_stop_ticks: float | None = None,
    trailing_activation_r: float | None = None,
    breakeven_at_r: float | None = None,
    time_stop_bars: int | None = None,
    exit_at_session_end: bool = False,
    atr_period: int = 14,
    sizing_mode: str = "fixed",
    risk_per_trade_pct: float | None = None,
    max_position_size: int | None = None,
) -> dict:
    """Run a next-bar futures backtest from completed-bar signals.

    Legacy `bar` mode still fills at the next bar's open with adverse slippage.
    `synthetic_quotes` mode switches to bid/ask fills built from the same
    spread rules we use in paper/replay.

    Brackets can be sized in ticks or ATR multiples. Trailing stops and
    breakeven moves are updated from each completed bar's favorable extreme, so
    they take effect on the next bar instead of assuming an intrabar high/low
    order. Time stops and session-close exits fill at the bar close.

    `position_size` is always whole contracts. With `sizing_mode="risk_percent"`,
    each entry risks `risk_per_trade_pct` percent of current equity and rounds
    down to the nearest contract, with a minimum of one contract so a signal is
    never silently dropped. Trades that exceed the target risk are flagged.
    """
    position_size = _coerce_position_size(position_size)
    sizing_mode = _validate_sizing(
        sizing_mode,
        risk_per_trade_pct=risk_per_trade_pct,
        max_position_size=max_position_size,
        has_initial_stop=stop_loss_ticks is not None or stop_loss_atr is not None,
    )
    exit_policy = {
        "stop_loss_ticks": stop_loss_ticks,
        "take_profit_ticks": take_profit_ticks,
        "stop_loss_atr": stop_loss_atr,
        "take_profit_atr": take_profit_atr,
        "trailing_stop_atr": trailing_stop_atr,
        "trailing_stop_ticks": trailing_stop_ticks,
        "trailing_activation_r": trailing_activation_r,
        "breakeven_at_r": breakeven_at_r,
        "time_stop_bars": time_stop_bars,
        "exit_at_session_end": exit_at_session_end,
    }
    uses_bar_extremes = _policy_uses_bar_extremes(exit_policy)
    resolved_execution_mode = normalize_backtest_execution_mode(execution_mode)
    uses_synthetic_quotes = resolved_execution_mode == "synthetic_quotes"
    _validate(df, require_ohlc_range=uses_bar_extremes)

    # C++ is the primary engine for every mode now. The Python loop below is
    # the reference implementation: it keeps dev working without a compiler
    # and it's what the parity test checks the kernel against.
    has_ohlc_range = {"high", "low"} <= set(df.columns)
    needs_ohlc_range = uses_bar_extremes or uses_synthetic_quotes
    if _CPP_AVAILABLE and (has_ohlc_range or not needs_ohlc_range):
        try:
            return _run_cpp(
                df,
                initial_balance,
                position_size,
                commission,
                tick_size,
                tick_value,
                slippage_ticks,
                stop_loss_ticks,
                take_profit_ticks,
                uses_synthetic_quotes,
                spread_ticks,
                volatile_bar_threshold_ticks,
                volatile_bar_extra_ticks,
                exit_policy=exit_policy,
                atr_period=atr_period,
                sizing_mode=sizing_mode,
                risk_per_trade_pct=risk_per_trade_pct,
                max_position_size=max_position_size,
            )
        except TypeError:
            # Local dev can have an old compiled extension hanging around. Falling
            # back keeps the app correct until the C++ module is rebuilt.
            pass
    return _run_python(
        df,
        initial_balance,
        position_size,
        commission,
        tick_size,
        tick_value,
        slippage_ticks,
        stop_loss_ticks,
        take_profit_ticks,
        resolved_execution_mode,
        spread_ticks,
        volatile_bar_threshold_ticks,
        volatile_bar_extra_ticks,
        exit_policy=exit_policy,
        atr_period=atr_period,
        sizing_mode=sizing_mode,
        risk_per_trade_pct=risk_per_trade_pct,
        max_position_size=max_position_size,
    )

def run_backtest_batch(
    df:              pd.DataFrame,
    signal_arrays:   list[np.ndarray],
    initial_balance: float = 100_000,
    position_size:   int = 1,
    commission:      float = 5.0,
    tick_size:       float = 0.25,
    tick_value:      float = 12.50,
    slippage_ticks:  float = 1.0,
    stop_loss_ticks: float | None = None,
    take_profit_ticks: float | None = None,
    execution_mode: str = DEFAULT_BACKTEST_EXECUTION_MODE,
    spread_ticks: int = DEFAULT_SPREAD_TICKS,
    volatile_bar_threshold_ticks: int = DEFAULT_VOLATILE_BAR_THRESHOLD_TICKS,
    volatile_bar_extra_ticks: int = DEFAULT_VOLATILE_BAR_EXTRA_TICKS,
    max_threads: int = 0,
    *,
    stop_loss_atr: float | None = None,
    take_profit_atr: float | None = None,
    trailing_stop_atr: float | None = None,
    trailing_stop_ticks: float | None = None,
    trailing_activation_r: float | None = None,
    breakeven_at_r: float | None = None,
    time_stop_bars: int | None = None,
    exit_at_session_end: bool = False,
    atr_period: int = 14,
    sizing_mode: str = "fixed",
    risk_per_trade_pct: float | None = None,
    max_position_size: int | None = None,
) -> list[dict]:
    """Run many signal variants over one shared OHLC frame.

    This is the parameter-grid fast path: every run reads the same price
    columns from `df` and only the signal array changes, so the C++ pool can
    fan out across cores without copying the dataset per run. Results come
    back in input order, each shaped exactly like `run_backtest`'s output.
    Without the compiled kernel it just loops the Python oracle, so callers
    don't need their own fallback.
    """
    position_size = _coerce_position_size(position_size)
    sizing_mode = _validate_sizing(
        sizing_mode,
        risk_per_trade_pct=risk_per_trade_pct,
        max_position_size=max_position_size,
        has_initial_stop=stop_loss_ticks is not None or stop_loss_atr is not None,
    )
    exit_policy = {
        "stop_loss_ticks": stop_loss_ticks,
        "take_profit_ticks": take_profit_ticks,
        "stop_loss_atr": stop_loss_atr,
        "take_profit_atr": take_profit_atr,
        "trailing_stop_atr": trailing_stop_atr,
        "trailing_stop_ticks": trailing_stop_ticks,
        "trailing_activation_r": trailing_activation_r,
        "breakeven_at_r": breakeven_at_r,
        "time_stop_bars": time_stop_bars,
        "exit_at_session_end": exit_at_session_end,
    }
    resolved_execution_mode = normalize_backtest_execution_mode(execution_mode)
    uses_synthetic_quotes = resolved_execution_mode == "synthetic_quotes"
    uses_bar_extremes = _policy_uses_bar_extremes(exit_policy)

    # Same column contract as _validate, minus `signal` — signals arrive as
    # separate arrays here instead of living on the frame.
    required = {"open", "close"} | ({"high", "low"} if uses_bar_extremes else set())
    missing = required - set(df.columns)
    if missing:
        raise KeyError(f"DataFrame is missing required columns: {missing}")

    atr_values = (
        _atr_values(df, atr_period)
        if _policy_uses_atr(exit_policy)
        else None
    )
    session_flags = (
        _session_end_flags(df.index) if exit_at_session_end else None
    )

    has_ohlc_range = {"high", "low"} <= set(df.columns)
    needs_ohlc_range = uses_bar_extremes or uses_synthetic_quotes
    if _CPP_BATCH_AVAILABLE and (has_ohlc_range or not needs_ohlc_range):
        closes = df["close"].to_numpy(dtype=np.float64)
        try:
            raw_results = _core.run_backtest_batch(
                df["open"].to_numpy(dtype=np.float64),
                df["high"].to_numpy(dtype=np.float64) if "high" in df.columns else closes,
                df["low"].to_numpy(dtype=np.float64) if "low" in df.columns else closes,
                closes,
                [np.asarray(signals, dtype=np.int32) for signals in signal_arrays],
                initial_balance, position_size, commission,
                tick_size, tick_value, slippage_ticks,
                stop_loss_ticks, take_profit_ticks,
                uses_synthetic_quotes,
                int(spread_ticks), int(volatile_bar_threshold_ticks), int(volatile_bar_extra_ticks),
                stop_loss_atr, take_profit_atr,
                trailing_stop_atr, trailing_stop_ticks,
                trailing_activation_r, breakeven_at_r,
                time_stop_bars,
                bool(exit_at_session_end),
                atr_values if atr_values is not None else np.empty(0, dtype=np.float64),
                session_flags if session_flags is not None else np.empty(0, dtype=np.int32),
                sizing_mode == "risk_percent",
                float(risk_per_trade_pct or 0.0),
                int(max_position_size or 0),
                int(max_threads),
            )
        except TypeError:
            # A stale extension without the exit-policy arguments is still
            # usable through the Python oracle.
            raw_results = None

        if raw_results is not None:
            # One isoformat pass over the index beats calling it per trade — with
            # a big grid the same timestamps get referenced thousands of times.
            iso_index = [_iso(ts) for ts in df.index]
            return [
                {
                    "trades": _trades_from_raw(
                        raw, iso_index,
                        position_size=position_size,
                        commission=commission,
                        tick_size=tick_size,
                        tick_value=tick_value,
                        slippage_ticks=slippage_ticks,
                        risk_sizing=sizing_mode == "risk_percent",
                    ),
                    "equity_curve": raw["equity_curve"].tolist(),
                }
                for raw in raw_results
            ]

    return [
        _run_python(
            df.assign(signal=np.asarray(signals, dtype=int)),
            initial_balance,
            position_size,
            commission,
            tick_size,
            tick_value,
            slippage_ticks,
            stop_loss_ticks,
            take_profit_ticks,
            resolved_execution_mode,
            spread_ticks,
            volatile_bar_threshold_ticks,
            volatile_bar_extra_ticks,
            exit_policy=exit_policy,
            atr_period=atr_period,
            sizing_mode=sizing_mode,
            risk_per_trade_pct=risk_per_trade_pct,
            max_position_size=max_position_size,
        )
        for signals in signal_arrays
    ]


#Internal helpers
def _validate(df: pd.DataFrame, *, require_ohlc_range: bool = False) -> None:
    required = {"open", "close", "signal"}
    if require_ohlc_range:
        required |= {"high", "low"}
    missing  = required - set(df.columns)
    if missing:
        raise KeyError(f"DataFrame is missing required columns: {missing}")


def _policy_uses_bar_extremes(policy: dict) -> bool:
    return any(
        policy.get(key) is not None
        for key in (
            "stop_loss_ticks",
            "take_profit_ticks",
            "stop_loss_atr",
            "take_profit_atr",
            "trailing_stop_atr",
            "trailing_stop_ticks",
            "breakeven_at_r",
        )
    )


def _policy_uses_atr(policy: dict) -> bool:
    return any(
        policy.get(key) is not None
        for key in ("stop_loss_atr", "take_profit_atr", "trailing_stop_atr")
    )

def _iso(index_val) -> str:
    return index_val.isoformat() if hasattr(index_val, "isoformat") else str(index_val)

#C++ path
def _run_cpp(
    df:              pd.DataFrame,
    initial_balance: float,
    position_size:   int,
    commission:      float,
    tick_size:       float,
    tick_value:      float,
    slippage_ticks:  float,
    stop_loss_ticks: float | None = None,
    take_profit_ticks: float | None = None,
    use_synthetic_quotes: bool = False,
    spread_ticks: int = DEFAULT_SPREAD_TICKS,
    volatile_bar_threshold_ticks: int = DEFAULT_VOLATILE_BAR_THRESHOLD_TICKS,
    volatile_bar_extra_ticks: int = DEFAULT_VOLATILE_BAR_EXTRA_TICKS,
    *,
    exit_policy: dict | None = None,
    atr_period: int = 14,
    sizing_mode: str = "fixed",
    risk_per_trade_pct: float | None = None,
    max_position_size: int | None = None,
) -> dict:
    """Call the C++ kernel, then stitch timestamps back onto trades."""
    position_size = _coerce_position_size(position_size)
    policy = _normalize_exit_policy(
        exit_policy,
        stop_loss_ticks=stop_loss_ticks,
        take_profit_ticks=take_profit_ticks,
    )
    sizing_mode = _validate_sizing(
        sizing_mode,
        risk_per_trade_pct=risk_per_trade_pct,
        max_position_size=max_position_size,
        has_initial_stop=policy["stop_loss_ticks"] is not None or policy["stop_loss_atr"] is not None,
    )
    opens = df["open"].to_numpy(dtype=np.float64)
    closes = df["close"].to_numpy(dtype=np.float64)
    signals = df["signal"].to_numpy(dtype=np.int32)
    # high/low only matter for brackets and quote volatility; the dispatch in
    # run_backtest guarantees they exist whenever a mode actually reads them.
    highs = df["high"].to_numpy(dtype=np.float64) if "high" in df.columns else closes
    lows = df["low"].to_numpy(dtype=np.float64) if "low" in df.columns else closes
    atr_values = _atr_values(df, atr_period) if _policy_uses_atr(policy) else None
    session_flags = _session_end_flags(df.index) if policy["exit_at_session_end"] else None

    #Hot loop lives entirely in C++
    raw = _core.run_backtest_kernel(
        opens, highs, lows, closes, signals,
        initial_balance, position_size, commission,
        tick_size, tick_value, slippage_ticks,
        policy["stop_loss_ticks"], policy["take_profit_ticks"],
        use_synthetic_quotes,
        int(spread_ticks), int(volatile_bar_threshold_ticks), int(volatile_bar_extra_ticks),
        policy["stop_loss_atr"], policy["take_profit_atr"],
        policy["trailing_stop_atr"], policy["trailing_stop_ticks"],
        policy["trailing_activation_r"], policy["breakeven_at_r"],
        policy["time_stop_bars"],
        bool(policy["exit_at_session_end"]),
        atr_values if atr_values is not None else np.empty(0, dtype=np.float64),
        session_flags if session_flags is not None else np.empty(0, dtype=np.int32),
        sizing_mode == "risk_percent",
        float(risk_per_trade_pct or 0.0),
        int(max_position_size or 0),
    )

    return {
        "trades": _trades_from_raw(
            raw, df.index,
            position_size=position_size,
            commission=commission,
            tick_size=tick_size,
            tick_value=tick_value,
            slippage_ticks=slippage_ticks,
            risk_sizing=sizing_mode == "risk_percent",
        ),
        "equity_curve": raw["equity_curve"].tolist(),
    }


_EXIT_REASON_BY_CODE = {
    0: "signal_flip",
    1: "stop_loss",
    2: "take_profit",
    3: "trailing_stop",
    4: "breakeven_stop",
    5: "time_stop",
    6: "session_close",
    7: "end_of_data",
}


def _trades_from_raw(
    raw: dict,
    idx,
    *,
    position_size: int,
    commission: float,
    tick_size: float,
    tick_value: float,
    slippage_ticks: float,
    risk_sizing: bool = False,
) -> List[dict]:
    """Stitch timestamps and run config back onto the kernel's flat arrays.

    `idx` can be the DataFrame index itself or a pre-rendered list of iso
    strings — `_iso` passes strings through untouched, so batch callers can
    pay the isoformat cost once instead of per trade.
    """
    exit_reasons = raw.get("exit_reasons") if hasattr(raw, "get") else None
    quantities = raw.get("quantities") if hasattr(raw, "get") else None
    initial_risks = raw.get("initial_risks") if hasattr(raw, "get") else None
    risk_budgets = raw.get("risk_budgets") if hasattr(raw, "get") else None
    risk_exceeded = raw.get("risk_exceeded") if hasattr(raw, "get") else None

    trades: List[dict] = []
    for trade_id in range(len(raw["entry_indices"])):
        quantity = (
            int(round(float(quantities[trade_id])))
            if quantities is not None
            else position_size
        )
        pnl = float(raw["pnls"][trade_id])
        initial_risk = (
            round(float(initial_risks[trade_id]), 2)
            if initial_risks is not None
            and (risk_sizing or float(initial_risks[trade_id]) > 0)
            else None
        )
        risk_budget = (
            round(float(risk_budgets[trade_id]), 2)
            if risk_budgets is not None
            and (risk_sizing or float(risk_budgets[trade_id]) > 0)
            else None
        )
        trades.append({
            "trade_id":    trade_id,
            "entry_time":  _iso(idx[raw["entry_indices"][trade_id]]),
            "exit_time":   _iso(idx[raw["exit_indices"] [trade_id]]),
            "side":        "buy" if raw["sides"][trade_id] == 1 else "sell",
            "quantity":    quantity,
            "entry_price": float(raw["entry_prices"][trade_id]),
            "exit_price":  float(raw["exit_prices"] [trade_id]),
            "pnl":         pnl,
            "status":      "closed",
            "commission":  round(commission * quantity, 2),
            "initial_risk": initial_risk,
            "risk_budget": risk_budget,
            "r_multiple":  round(pnl / initial_risk, 4) if initial_risk else None,
            "risk_exceeded": bool(risk_exceeded[trade_id]) if risk_exceeded is not None else False,
            "tick_size":   tick_size,
            "tick_value":  tick_value,
            "slippage_ticks": slippage_ticks,
            "exit_reason": _EXIT_REASON_BY_CODE.get(int(exit_reasons[trade_id]))
                           if exit_reasons is not None else None,
        })
    return trades


#Pure Python fallback
def _run_python(
    df:              pd.DataFrame,
    initial_balance: float,
    position_size:   int,
    commission:      float,
    tick_size:       float,
    tick_value:      float,
    slippage_ticks:  float,
    stop_loss_ticks: float | None,
    take_profit_ticks: float | None,
    execution_mode: str,
    spread_ticks: int,
    volatile_bar_threshold_ticks: int,
    volatile_bar_extra_ticks: int,
    *,
    exit_policy: dict | None = None,
    atr_period: int = 14,
    sizing_mode: str = "fixed",
    risk_per_trade_pct: float | None = None,
    max_position_size: int | None = None,
) -> dict:
    if tick_size <= 0:
        raise ValueError("tick_size must be greater than zero.")

    position_size = _coerce_position_size(position_size)
    policy = _normalize_exit_policy(
        exit_policy,
        stop_loss_ticks=stop_loss_ticks,
        take_profit_ticks=take_profit_ticks,
    )
    sizing_mode = _validate_sizing(
        sizing_mode,
        risk_per_trade_pct=risk_per_trade_pct,
        max_position_size=max_position_size,
        has_initial_stop=policy["stop_loss_ticks"] is not None or policy["stop_loss_atr"] is not None,
    )
    uses_atr = any(
        policy.get(key) is not None
        for key in ("stop_loss_atr", "take_profit_atr", "trailing_stop_atr")
    )
    atr_values = _atr_values(df, atr_period) if uses_atr else None
    session_flags = (
        _session_end_flags(df.index) if policy["exit_at_session_end"] else None
    )

    balance      = initial_balance
    equity_curve: List[float] = [balance]
    trades:      List[dict]   = []
    trade_id     = 0
    position: dict | None = None

    def close_position(exit_time, exit_price: float, reason: str) -> None:
        nonlocal balance, trade_id, position
        quantity = position["quantity"]
        pnl = _position_pnl(
            side=position["side"],
            entry_price=position["entry_price"],
            exit_price=exit_price,
            quantity=quantity,
            tick_size=tick_size,
            tick_value=tick_value,
            commission=commission,
        )
        balance += pnl
        initial_risk = position["initial_risk"]
        risk_budget = position["risk_budget"]

        trades.append({
            "trade_id":    trade_id,
            "entry_time":  position["entry_time"],
            "exit_time":   exit_time,
            "side":        position["side"],
            "quantity":    quantity,
            "entry_price": position["entry_price"],
            "exit_price":  exit_price,
            "pnl":         round(pnl, 2),
            "status":      "closed",
            "commission":  round(commission * quantity, 2),
            "initial_risk": round(initial_risk, 2) if initial_risk is not None else None,
            "risk_budget": round(risk_budget, 2) if risk_budget is not None else None,
            "r_multiple":  round(pnl / initial_risk, 4) if initial_risk and initial_risk > 0 else None,
            "risk_exceeded": bool(position["risk_exceeded"]),
            "tick_size":   tick_size,
            "tick_value":  tick_value,
            "slippage_ticks": slippage_ticks,
            "exit_reason": reason,
        })
        trade_id += 1
        position = None

    def close_at_bar_close(bar, reason: str) -> None:
        if execution_mode == "synthetic_quotes":
            quote = _quote_for_execution_close(
                bar,
                tick_size=tick_size,
                spread_ticks=spread_ticks,
                volatile_bar_threshold_ticks=volatile_bar_threshold_ticks,
                volatile_bar_extra_ticks=volatile_bar_extra_ticks,
            )
            exit_price = _flatten_price_for_position(position["side"], quote)
        else:
            exit_price = _apply_slippage(
                _round_to_tick(float(bar["close"]), tick_size),
                side=position["side"],
                action="exit",
                tick_size=tick_size,
                slippage_ticks=slippage_ticks,
            )
        close_position(_iso(bar.name), exit_price, reason)

    for i in range(1, len(df)):
        bar = df.iloc[i]
        signal = int(df.iloc[i - 1].get("signal", 0))
        quote = None
        execution_base = _round_to_tick(float(bar["open"]), tick_size)

        if execution_mode == "synthetic_quotes":
            quote = _quote_for_execution_open(
                bar,
                tick_size=tick_size,
                spread_ticks=spread_ticks,
                volatile_bar_threshold_ticks=volatile_bar_threshold_ticks,
                volatile_bar_extra_ticks=volatile_bar_extra_ticks,
            )
            execution_base = float(quote["reference"])

        # A flip closes the old trade and opens the new one at the next bar open.
        if position is not None:
            should_close = (
                (position["side"] == "buy"  and signal == -1) or
                (position["side"] == "sell" and signal ==  1)
            )
            if should_close:
                if execution_mode == "synthetic_quotes" and quote is not None:
                    exit_price = _flatten_price_for_position(position["side"], quote)
                else:
                    exit_price = _apply_slippage(
                        execution_base,
                        side=position["side"],
                        action="exit",
                        tick_size=tick_size,
                        slippage_ticks=slippage_ticks,
                    )
                close_position(_iso(bar.name), exit_price, "signal_flip")

        #Open new position. Do not open on the final bar or on a bar that is
        #about to be flattened at session close.
        session_is_closing = (
            policy["exit_at_session_end"]
            and session_flags is not None
            and bool(session_flags[i])
        )
        if position is None and signal != 0 and i < len(df) - 1 and not session_is_closing:
            side = "buy" if signal == 1 else "sell"

            entry_atr = float(atr_values[i - 1]) if uses_atr else None
            if uses_atr and (entry_atr is None or not np.isfinite(entry_atr) or entry_atr <= 0):
                # No usable volatility estimate means no defensible ATR stop.
                # Skip the entry instead of silently dropping the risk control.
                pass
            else:
                if execution_mode == "synthetic_quotes" and quote is not None:
                    entry_price = round(float(quote["ask"] if side == "buy" else quote["bid"]), 10)
                else:
                    entry_price = _apply_slippage(
                        execution_base,
                        side=side,
                        action="entry",
                        tick_size=tick_size,
                        slippage_ticks=slippage_ticks,
                    )

                stop_distance = _distance_for_leg(
                    "stop_loss",
                    policy,
                    atr=entry_atr,
                    tick_size=tick_size,
                )
                target_distance = _distance_for_leg(
                    "take_profit",
                    policy,
                    atr=entry_atr,
                    tick_size=tick_size,
                )
                trailing_distance = _trailing_distance(policy, atr=entry_atr, tick_size=tick_size)
                stop_price = _barrier_price(side, entry_price, stop_distance, tick_size)
                sizing = _size_position(
                    sizing_mode=sizing_mode,
                    position_size=position_size,
                    max_position_size=max_position_size,
                    risk_per_trade_pct=risk_per_trade_pct,
                    balance=balance,
                    entry_price=entry_price,
                    stop_price=stop_price,
                    tick_size=tick_size,
                    tick_value=tick_value,
                    commission=commission,
                )

                position = {
                    "side":            side,
                    "entry_price":     entry_price,
                    "entry_time":      _iso(bar.name),
                    "entry_index":     i,
                    "quantity":        sizing["quantity"],
                    "stop_distance":   stop_distance,
                    "initial_risk":    sizing["initial_risk"],
                    "risk_budget":     sizing["risk_budget"],
                    "risk_exceeded":   sizing["risk_exceeded"],
                    "stop_price":      stop_price,
                    "stop_source":     "initial" if stop_distance is not None else None,
                    "target_price":    _barrier_price(side, entry_price, target_distance, tick_size, is_target=True),
                    "best_price":      entry_price,
                    "breakeven_done":  False,
                    "trailing_distance": trailing_distance,
                    "trailing_active":   trailing_distance is not None
                                          and policy["trailing_activation_r"] is None,
                }

        # Bracket and trailing exits can fire inside the same bar off its
        # high/low. A candle that tags both levels resolves to the stop, so the
        # sim stays honest instead of quietly cherry-picking the target.
        if position is not None and (
            position["stop_price"] is not None or position["target_price"] is not None
        ):
            hit_stop, hit_target = _barrier_hits(position, bar)
            if hit_stop or hit_target:
                raw_exit = position["stop_price"] if hit_stop else position["target_price"]
                reason = (
                    _stop_reason(position["stop_source"])
                    if hit_stop
                    else "take_profit"
                )
                close_position(
                    _iso(bar.name),
                    _apply_slippage(
                        raw_exit,
                        side=position["side"],
                        action="exit",
                        tick_size=tick_size,
                        slippage_ticks=slippage_ticks,
                    ),
                    reason,
                )
                equity_curve.append(round(balance, 2))
                continue

        # Market-on-close exits: session first, then the bar-count time stop.
        if position is not None and policy["exit_at_session_end"] and session_flags is not None and session_flags[i]:
            close_at_bar_close(bar, "session_close")
            equity_curve.append(round(balance, 2))
            continue

        if (
            position is not None
            and policy["time_stop_bars"] is not None
            and (i - position["entry_index"] + 1) >= policy["time_stop_bars"]
        ):
            close_at_bar_close(bar, "time_stop")
            equity_curve.append(round(balance, 2))
            continue

        # Update breakeven and trailing levels from this bar's favorable extreme.
        # They become active on the next bar so the loop never assumes an
        # intrabar high/low ordering it cannot actually know.
        if position is not None and (
            policy.get("breakeven_at_r") is not None
            or policy.get("trailing_stop_atr") is not None
            or policy.get("trailing_stop_ticks") is not None
        ):
            _update_dynamic_exits(position, bar, policy, tick_size)

        #Mark-to-market
        if position is not None:
            mark_price = _round_to_tick(float(bar["close"]), tick_size)
            unrealised = _position_pnl(
                side=position["side"],
                entry_price=position["entry_price"],
                exit_price=mark_price,
                quantity=position["quantity"],
                tick_size=tick_size,
                tick_value=tick_value,
                commission=commission,
            )
            equity_curve.append(round(balance + unrealised, 2))
        else:
            equity_curve.append(round(balance, 2))

    #Force-close at final bar
    if position is not None:
        last_bar = df.iloc[-1]
        close_at_bar_close(last_bar, "end_of_data")
        equity_curve[-1] = round(balance, 2)

    return {
        "trades":       trades,
        "equity_curve": equity_curve,
    }


def _normalize_exit_policy(
    policy: dict | None,
    *,
    stop_loss_ticks: float | None,
    take_profit_ticks: float | None,
) -> dict:
    normalized = {
        "stop_loss_ticks": stop_loss_ticks,
        "take_profit_ticks": take_profit_ticks,
        "stop_loss_atr": None,
        "take_profit_atr": None,
        "trailing_stop_atr": None,
        "trailing_stop_ticks": None,
        "trailing_activation_r": None,
        "breakeven_at_r": None,
        "time_stop_bars": None,
        "exit_at_session_end": False,
    }
    if policy:
        normalized.update({key: value for key, value in policy.items() if key in normalized})
    if stop_loss_ticks is not None:
        normalized["stop_loss_ticks"] = stop_loss_ticks
    if take_profit_ticks is not None:
        normalized["take_profit_ticks"] = take_profit_ticks
    return normalized


def _distance_for_leg(
    prefix: str,
    policy: dict,
    *,
    atr: float | None,
    tick_size: float,
) -> float | None:
    atr_multiple = policy.get(f"{prefix}_atr")
    if atr_multiple is not None:
        if atr is None or not np.isfinite(atr) or atr <= 0:
            return None
        return float(atr_multiple) * float(atr)
    ticks = policy.get(f"{prefix}_ticks")
    if ticks is not None:
        return float(ticks) * tick_size
    return None


def _trailing_distance(policy: dict, *, atr: float | None, tick_size: float) -> float | None:
    atr_multiple = policy.get("trailing_stop_atr")
    if atr_multiple is not None:
        if atr is None or not np.isfinite(atr) or atr <= 0:
            return None
        return float(atr_multiple) * float(atr)
    ticks = policy.get("trailing_stop_ticks")
    if ticks is not None:
        return float(ticks) * tick_size
    return None


def _barrier_price(
    side: str,
    entry_price: float,
    distance: float | None,
    tick_size: float,
    *,
    is_target: bool = False,
) -> float | None:
    if distance is None:
        return None
    offset = float(distance)
    if side == "buy":
        raw = entry_price + offset if is_target else entry_price - offset
    else:
        raw = entry_price - offset if is_target else entry_price + offset
    return _round_to_tick(raw, tick_size)


def _barrier_hits(position: dict, bar) -> tuple[bool, bool]:
    side = position["side"]
    high = float(bar["high"])
    low = float(bar["low"])
    stop_price = position["stop_price"]
    target_price = position["target_price"]

    if side == "buy":
        hit_stop = stop_price is not None and low <= stop_price
        hit_target = target_price is not None and high >= target_price
    else:
        hit_stop = stop_price is not None and high >= stop_price
        hit_target = target_price is not None and low <= target_price
    return hit_stop, hit_target


def _stop_reason(source: str | None) -> str:
    if source == "trailing":
        return "trailing_stop"
    if source == "breakeven":
        return "breakeven_stop"
    return "stop_loss"


def _update_dynamic_exits(position: dict, bar, policy: dict, tick_size: float) -> None:
    side = position["side"]
    entry_price = position["entry_price"]
    high = float(bar["high"])
    low = float(bar["low"])

    if side == "buy":
        position["best_price"] = max(position["best_price"], high)
        favorable = position["best_price"] - entry_price
    else:
        position["best_price"] = min(position["best_price"], low)
        favorable = entry_price - position["best_price"]

    stop_distance = position["stop_distance"]
    breakeven_at_r = policy.get("breakeven_at_r")
    if (
        breakeven_at_r is not None
        and stop_distance is not None
        and stop_distance > 0
        and not position["breakeven_done"]
        and favorable >= float(breakeven_at_r) * stop_distance
    ):
        _raise_stop(position, _round_to_tick(entry_price, tick_size), "breakeven")
        position["breakeven_done"] = True

    trailing_distance = position["trailing_distance"]
    if trailing_distance is None:
        return

    activation = policy.get("trailing_activation_r")
    if not position["trailing_active"]:
        if (
            activation is not None
            and stop_distance is not None
            and stop_distance > 0
            and favorable >= float(activation) * stop_distance
        ):
            position["trailing_active"] = True
        else:
            return

    if side == "buy":
        candidate = _round_to_tick(position["best_price"] - trailing_distance, tick_size)
    else:
        candidate = _round_to_tick(position["best_price"] + trailing_distance, tick_size)
    _raise_stop(position, candidate, "trailing")


def _raise_stop(position: dict, candidate: float, source: str) -> None:
    current = position["stop_price"]
    side = position["side"]
    if current is None or (side == "buy" and candidate > current) or (side == "sell" and candidate < current):
        position["stop_price"] = candidate
        position["stop_source"] = source


def _atr_values(df: pd.DataFrame, atr_period: int) -> np.ndarray:
    column = f"atr_{int(atr_period)}"
    if column not in df.columns:
        raise KeyError(
            f"ATR-based exits need '{column}' in the frame. Run indicators first "
            "or set the strategy's atr_period to the column you want."
        )
    return df[column].to_numpy(dtype=np.float64)


def _session_end_flags(index) -> np.ndarray:
    """Flag the last bar of each New York futures session.

    The CME day rolls at 18:00 ET, so evening bars belong to the next session.
    Only intraday data is eligible; a daily bar has no intraday close to flatten
    against.
    """
    if not isinstance(index, pd.DatetimeIndex):
        raise ValueError("exit_at_session_end requires a DatetimeIndex.")
    if len(index) < 2:
        raise ValueError("exit_at_session_end needs at least two bars.")

    local = index
    if local.tz is None:
        local = local.tz_localize("UTC")
    local = local.tz_convert("America/New_York")

    gaps = np.diff(local.asi8) / 1e9
    if np.median(gaps) >= 24 * 60 * 60:
        raise ValueError("exit_at_session_end requires intraday bars.")

    session_key = (local + pd.Timedelta(hours=6)).date
    last_by_session: dict = {}
    for position, key in enumerate(session_key):
        last_by_session[key] = position

    flags = np.zeros(len(index), dtype=np.int32)
    flags[list(last_by_session.values())] = 1
    return flags


def _quote_for_execution_open(
    bar,
    *,
    tick_size: float,
    spread_ticks: int,
    volatile_bar_threshold_ticks: int,
    volatile_bar_extra_ticks: int,
) -> dict:
    synthetic = synthetic_quote_for_bar(
        {
            "close": float(bar["open"]),
            "high": float(bar.get("high", bar["open"])),
            "low": float(bar.get("low", bar["open"])),
        },
        tick_size=tick_size,
        spread_ticks=spread_ticks,
        volatile_bar_threshold_ticks=volatile_bar_threshold_ticks,
        volatile_bar_extra_ticks=volatile_bar_extra_ticks,
    )
    return synthetic.as_dict()


def _quote_for_execution_close(
    bar,
    *,
    tick_size: float,
    spread_ticks: int,
    volatile_bar_threshold_ticks: int,
    volatile_bar_extra_ticks: int,
) -> dict:
    synthetic = synthetic_quote_for_bar(
        {
            "close": float(bar["close"]),
            "high": float(bar.get("high", bar["close"])),
            "low": float(bar.get("low", bar["close"])),
        },
        tick_size=tick_size,
        spread_ticks=spread_ticks,
        volatile_bar_threshold_ticks=volatile_bar_threshold_ticks,
        volatile_bar_extra_ticks=volatile_bar_extra_ticks,
    )
    return synthetic.as_dict()


def _flatten_price_for_position(side: str, quote: dict) -> float:
    return round(float(quote["bid"] if side == "buy" else quote["ask"]), 10)


def _round_to_tick(price: float, tick_size: float) -> float:
    return round(round(price / tick_size) * tick_size, 10)


def _apply_slippage(
    price: float,
    *,
    side: str,
    action: str,
    tick_size: float,
    slippage_ticks: float,
) -> float:
    direction = 1 if side == "buy" else -1
    if action == "exit":
        direction *= -1
    return _round_to_tick(price + direction * slippage_ticks * tick_size, tick_size)


def _position_pnl(
    *,
    side: str,
    entry_price: float,
    exit_price: float,
    quantity: int,
    tick_size: float,
    tick_value: float,
    commission: float,
) -> float:
    direction = 1 if side == "buy" else -1
    ticks = direction * (exit_price - entry_price) / tick_size
    return (ticks * tick_value - commission) * quantity


def _coerce_position_size(value) -> int:
    """Backtests trade whole contracts only; accept 1.0 but reject 1.5."""
    if isinstance(value, bool):
        raise ValueError("position_size must be a positive whole number of contracts.")
    try:
        numeric = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("position_size must be a positive whole number of contracts.") from exc
    if not math.isfinite(numeric) or not numeric.is_integer() or numeric < 1:
        raise ValueError("position_size must be a positive whole number of contracts.")
    return int(numeric)


def _validate_sizing(
    sizing_mode: str,
    *,
    risk_per_trade_pct: float | None,
    max_position_size: int | None,
    has_initial_stop: bool,
) -> str:
    if sizing_mode not in {"fixed", "risk_percent"}:
        raise ValueError("sizing_mode must be 'fixed' or 'risk_percent'.")
    if sizing_mode == "risk_percent":
        if risk_per_trade_pct is None or not math.isfinite(float(risk_per_trade_pct)) or risk_per_trade_pct <= 0:
            raise ValueError("risk_per_trade_pct must be greater than zero for risk-based sizing.")
        if float(risk_per_trade_pct) > 100:
            raise ValueError("risk_per_trade_pct must be 100 or less.")
        if not has_initial_stop:
            raise ValueError("Risk-based sizing requires an initial stop loss.")
    else:
        if risk_per_trade_pct is not None:
            raise ValueError("risk_per_trade_pct requires sizing_mode='risk_percent'.")
        if max_position_size is not None:
            raise ValueError("max_position_size requires sizing_mode='risk_percent'.")
    if max_position_size is not None:
        max_position_size = _coerce_position_size(max_position_size)
    return sizing_mode


def _size_position(
    *,
    sizing_mode: str,
    position_size: int,
    max_position_size: int | None,
    risk_per_trade_pct: float | None,
    balance: float,
    entry_price: float,
    stop_price: float | None,
    tick_size: float,
    tick_value: float,
    commission: float,
) -> dict:
    """Return whole-contract size plus the dollar risk attached to the entry.

    Commission is round-trip per contract and is included in the planned
    risk, so a clean stop-out is approximately -1R rather than slightly worse
    than the configured budget.
    """
    has_stop = stop_price is not None
    stop_ticks = abs(entry_price - stop_price) / tick_size if has_stop else 0.0
    risk_per_contract = stop_ticks * tick_value + commission

    if sizing_mode == "fixed":
        quantity = position_size
        risk_budget = None
        risk_exceeded = False
    else:
        risk_budget = balance * float(risk_per_trade_pct or 0.0) / 100.0
        raw_contracts = (
            math.floor(risk_budget / risk_per_contract)
            if risk_per_contract > 0
            else 1
        )
        quantity = max(1, int(raw_contracts))
        if max_position_size is not None:
            quantity = min(quantity, _coerce_position_size(max_position_size))
        risk_exceeded = quantity * risk_per_contract > risk_budget

    initial_risk = quantity * risk_per_contract if has_stop else None
    return {
        "quantity": quantity,
        "initial_risk": initial_risk,
        "risk_budget": risk_budget,
        "risk_exceeded": risk_exceeded,
    }
