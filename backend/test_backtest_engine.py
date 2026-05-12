#!/usr/bin/env python3

import os
import sys
import unittest
from unittest.mock import patch

import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))

from services.backtest_engine import run_backtest


def _bars(
    *,
    high: float,
    low: float,
    close: float,
    signal: int = 1,
) -> pd.DataFrame:
    index = pd.to_datetime(
        [
            "2024-01-02T09:30:00",
            "2024-01-02T09:31:00",
            "2024-01-02T09:32:00",
        ]
    )
    return pd.DataFrame(
        {
            "open": [100.0, 100.0, 100.0],
            "high": [100.0, high, 100.0],
            "low": [100.0, low, 100.0],
            "close": [100.0, close, 100.0],
            "signal": [signal, 0, 0],
        },
        index=index,
    )


class BacktestEngineBracketTests(unittest.TestCase):
    def test_trade_records_carry_position_size(self):
        df = _bars(high=101.0, low=99.0, close=100.0)

        result = run_backtest(
            df,
            initial_balance=100.0,
            position_size=3.0,
            commission=0.0,
            tick_size=1.0,
            tick_value=1.0,
            slippage_ticks=0.0,
        )

        self.assertEqual(len(result["trades"]), 1)
        self.assertEqual(result["trades"][0]["quantity"], 3.0)

    def test_stop_loss_wins_when_one_bar_hits_both_levels(self):
        df = _bars(high=105.0, low=95.0, close=102.0)

        result = run_backtest(
            df,
            initial_balance=100.0,
            commission=0.0,
            tick_size=1.0,
            tick_value=1.0,
            slippage_ticks=0.0,
            stop_loss_ticks=4.0,
            take_profit_ticks=4.0,
        )

        self.assertEqual(len(result["trades"]), 1)
        self.assertEqual(result["trades"][0]["exit_price"], 96.0)
        self.assertEqual(result["trades"][0]["pnl"], -4.0)
        self.assertEqual(result["equity_curve"], [100.0, 96.0, 96.0])

    def test_take_profit_can_close_inside_entry_bar(self):
        df = _bars(high=104.0, low=99.0, close=103.0)

        result = run_backtest(
            df,
            initial_balance=100.0,
            commission=0.0,
            tick_size=1.0,
            tick_value=1.0,
            slippage_ticks=0.0,
            take_profit_ticks=4.0,
        )

        self.assertEqual(len(result["trades"]), 1)
        self.assertEqual(result["trades"][0]["exit_price"], 104.0)
        self.assertEqual(result["trades"][0]["pnl"], 4.0)
        self.assertEqual(result["equity_curve"], [100.0, 104.0, 104.0])

    def test_bracketed_runs_skip_cpp_path(self):
        df = _bars(high=104.0, low=99.0, close=103.0)

        with patch("services.backtest_engine._CPP_AVAILABLE", True), patch(
            "services.backtest_engine._run_cpp",
            side_effect=AssertionError("C++ path should not run for bracket exits"),
        ):
            result = run_backtest(
                df,
                initial_balance=100.0,
                commission=0.0,
                tick_size=1.0,
                tick_value=1.0,
                slippage_ticks=0.0,
                take_profit_ticks=4.0,
            )

        self.assertEqual(result["trades"][0]["exit_price"], 104.0)

    def test_synthetic_quote_mode_changes_fills_vs_bar_mode(self):
        df = _bars(high=104.0, low=99.0, close=100.0)

        bar_mode = run_backtest(
            df,
            initial_balance=100.0,
            commission=0.0,
            tick_size=1.0,
            tick_value=1.0,
            slippage_ticks=0.0,
            execution_mode="bar",
        )
        quote_mode = run_backtest(
            df,
            initial_balance=100.0,
            commission=0.0,
            tick_size=1.0,
            tick_value=1.0,
            slippage_ticks=0.0,
            execution_mode="synthetic_quotes",
            spread_ticks=2,
        )

        self.assertEqual(bar_mode["trades"][0]["entry_price"], 100.0)
        self.assertEqual(bar_mode["trades"][0]["exit_price"], 100.0)
        self.assertEqual(bar_mode["trades"][0]["pnl"], 0.0)
        self.assertEqual(quote_mode["trades"][0]["entry_price"], 101.0)
        self.assertEqual(quote_mode["trades"][0]["exit_price"], 99.0)
        self.assertEqual(quote_mode["trades"][0]["pnl"], -2.0)

    def test_synthetic_quote_runs_skip_cpp_path(self):
        df = _bars(high=104.0, low=99.0, close=100.0)

        with patch("services.backtest_engine._CPP_AVAILABLE", True), patch(
            "services.backtest_engine._run_cpp",
            side_effect=AssertionError("C++ path should not run for synthetic quote mode"),
        ):
            result = run_backtest(
                df,
                initial_balance=100.0,
                commission=0.0,
                tick_size=1.0,
                tick_value=1.0,
                slippage_ticks=0.0,
                execution_mode="synthetic_quotes",
                spread_ticks=2,
            )

        self.assertEqual(result["trades"][0]["entry_price"], 101.0)


if __name__ == "__main__":
    unittest.main()
