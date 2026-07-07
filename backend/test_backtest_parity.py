#!/usr/bin/env python3

"""Parity harness: the C++ kernel must match the Python oracle exactly.

The Python loop in `backtest_engine._run_python` is the reference
implementation. This test throws a deterministic tick-aligned random walk at
both engines across every execution mode combo and demands identical trades
and equity curves, down to the float. If this fails after touching
`backtest_core.cpp`, the kernel drifted — fix the C++, not the test.
"""

import os
import sys
import unittest

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))

from services.backtest_engine import (
    _CPP_AVAILABLE,
    _CPP_BATCH_AVAILABLE,
    _run_cpp,
    _run_python,
    run_backtest_batch,
)

TICK = 0.25
N_BARS = 4000


def _random_walk_bars() -> pd.DataFrame:
    # Everything stays on the 0.25 tick grid so both engines work with exactly
    # representable floats and parity can be checked with == instead of tolerances.
    rng = np.random.RandomState(42)
    steps = rng.randint(-8, 9, size=N_BARS)
    closes = 20_000.0 + TICK * np.cumsum(steps)
    opens = np.roll(closes, 1)
    opens[0] = closes[0]
    highs = np.maximum(opens, closes) + TICK * rng.randint(0, 16, size=N_BARS)
    lows = np.minimum(opens, closes) - TICK * rng.randint(0, 16, size=N_BARS)

    signals = np.zeros(N_BARS, dtype=int)
    signal_idx = rng.choice(N_BARS, size=400, replace=False)
    signals[signal_idx] = rng.choice([-1, 1], size=400)

    return pd.DataFrame(
        {
            "open": opens,
            "high": highs,
            "low": lows,
            "close": closes,
            "signal": signals,
        },
        index=pd.date_range("2024-01-02 09:30", periods=N_BARS, freq="1min"),
    )


@unittest.skipUnless(_CPP_AVAILABLE, "compiled backtest_core module not available")
class KernelParityTests(unittest.TestCase):
    # (execution_mode, stop_loss_ticks, take_profit_ticks)
    MODE_COMBOS = [
        ("bar", None, None),
        ("bar", 20.0, None),
        ("bar", None, 30.0),
        ("bar", 20.0, 30.0),
        ("synthetic_quotes", None, None),
        ("synthetic_quotes", 20.0, 30.0),
    ]

    def test_cpp_matches_python_oracle_in_every_mode(self):
        df = _random_walk_bars()

        for execution_mode, stop_ticks, tp_ticks in self.MODE_COMBOS:
            with self.subTest(mode=execution_mode, stop=stop_ticks, tp=tp_ticks):
                common = dict(
                    initial_balance=100_000.0,
                    position_size=2.0,
                    commission=5.0,
                    tick_size=TICK,
                    tick_value=12.5,
                    slippage_ticks=1.0,
                )
                spread = dict(
                    spread_ticks=2,
                    volatile_bar_threshold_ticks=12,
                    volatile_bar_extra_ticks=1,
                )

                cpp = _run_cpp(
                    df,
                    *common.values(),
                    stop_loss_ticks=stop_ticks,
                    take_profit_ticks=tp_ticks,
                    use_synthetic_quotes=execution_mode == "synthetic_quotes",
                    **spread,
                )
                oracle = _run_python(
                    df,
                    *common.values(),
                    stop_loss_ticks=stop_ticks,
                    take_profit_ticks=tp_ticks,
                    execution_mode=execution_mode,
                    **spread,
                )

                self.assertGreater(len(oracle["trades"]), 10, "oracle produced too few trades to prove anything")
                self.assertEqual(len(cpp["trades"]), len(oracle["trades"]))
                for cpp_trade, py_trade in zip(cpp["trades"], oracle["trades"]):
                    for field in ("entry_time", "exit_time", "side", "quantity", "entry_price", "exit_price", "pnl"):
                        self.assertEqual(cpp_trade[field], py_trade[field], f"trade field '{field}' drifted")

                self.assertEqual(cpp["equity_curve"], oracle["equity_curve"])


@unittest.skipUnless(_CPP_BATCH_AVAILABLE, "compiled batch entry point not available")
class BatchParityTests(unittest.TestCase):
    def test_batch_matches_python_oracle_per_run(self):
        df = _random_walk_bars()
        base_signals = df["signal"].to_numpy()

        # A handful of distinct signal variants, like a small parameter grid
        # would produce over one shared dataset.
        rng = np.random.RandomState(11)
        signal_arrays = [np.roll(base_signals, shift) for shift in (0, 3, 7, 13)]
        signal_arrays += [base_signals * rng.choice([0, 1], size=N_BARS) for _ in range(4)]

        for execution_mode, stop_ticks, tp_ticks in [
            ("bar", None, None),
            ("bar", 20.0, 30.0),
            ("synthetic_quotes", None, None),
            ("synthetic_quotes", 20.0, 30.0),
        ]:
            with self.subTest(mode=execution_mode, stop=stop_ticks, tp=tp_ticks):
                config = dict(
                    initial_balance=100_000.0,
                    position_size=2.0,
                    commission=5.0,
                    tick_size=TICK,
                    tick_value=12.5,
                    slippage_ticks=1.0,
                    stop_loss_ticks=stop_ticks,
                    take_profit_ticks=tp_ticks,
                    spread_ticks=2,
                    volatile_bar_threshold_ticks=12,
                    volatile_bar_extra_ticks=1,
                )

                batch = run_backtest_batch(
                    df.drop(columns=["signal"]),
                    signal_arrays,
                    execution_mode=execution_mode,
                    **config,
                )

                self.assertEqual(len(batch), len(signal_arrays))
                for run_index, signals in enumerate(signal_arrays):
                    oracle = _run_python(
                        df.assign(signal=signals),
                        config["initial_balance"],
                        config["position_size"],
                        config["commission"],
                        config["tick_size"],
                        config["tick_value"],
                        config["slippage_ticks"],
                        stop_ticks,
                        tp_ticks,
                        execution_mode,
                        config["spread_ticks"],
                        config["volatile_bar_threshold_ticks"],
                        config["volatile_bar_extra_ticks"],
                    )
                    self.assertEqual(
                        batch[run_index]["trades"], oracle["trades"],
                        f"run {run_index} trades drifted",
                    )
                    self.assertEqual(batch[run_index]["equity_curve"], oracle["equity_curve"])


if __name__ == "__main__":
    unittest.main()
