#!/usr/bin/env python3

import os
import sys
import unittest
from unittest.mock import patch

import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))

from services.backtest_engine import _session_end_flags, run_backtest


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

    def test_bracketed_runs_use_cpp_path(self):
        df = _bars(high=104.0, low=99.0, close=103.0)
        sentinel = {"trades": [], "equity_curve": []}

        with patch("services.backtest_engine._CPP_AVAILABLE", True), patch(
            "services.backtest_engine._run_cpp",
            return_value=sentinel,
        ) as run_cpp:
            result = run_backtest(
                df,
                initial_balance=100.0,
                commission=0.0,
                tick_size=1.0,
                tick_value=1.0,
                slippage_ticks=0.0,
                take_profit_ticks=4.0,
            )

        run_cpp.assert_called_once()
        self.assertIs(result, sentinel)

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

    def test_synthetic_quote_runs_use_cpp_path(self):
        df = _bars(high=104.0, low=99.0, close=100.0)
        sentinel = {"trades": [], "equity_curve": []}

        with patch("services.backtest_engine._CPP_AVAILABLE", True), patch(
            "services.backtest_engine._run_cpp",
            return_value=sentinel,
        ) as run_cpp:
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

        run_cpp.assert_called_once()
        self.assertIs(result, sentinel)

    def test_missing_high_low_falls_back_to_python_for_quote_mode(self):
        df = _bars(high=104.0, low=99.0, close=100.0).drop(columns=["high", "low"])

        with patch("services.backtest_engine._CPP_AVAILABLE", True), patch(
            "services.backtest_engine._run_cpp",
            side_effect=AssertionError("C++ path needs high/low for quote mode"),
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

    def test_missing_high_low_rejects_tick_brackets(self):
        df = _bars(high=104.0, low=99.0, close=100.0).drop(columns=["high", "low"])

        with self.assertRaises(KeyError):
            run_backtest(
                df,
                initial_balance=100.0,
                commission=0.0,
                tick_size=1.0,
                tick_value=1.0,
                slippage_ticks=0.0,
                stop_loss_ticks=4.0,
            )


class BacktestEngineDynamicExitTests(unittest.TestCase):
    def _frame(self, rows, index):
        return pd.DataFrame(rows, index=pd.to_datetime(index))

    def test_atr_stop_sizes_from_prior_bar_atr(self):
        df = self._frame(
            [
                {"open": 100.0, "high": 100.0, "low": 100.0, "close": 100.0, "signal": 1, "atr_14": 2.0},
                {"open": 100.0, "high": 103.0, "low": 97.0, "close": 100.0, "signal": 0, "atr_14": 2.0},
                {"open": 100.0, "high": 100.0, "low": 100.0, "close": 100.0, "signal": 0, "atr_14": 2.0},
            ],
            ["2024-01-02T09:30:00", "2024-01-02T09:31:00", "2024-01-02T09:32:00"],
        )

        result = run_backtest(
            df,
            initial_balance=100.0,
            commission=0.0,
            tick_size=1.0,
            tick_value=1.0,
            slippage_ticks=0.0,
            stop_loss_atr=1.0,
            atr_period=14,
        )

        self.assertEqual(result["trades"][0]["exit_price"], 98.0)
        self.assertEqual(result["trades"][0]["exit_reason"], "stop_loss")

    def test_atr_target_sizes_from_prior_bar_atr(self):
        df = self._frame(
            [
                {"open": 100.0, "high": 100.0, "low": 100.0, "close": 100.0, "signal": 1, "atr_14": 2.0},
                {"open": 100.0, "high": 105.0, "low": 99.0, "close": 100.0, "signal": 0, "atr_14": 2.0},
                {"open": 100.0, "high": 100.0, "low": 100.0, "close": 100.0, "signal": 0, "atr_14": 2.0},
            ],
            ["2024-01-02T09:30:00", "2024-01-02T09:31:00", "2024-01-02T09:32:00"],
        )

        result = run_backtest(
            df,
            initial_balance=100.0,
            commission=0.0,
            tick_size=1.0,
            tick_value=1.0,
            slippage_ticks=0.0,
            take_profit_atr=2.0,
            atr_period=14,
        )

        self.assertEqual(result["trades"][0]["exit_price"], 104.0)
        self.assertEqual(result["trades"][0]["exit_reason"], "take_profit")

    def test_trailing_stop_moves_from_completed_bar_extreme(self):
        df = self._frame(
            [
                {"open": 100.0, "high": 100.0, "low": 100.0, "close": 100.0, "signal": 1},
                {"open": 100.0, "high": 106.0, "low": 99.0, "close": 105.0, "signal": 0},
                {"open": 105.0, "high": 107.0, "low": 100.0, "close": 101.0, "signal": 0},
                {"open": 101.0, "high": 102.0, "low": 90.0, "close": 95.0, "signal": 0},
                {"open": 95.0, "high": 95.0, "low": 95.0, "close": 95.0, "signal": 0},
            ],
            pd.date_range("2024-01-02T09:30:00", periods=5, freq="1min"),
        )

        result = run_backtest(
            df,
            initial_balance=100.0,
            commission=0.0,
            tick_size=1.0,
            tick_value=1.0,
            slippage_ticks=0.0,
            stop_loss_ticks=4.0,
            trailing_stop_ticks=2.0,
        )

        trade = result["trades"][0]
        self.assertEqual(trade["exit_price"], 104.0)
        self.assertEqual(trade["pnl"], 4.0)
        self.assertEqual(trade["exit_reason"], "trailing_stop")

    def test_breakeven_moves_stop_to_entry_after_one_r(self):
        df = self._frame(
            [
                {"open": 100.0, "high": 100.0, "low": 100.0, "close": 100.0, "signal": 1},
                {"open": 100.0, "high": 105.0, "low": 99.0, "close": 103.0, "signal": 0},
                {"open": 103.0, "high": 104.0, "low": 99.0, "close": 100.0, "signal": 0},
                {"open": 100.0, "high": 100.0, "low": 100.0, "close": 100.0, "signal": 0},
            ],
            pd.date_range("2024-01-02T09:30:00", periods=4, freq="1min"),
        )

        result = run_backtest(
            df,
            initial_balance=100.0,
            commission=0.0,
            tick_size=1.0,
            tick_value=1.0,
            slippage_ticks=0.0,
            stop_loss_ticks=4.0,
            breakeven_at_r=1.0,
        )

        trade = result["trades"][0]
        self.assertEqual(trade["exit_price"], 100.0)
        self.assertEqual(trade["pnl"], 0.0)
        self.assertEqual(trade["exit_reason"], "breakeven_stop")

    def test_time_stop_exits_on_nth_bar_close(self):
        df = self._frame(
            [
                {"open": 100.0, "high": 100.0, "low": 100.0, "close": 100.0, "signal": 1},
                {"open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0, "signal": 0},
                {"open": 100.0, "high": 106.0, "low": 100.0, "close": 105.0, "signal": 0},
                {"open": 105.0, "high": 106.0, "low": 104.0, "close": 105.0, "signal": 0},
            ],
            pd.date_range("2024-01-02T09:30:00", periods=4, freq="1min"),
        )

        result = run_backtest(
            df,
            initial_balance=100.0,
            commission=0.0,
            tick_size=1.0,
            tick_value=1.0,
            slippage_ticks=0.0,
            time_stop_bars=2,
        )

        trade = result["trades"][0]
        self.assertEqual(trade["exit_time"], "2024-01-02T09:32:00")
        self.assertEqual(trade["exit_price"], 105.0)
        self.assertEqual(trade["pnl"], 5.0)
        self.assertEqual(trade["exit_reason"], "time_stop")

    def test_session_close_flattens_before_overnight_gap(self):
        df = self._frame(
            [
                {"open": 100.0, "high": 100.0, "low": 100.0, "close": 100.0, "signal": 1},
                {"open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0, "signal": 0},
                {"open": 100.0, "high": 106.0, "low": 100.0, "close": 105.0, "signal": 0},
                {"open": 105.0, "high": 106.0, "low": 104.0, "close": 105.0, "signal": 0},
                {"open": 105.0, "high": 105.0, "low": 105.0, "close": 105.0, "signal": 0},
                {"open": 105.0, "high": 105.0, "low": 105.0, "close": 105.0, "signal": 0},
            ],
            [
                "2024-01-02T09:30:00",
                "2024-01-02T09:31:00",
                "2024-01-02T09:32:00",
                "2024-01-02T09:33:00",
                "2024-01-03T09:30:00",
                "2024-01-03T09:31:00",
            ],
        )

        result = run_backtest(
            df,
            initial_balance=100.0,
            commission=0.0,
            tick_size=1.0,
            tick_value=1.0,
            slippage_ticks=0.0,
            exit_at_session_end=True,
        )

        trade = result["trades"][0]
        self.assertEqual(trade["exit_time"], "2024-01-02T09:33:00")
        self.assertEqual(trade["exit_price"], 105.0)
        self.assertEqual(trade["exit_reason"], "session_close")

    def test_atr_exits_require_atr_column(self):
        df = self._frame(
            [
                {"open": 100.0, "high": 100.0, "low": 100.0, "close": 100.0, "signal": 1},
                {"open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0, "signal": 0},
                {"open": 100.0, "high": 100.0, "low": 100.0, "close": 100.0, "signal": 0},
            ],
            pd.date_range("2024-01-02T09:30:00", periods=3, freq="1min"),
        )

        with self.assertRaises(KeyError):
            run_backtest(
                df,
                initial_balance=100.0,
                commission=0.0,
                tick_size=1.0,
                tick_value=1.0,
                stop_loss_atr=1.0,
            )

    def test_session_flags_follow_the_six_pm_new_york_roll(self):
        index = pd.DatetimeIndex(
            [
                "2024-01-02T17:58:00",
                "2024-01-02T17:59:00",
                "2024-01-02T18:00:00",
                "2024-01-02T18:01:00",
                "2024-01-03T17:59:00",
            ],
            tz="America/New_York",
        )

        self.assertEqual(_session_end_flags(index).tolist(), [0, 1, 0, 0, 1])

    def test_session_close_rejects_daily_bars(self):
        df = self._frame(
            [
                {"open": 100.0, "high": 100.0, "low": 100.0, "close": 100.0, "signal": 1},
                {"open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0, "signal": 0},
                {"open": 100.0, "high": 100.0, "low": 100.0, "close": 100.0, "signal": 0},
            ],
            ["2024-01-02", "2024-01-03", "2024-01-04"],
        )

        with self.assertRaises(ValueError):
            run_backtest(
                df,
                initial_balance=100.0,
                commission=0.0,
                tick_size=1.0,
                tick_value=1.0,
                exit_at_session_end=True,
            )


if __name__ == "__main__":
    unittest.main()
