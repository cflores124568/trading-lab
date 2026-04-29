
#Python wrapper for C++ pybind11 kernel
from __future__ import annotations
from typing import List
import numpy as np
import pandas as pd

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
) -> dict:
    """Run a next-bar futures backtest from completed-bar signals.

    A signal on one bar fills at the next bar's open, rounded to the contract's
    tick size with adverse slippage applied. PnL is calculated in ticks, not raw
    price points, and `commission` is treated as one round-trip cost per closed
    trade. Open equity includes the estimated exit cost so drawdown isn't too
    cute while a trade is still alive.
    """
    _validate(df)

    if _CPP_AVAILABLE:
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
    )

#Internal helpers
def _validate(df: pd.DataFrame) -> None:
    required = {"open", "close", "signal"}
    missing  = required - set(df.columns)
    if missing:
        raise KeyError(f"DataFrame is missing required columns: {missing}")

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
        execution_base = _round_to_tick(float(bar["open"]), tick_size)

        # A flip closes the old trade and opens the new one at the next bar open.
        if position is not None:
            should_close = (
                (position["side"] == "buy"  and signal == -1) or
                (position["side"] == "sell" and signal ==  1)
            )
            if should_close:
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
    position_size: float,
    tick_size: float,
    tick_value: float,
    commission: float,
) -> float:
    direction = 1 if side == "buy" else -1
    ticks = direction * (exit_price - entry_price) / tick_size
    return ticks * tick_value * position_size - commission
