#!/usr/bin/env python3

import os
import sys
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
sys.modules.setdefault("fastapi", SimpleNamespace(HTTPException=Exception))

from schemas import BacktestRequest
from services.backtest_service import build_backtest_result


def _rules(**overrides) -> dict:
    base = {
        "name": "TopStep 100,000",
        "account_size": 100_000,
        "daily_loss_limit": 0.05,
        "max_drawdown": 0.08,
        "profit_target": 0.08,
        "consistency_rule": False,
        "consistency_threshold": 0.35,
        "drawdown_type": "intraday",
        "min_trading_days": None,
    }
    return {**base, **overrides}


def _request() -> BacktestRequest:
    return BacktestRequest(
        dataset_id="dataset-1",
        strategy={"type": "ma_crossover", "params": {"fast_period": 9, "slow_period": 21}},
        prop_firm_rules=_rules(),
        initial_balance=100_000,
        position_size=1.0,
        commission=5.0,
        tick_size=0.25,
        tick_value=12.5,
        slippage_ticks=1.0,
    )


def _dataset() -> dict:
    index = pd.to_datetime(
        [
            "2024-01-02T09:30:00",
            "2024-01-02T10:00:00",
            "2024-01-02T10:30:00",
            "2024-01-02T11:00:00",
            "2024-01-02T11:30:00",
        ]
    )
    df = pd.DataFrame(
        {
            "open": [100.0, 100.0, 100.0, 100.0, 100.0],
            "close": [100.0, 99.0, 94.5, 95.5, 96.5],
            "signal": [0, 0, 0, 0, 0],
        },
        index=index,
    )
    return {
        "df": df,
        "info": {
            "symbol": "ES",
            "source": "timescaledb",
            "interval": "1min",
            "start_date": "2024-01-02",
            "end_date": "2024-01-02",
        },
    }


class BacktestServiceTests(unittest.TestCase):
    @patch("services.backtest_service.run_backtest")
    @patch("services.backtest_service.generate_signals", side_effect=lambda df, *_args, **_kwargs: df)
    @patch("services.backtest_service.add_all_indicators", side_effect=lambda df, *_args, **_kwargs: df)
    def test_build_backtest_result_stops_at_first_prop_breach(
        self,
        _mock_indicators,
        _mock_signals,
        mock_run_backtest,
    ):
        mock_run_backtest.return_value = {
            "trades": [
                {
                    "trade_id": 0,
                    "entry_time": "2024-01-02T09:35:00",
                    "exit_time": "2024-01-02T10:00:00",
                    "side": "buy",
                    "entry_price": 100.0,
                    "exit_price": 99.0,
                    "pnl": -1_000.0,
                    "status": "closed",
                    "commission": 5.0,
                    "tick_size": 0.25,
                    "tick_value": 12.5,
                    "slippage_ticks": 1.0,
                },
                {
                    "trade_id": 1,
                    "entry_time": "2024-01-02T10:00:00",
                    "exit_time": "2024-01-02T11:30:00",
                    "side": "buy",
                    "entry_price": 99.0,
                    "exit_price": 96.5,
                    "pnl": -2_500.0,
                    "status": "closed",
                    "commission": 5.0,
                    "tick_size": 0.25,
                    "tick_value": 12.5,
                    "slippage_ticks": 1.0,
                },
            ],
            "equity_curve": [100_000.0, 99_000.0, 94_500.0, 96_000.0, 97_500.0],
        }

        result = build_backtest_result(
            _dataset(),
            _request(),
            backtest_id="bt-stop",
            created_at="2026-04-29T12:00:00",
        )

        self.assertEqual(result["backtest_id"], "bt-stop")
        self.assertEqual(result["equity_curve"], [100_000.0, 99_000.0, 94_500.0])
        self.assertEqual(len(result["trades"]), 1)
        self.assertEqual(result["trades"][0]["exit_time"], "2024-01-02T10:00:00")
        self.assertEqual(result["metrics"]["total_pnl"], -5_500.0)
        self.assertEqual(result["metrics"]["total_trades"], 1)
        self.assertAlmostEqual(result["metrics"]["max_drawdown"], 0.055, places=4)

        details = result["prop_firm_eval"]["details"]
        self.assertTrue(details["stopped_at_first_breach"])
        self.assertEqual(details["first_breach_rule"], "daily_loss")
        self.assertEqual(details["first_breach_time"], "2024-01-02T10:30:00")
        self.assertEqual(details["first_breach_equity"], 94_500.0)
        self.assertEqual(details["first_breach_balance"], 99_000.0)
        self.assertEqual(details["first_breach_open_pnl"], -4_500.0)
        self.assertEqual(details["trades_after_breach_ignored"], 1)
        self.assertFalse(result["prop_firm_eval"]["passed"])

    @patch("services.backtest_service.run_backtest")
    @patch("services.backtest_service.generate_signals", side_effect=lambda df, *_args, **_kwargs: df)
    @patch("services.backtest_service.add_all_indicators", side_effect=lambda df, *_args, **_kwargs: df)
    def test_build_backtest_result_keeps_clean_run_intact(
        self,
        _mock_indicators,
        _mock_signals,
        mock_run_backtest,
    ):
        mock_run_backtest.return_value = {
            "trades": [
                {
                    "trade_id": 0,
                    "entry_time": "2024-01-02T09:35:00",
                    "exit_time": "2024-01-02T10:30:00",
                    "side": "buy",
                    "entry_price": 100.0,
                    "exit_price": 101.5,
                    "pnl": 1_500.0,
                    "status": "closed",
                    "commission": 5.0,
                    "tick_size": 0.25,
                    "tick_value": 12.5,
                    "slippage_ticks": 1.0,
                }
            ],
            "equity_curve": [100_000.0, 100_500.0, 101_500.0, 101_500.0, 101_500.0],
        }

        result = build_backtest_result(_dataset(), _request())

        self.assertEqual(len(result["trades"]), 1)
        self.assertEqual(len(result["equity_curve"]), 5)
        self.assertEqual(result["metrics"]["total_pnl"], 1_500.0)
        self.assertNotIn("stopped_at_first_breach", result["prop_firm_eval"]["details"])
        self.assertTrue(result["prop_firm_eval"]["details"]["first_breach_time"] is None)


if __name__ == "__main__":
    unittest.main()
