import math
import os
import sys
import unittest

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))

from services.metrics import calculate_metrics


def _trade(pnl: float, entry: str = "2024-01-02T09:30:00", exit_: str = "2024-01-02T10:00:00") -> dict:
    return {"pnl": pnl, "entry_time": entry, "exit_time": exit_}


class MetricsSharpeBasisTests(unittest.TestCase):
    def test_daily_returns_drive_sharpe_when_timestamps_exist(self):
        timestamps = pd.to_datetime([
            "2024-01-02T09:30:00",
            "2024-01-02T16:00:00",
            "2024-01-03T09:30:00",
            "2024-01-03T16:00:00",
            "2024-01-04T09:30:00",
            "2024-01-04T16:00:00",
        ])
        equity = [100_000, 100_050, 100_020, 100_100, 100_080, 100_200]
        trades = [
            _trade(50, "2024-01-02T09:30:00", "2024-01-02T11:00:00"),
            _trade(50, "2024-01-03T09:30:00", "2024-01-03T11:00:00"),
            _trade(100, "2024-01-04T09:30:00", "2024-01-04T11:00:00"),
        ]

        metrics = calculate_metrics(trades, equity, 100_000, equity_timestamps=timestamps)

        end_of_day = np.array([100_050, 100_100, 100_200], dtype=float)
        returns = np.diff(end_of_day) / end_of_day[:-1]
        expected_sharpe = float(np.mean(returns) / np.std(returns, ddof=1) * math.sqrt(252))

        self.assertEqual(metrics["sharpe_basis"], "daily")
        self.assertAlmostEqual(metrics["sharpe_ratio"], round(expected_sharpe, 4), places=4)

    def test_intraday_wiggles_do_not_change_daily_sharpe(self):
        timestamps = pd.to_datetime([
            "2024-01-02T09:30:00",
            "2024-01-02T12:00:00",
            "2024-01-02T16:00:00",
            "2024-01-03T09:30:00",
            "2024-01-03T12:00:00",
            "2024-01-03T16:00:00",
            "2024-01-04T09:30:00",
            "2024-01-04T12:00:00",
            "2024-01-04T16:00:00",
        ])
        calm = [100_000, 100_020, 100_100, 100_050, 100_010, 100_300, 100_150, 100_220, 100_400]
        choppy = [100_000, 99_000, 100_100, 101_500, 99_800, 100_300, 102_000, 98_500, 100_400]
        trades = [
            _trade(100, "2024-01-02T09:30:00", "2024-01-02T15:00:00"),
            _trade(200, "2024-01-03T09:30:00", "2024-01-03T15:00:00"),
            _trade(100, "2024-01-04T09:30:00", "2024-01-04T15:00:00"),
        ]

        calm_metrics = calculate_metrics(trades, calm, 100_000, equity_timestamps=timestamps)
        choppy_metrics = calculate_metrics(trades, choppy, 100_000, equity_timestamps=timestamps)

        self.assertEqual(calm_metrics["sharpe_basis"], "daily")
        self.assertEqual(choppy_metrics["sharpe_basis"], "daily")
        self.assertEqual(calm_metrics["sharpe_ratio"], choppy_metrics["sharpe_ratio"])

    def test_trade_fallback_is_not_annualized(self):
        trades = [_trade(100), _trade(-50), _trade(150)]

        metrics = calculate_metrics(trades, [100_000, 100_100, 100_050, 100_200], 100_000)

        pnls = np.array([100.0, -50.0, 150.0])
        expected = float(np.mean(pnls) / np.std(pnls, ddof=1))

        self.assertEqual(metrics["sharpe_basis"], "trade")
        self.assertAlmostEqual(metrics["sharpe_ratio"], round(expected, 4), places=4)
        self.assertLess(metrics["sharpe_ratio"], expected * math.sqrt(252))

    def test_single_trade_without_timestamps_is_marked_insufficient(self):
        metrics = calculate_metrics([_trade(100)], [100_000, 100_100], 100_000)

        self.assertEqual(metrics["sharpe_basis"], "insufficient")
        self.assertEqual(metrics["sharpe_ratio"], 0.0)
        self.assertEqual(metrics["sortino_ratio"], 0.0)

    def test_mismatched_timestamps_fall_back_instead_of_crashing(self):
        trades = [_trade(100), _trade(-50), _trade(150)]

        metrics = calculate_metrics(
            trades,
            [100_000, 100_100, 100_050, 100_200],
            100_000,
            equity_timestamps=["2024-01-02T09:30:00"],
        )

        self.assertEqual(metrics["sharpe_basis"], "trade")

    def test_daily_sortino_uses_downside_deviation(self):
        timestamps = pd.to_datetime([
            "2024-01-02T16:00:00",
            "2024-01-03T16:00:00",
            "2024-01-04T16:00:00",
        ])
        equity = [100_000, 101_000, 100_500]
        trades = [
            _trade(1_000, "2024-01-02T09:30:00", "2024-01-02T15:00:00"),
            _trade(-500, "2024-01-03T09:30:00", "2024-01-03T15:00:00"),
        ]

        metrics = calculate_metrics(trades, equity, 100_000, equity_timestamps=timestamps)

        returns = np.array([0.01, -500 / 101_000])
        downside = np.minimum(returns, 0.0)
        expected = float(np.mean(returns) / np.sqrt(np.mean(np.square(downside))) * math.sqrt(252))

        self.assertEqual(metrics["sharpe_basis"], "daily")
        self.assertAlmostEqual(metrics["sortino_ratio"], round(expected, 4), places=4)


class MetricsRMultipleTests(unittest.TestCase):
    def test_r_metrics_and_risk_budget_warnings(self):
        trades = [
            {
                "pnl": 100,
                "r_multiple": 2.0,
                "risk_exceeded": False,
                "entry_time": "2024-01-02T09:30:00",
                "exit_time": "2024-01-02T10:00:00",
            },
            {
                "pnl": -50,
                "r_multiple": -1.0,
                "risk_exceeded": True,
                "entry_time": "2024-01-02T10:00:00",
                "exit_time": "2024-01-02T10:30:00",
            },
            {
                "pnl": 25,
                "r_multiple": 0.5,
                "risk_exceeded": False,
                "entry_time": "2024-01-02T10:30:00",
                "exit_time": "2024-01-02T11:00:00",
            },
        ]

        metrics = calculate_metrics(
            trades,
            [100_000, 100_100, 100_050, 100_075],
            100_000,
        )

        self.assertEqual(metrics["avg_r_multiple"], 0.5)
        self.assertEqual(metrics["total_r"], 1.5)
        self.assertEqual(metrics["r_profit_factor"], 2.5)
        self.assertEqual(metrics["risk_budget_exceeded_trades"], 1)

    def test_r_metrics_are_empty_without_defined_risk(self):
        metrics = calculate_metrics(
            [_trade(10)],
            [100_000, 100_010],
            100_000,
        )

        self.assertIsNone(metrics["avg_r_multiple"])
        self.assertIsNone(metrics["total_r"])
        self.assertIsNone(metrics["r_profit_factor"])
        self.assertEqual(metrics["risk_budget_exceeded_trades"], 0)


if __name__ == "__main__":
    unittest.main()
