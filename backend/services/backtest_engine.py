
#Python wrapper for C++ pybind11 kernel
from __future__ import annotations
from typing import List
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

# Public API  

def run_backtest(
    df:              pd.DataFrame,
    initial_balance: float = 100_000,
    position_size:   float = 1.0,
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
) -> dict:
    """Run a next-bar futures backtest from completed-bar signals.

    Legacy `bar` mode still fills at the next bar's open with adverse slippage.
    `synthetic_quotes` mode switches to bid/ask fills built from the same
    spread rules we use in paper/replay. If you turn on `stop_loss_ticks` or
    `take_profit_ticks`, the trade can also exit inside that same bar off its
    `high`/`low`, and I resolve double-hits conservatively by assuming the
    stop got tagged first.
    """
    uses_brackets = _uses_bracket_exits(stop_loss_ticks, take_profit_ticks)
    resolved_execution_mode = normalize_backtest_execution_mode(execution_mode)
    uses_synthetic_quotes = resolved_execution_mode == "synthetic_quotes"
    _validate(df, require_ohlc_range=uses_brackets)

    if _CPP_AVAILABLE and not uses_brackets and not uses_synthetic_quotes:
        try:
            return _run_cpp(
                df,
                initial_balance,
                position_size,
                commission,
                tick_size,
                tick_value,
                slippage_ticks,
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
    )

#Internal helpers
def _validate(df: pd.DataFrame, *, require_ohlc_range: bool = False) -> None:
    required = {"open", "close", "signal"}
    if require_ohlc_range:
        required |= {"high", "low"}
    missing  = required - set(df.columns)
    if missing:
        raise KeyError(f"DataFrame is missing required columns: {missing}")


def _uses_bracket_exits(stop_loss_ticks: float | None, take_profit_ticks: float | None) -> bool:
    return stop_loss_ticks is not None or take_profit_ticks is not None

def _iso(index_val) -> str:
    return index_val.isoformat() if hasattr(index_val, "isoformat") else str(index_val)

#C++ path
def _run_cpp(
    df:              pd.DataFrame,
    initial_balance: float,
    position_size:   float,
    commission:      float,
    tick_size:       float,
    tick_value:      float,
    slippage_ticks:  float,
) -> dict:
    """Call the C++ kernel, then stitch timestamps back onto trades."""
    opens = df["open"].to_numpy(dtype=np.float64)
    closes = df["close"].to_numpy(dtype=np.float64)
    signals = df["signal"].to_numpy(dtype=np.int32)

    #Hot loop lives entirely in C++ 
    raw = _core.run_backtest_kernel(
        opens, closes, signals,
        initial_balance, position_size, commission,
        tick_size, tick_value, slippage_ticks,
    )

    #Reconstruct trade dicts
    idx = df.index
    trades: List[dict] = [
        {
            "trade_id":    trade_id,
            "entry_time":  _iso(idx[raw["entry_indices"][trade_id]]),
            "exit_time":   _iso(idx[raw["exit_indices"] [trade_id]]),
            "side":        "buy" if raw["sides"][trade_id] == 1 else "sell",
            "quantity":    position_size,
            "entry_price": float(raw["entry_prices"][trade_id]),
            "exit_price":  float(raw["exit_prices"] [trade_id]),
            "pnl":         float(raw["pnls"]        [trade_id]),
            "status":      "closed",
            "commission":  commission,
            "tick_size":   tick_size,
            "tick_value":  tick_value,
            "slippage_ticks": slippage_ticks,
        }
        for trade_id in range(len(raw["entry_indices"]))
    ]

    return {
        "trades":       trades,
        "equity_curve": raw["equity_curve"].tolist(),
    }


#Pure Python fallback
def _run_python(
    df:              pd.DataFrame,
    initial_balance: float,
    position_size:   float,
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
) -> dict:
    if tick_size <= 0:
        raise ValueError("tick_size must be greater than zero.")

    balance      = initial_balance
    equity_curve: List[float] = [balance]
    trades:      List[dict]   = []
    trade_id     = 0
    position: dict | None = None

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
                pnl = _position_pnl(
                    side=position["side"],
                    entry_price=position["entry_price"],
                    exit_price=exit_price,
                    position_size=position_size,
                    tick_size=tick_size,
                    tick_value=tick_value,
                    commission=commission,
                )
                balance += pnl

                trades.append({
                    "trade_id":    trade_id,
                    "entry_time":  position["entry_time"],
                    "exit_time":   _iso(bar.name),
                    "side":        position["side"],
                    "quantity":    position_size,
                    "entry_price": position["entry_price"],
                    "exit_price":  exit_price,
                    "pnl":         round(pnl, 2),
                    "status":      "closed",
                    "commission":  commission,
                    "tick_size":   tick_size,
                    "tick_value":  tick_value,
                    "slippage_ticks": slippage_ticks,
                })
                trade_id += 1
                position = None

        #Open new position
        if position is None and signal != 0 and i < len(df) - 1:
            side = "buy" if signal == 1 else "sell"
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
            position = {
                "side":        side,
                "entry_price": entry_price,
                "entry_time":  _iso(bar.name),
            }

        bracket_exit_price = None
        if position is not None and _uses_bracket_exits(stop_loss_ticks, take_profit_ticks):
            bracket_exit_price = _get_bracket_exit_price(
                position=position,
                bar=bar,
                tick_size=tick_size,
                slippage_ticks=slippage_ticks,
                stop_loss_ticks=stop_loss_ticks,
                take_profit_ticks=take_profit_ticks,
            )

        if position is not None and bracket_exit_price is not None:
            pnl = _position_pnl(
                side=position["side"],
                entry_price=position["entry_price"],
                exit_price=bracket_exit_price,
                position_size=position_size,
                tick_size=tick_size,
                tick_value=tick_value,
                commission=commission,
            )
            balance += pnl

            trades.append({
                "trade_id":    trade_id,
                "entry_time":  position["entry_time"],
                "exit_time":   _iso(bar.name),
                "side":        position["side"],
                "quantity":    position_size,
                "entry_price": position["entry_price"],
                "exit_price":  bracket_exit_price,
                "pnl":         round(pnl, 2),
                "status":      "closed",
                "commission":  commission,
                "tick_size":   tick_size,
                "tick_value":  tick_value,
                "slippage_ticks": slippage_ticks,
            })
            trade_id += 1
            position = None
            equity_curve.append(round(balance, 2))
            continue

        #Mark-to-market
        if position is not None:
            mark_price = _round_to_tick(float(bar["close"]), tick_size)
            unrealised = _position_pnl(
                side=position["side"],
                entry_price=position["entry_price"],
                exit_price=mark_price,
                position_size=position_size,
                tick_size=tick_size,
                tick_value=tick_value,
                commission=commission,
            )
            equity_curve.append(round(balance + unrealised, 2))
        else:
            equity_curve.append(round(balance, 2))

    #Force-close at final bar
    if position is not None:
        last_bar   = df.iloc[-1]
        if execution_mode == "synthetic_quotes":
            final_quote = _quote_for_execution_close(
                last_bar,
                tick_size=tick_size,
                spread_ticks=spread_ticks,
                volatile_bar_threshold_ticks=volatile_bar_threshold_ticks,
                volatile_bar_extra_ticks=volatile_bar_extra_ticks,
            )
            exit_price = _flatten_price_for_position(position["side"], final_quote)
        else:
            exit_price = _apply_slippage(
                _round_to_tick(float(last_bar["close"]), tick_size),
                side=position["side"],
                action="exit",
                tick_size=tick_size,
                slippage_ticks=slippage_ticks,
            )
        pnl = _position_pnl(
            side=position["side"],
            entry_price=position["entry_price"],
            exit_price=exit_price,
            position_size=position_size,
            tick_size=tick_size,
            tick_value=tick_value,
            commission=commission,
        )
        balance += pnl

        trades.append({
            "trade_id":    trade_id,
            "entry_time":  position["entry_time"],
            "exit_time":   _iso(last_bar.name),
            "side":        position["side"],
            "quantity":    position_size,
            "entry_price": position["entry_price"],
            "exit_price":  exit_price,
            "pnl":         round(pnl, 2),
            "status":      "closed",
            "commission":  commission,
            "tick_size":   tick_size,
            "tick_value":  tick_value,
            "slippage_ticks": slippage_ticks,
        })
        equity_curve[-1] = round(balance, 2)

    return {
        "trades":       trades,
        "equity_curve": equity_curve,
    }


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


def _get_bracket_exit_price(
    *,
    position: dict,
    bar,
    tick_size: float,
    slippage_ticks: float,
    stop_loss_ticks: float | None,
    take_profit_ticks: float | None,
) -> float | None:
    entry_price = float(position["entry_price"])
    side = position["side"]
    high = float(bar["high"])
    low = float(bar["low"])

    stop_price = None
    if stop_loss_ticks is not None:
        offset = stop_loss_ticks * tick_size
        stop_price = _round_to_tick(
            entry_price - offset if side == "buy" else entry_price + offset,
            tick_size,
        )

    target_price = None
    if take_profit_ticks is not None:
        offset = take_profit_ticks * tick_size
        target_price = _round_to_tick(
            entry_price + offset if side == "buy" else entry_price - offset,
            tick_size,
        )

    if side == "buy":
        hit_stop = stop_price is not None and low <= stop_price
        hit_target = target_price is not None and high >= target_price
    else:
        hit_stop = stop_price is not None and high >= stop_price
        hit_target = target_price is not None and low <= target_price

    # If one candle tags both, I assume the worse outcome so the sim stays honest.
    if hit_stop and stop_price is not None:
        return _apply_slippage(
            stop_price,
            side=side,
            action="exit",
            tick_size=tick_size,
            slippage_ticks=slippage_ticks,
        )

    if hit_target and target_price is not None:
        return _apply_slippage(
            target_price,
            side=side,
            action="exit",
            tick_size=tick_size,
            slippage_ticks=slippage_ticks,
        )

    return None


def _position_pnl(
    *,
    side: str,
    entry_price: float,
    exit_price: float,
    position_size: float,
    tick_size: float,
    tick_value: float,
    commission: float,
) -> float:
    direction = 1 if side == "buy" else -1
    ticks = direction * (exit_price - entry_price) / tick_size
    return ticks * tick_value * position_size - commission
