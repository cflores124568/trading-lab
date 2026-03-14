
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
    tick_value:      float = 12.50,
) -> dict:
    """
    Walk through bar-by-bar signals, manage a single position, apply
    commission, record every trade, and build the equity curve.

    Parameters
    ----------
    df              : DataFrame with OHLCV columns + an integer 'signal' column
                      (+1 = buy, -1 = sell, 0 = flat)
    initial_balance : starting account equity
    position_size   : contracts per trade
    commission      : round-trip cost deducted per trade
    tick_value      : dollar value per point per contract

    Returns
    -------
    {
        "trades":       list[dict],   — one dict per completed trade
        "equity_curve": list[float],  — mark-to-market balance per bar
    }
    """
    _validate(df)

    if _CPP_AVAILABLE:
        return _run_cpp(df, initial_balance, position_size, commission, tick_value)
    else:
        return _run_python(df, initial_balance, position_size, commission, tick_value)

#Internal helpers
def _validate(df: pd.DataFrame) -> None:
    required = {"close", "signal"}
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
    tick_value:      float,
) -> dict:
    """
    Prepare numpy arrays, call the C++ kernel, then reconstruct trade dicts
    with timestamps from the DataFrame index.
    """
    closes  = df["close"].to_numpy(dtype=np.float64)
    signals = df["signal"].to_numpy(dtype=np.int32)

    #Hot loop lives entirely in C++ 
    raw = _core.run_backtest_kernel(
        closes, signals,
        initial_balance, position_size, commission, tick_value,
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
    tick_value:      float,
) -> dict:
    balance      = initial_balance
    equity_curve: List[float] = [balance]
    trades:      List[dict]   = []
    trade_id     = 0
    position: dict | None = None

    for i in range(1, len(df)):
        bar    = df.iloc[i]
        signal = int(bar.get("signal", 0))

        # Close existing position if signal flipped
        if position is not None:
            should_close = (
                (position["side"] == "buy"  and signal == -1) or
                (position["side"] == "sell" and signal ==  1)
            )
            if should_close:
                exit_price = bar["close"]
                if position["side"] == "buy":
                    pnl = (exit_price - position["entry_price"]) * position_size * tick_value
                else:
                    pnl = (position["entry_price"] - exit_price) * position_size * tick_value
                pnl -= commission
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
                })
                trade_id += 1
                position = None

        #Open new position
        if position is None and signal != 0:
            position = {
                "side":        "buy" if signal == 1 else "sell",
                "entry_price": bar["close"],
                "entry_time":  _iso(bar.name),
            }
            balance -= commission

        #Mark-to-market
        if position is not None:
            if position["side"] == "buy":
                unrealised = (bar["close"] - position["entry_price"]) * position_size * tick_value
            else:
                unrealised = (position["entry_price"] - bar["close"]) * position_size * tick_value
            equity_curve.append(round(balance + unrealised, 2))
        else:
            equity_curve.append(round(balance, 2))

    #Force-close at final bar
    if position is not None:
        last_bar   = df.iloc[-1]
        exit_price = last_bar["close"]
        if position["side"] == "buy":
            pnl = (exit_price - position["entry_price"]) * position_size * tick_value
        else:
            pnl = (position["entry_price"] - exit_price) * position_size * tick_value
        pnl -= commission
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
        })
        equity_curve[-1] = round(balance, 2)

    return {
        "trades":       trades,
        "equity_curve": equity_curve,
    }