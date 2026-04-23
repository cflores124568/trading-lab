#!/usr/bin/env python3

import json
import unittest

from services.prop_firm_eval import evaluate_prop_firm


def _trade(day: str, pnl: float) -> dict:
    return {
        "trade_id": 1,
        "entry_time": f"{day}T14:30:00",
        "exit_time": f"{day}T15:00:00",
        "side": "buy",
        "entry_price": 100.0,
        "exit_price": 101.0,
        "pnl": pnl,
        "status": "closed",
        "commission": 5.0,
    }


class PropFirmEvalTests(unittest.TestCase):
    def test_min_trading_days_fails_when_run_finishes_too_early(self):
        rules = {
            "name": "Replay Test",
            "account_size": 100_000,
            "daily_loss_limit": 0.05,
            "max_drawdown": 0.10,
            "profit_target": 0.01,
            "consistency_rule": False,
            "consistency_threshold": 0.30,
            "drawdown_type": "intraday",
            "min_trading_days": 3,
        }
        trades = [
            _trade("2024-01-02", 600),
            _trade("2024-01-03", 600),
        ]

        result = evaluate_prop_firm(rules, trades, [100_000, 100_600, 101_200], 100_000)

        self.assertFalse(result["passed"])
        self.assertFalse(result["daily_loss_breached"])
        self.assertFalse(result["drawdown_breached"])
        self.assertTrue(result["profit_target_hit"])
        self.assertFalse(result["min_trading_days_passed"])
        self.assertEqual(result["details"]["min_trading_days_required"], 3)
        self.assertEqual(result["details"]["trading_days_completed"], 2)

    def test_min_trading_days_passes_once_enough_days_are_traded(self):
        rules = {
            "name": "Replay Test",
            "account_size": 100_000,
            "daily_loss_limit": 0.05,
            "max_drawdown": 0.10,
            "profit_target": 0.01,
            "consistency_rule": False,
            "consistency_threshold": 0.30,
            "drawdown_type": "intraday",
            "min_trading_days": 3,
        }
        trades = [
            _trade("2024-01-02", 400),
            _trade("2024-01-03", 400),
            _trade("2024-01-04", 400),
        ]

        result = evaluate_prop_firm(rules, trades, [100_000, 100_400, 100_800, 101_200], 100_000)

        self.assertTrue(result["passed"])
        self.assertTrue(result["profit_target_hit"])
        self.assertTrue(result["min_trading_days_passed"])
        self.assertEqual(result["details"]["trading_days_completed"], 3)

    def test_result_stays_json_safe_when_numpy_scalars_show_up(self):
        rules = {
            "name": "Replay Test",
            "account_size": 100_000,
            "daily_loss_limit": 0.05,
            "max_drawdown": 0.10,
            "profit_target": 0.01,
            "consistency_rule": True,
            "consistency_threshold": 0.30,
            "drawdown_type": "intraday",
            "min_trading_days": 1,
        }
        trades = [
            _trade("2024-01-02", 400),
            _trade("2024-01-03", 800),
        ]

        result = evaluate_prop_firm(rules, trades, [100_000, 100_400, 101_200], 100_000)

        self.assertIsInstance(result["passed"], bool)
        self.assertIsInstance(result["profit_target_hit"], bool)
        self.assertIsInstance(result["drawdown_breached"], bool)
        json.dumps(result)


if __name__ == "__main__":
    unittest.main()
