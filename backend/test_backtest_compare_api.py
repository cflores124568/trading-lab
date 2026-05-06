#!/usr/bin/env python3

import atexit
import os
import sys
import unittest

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(__file__))

_original_database_url = os.environ.get("DATABASE_URL")
os.environ["DATABASE_URL"] = ""


def _restore_database_url() -> None:
    if _original_database_url is None:
        os.environ.pop("DATABASE_URL", None)
    else:
        os.environ["DATABASE_URL"] = _original_database_url


atexit.register(_restore_database_url)

from main import app


def _topstep_rules() -> dict:
    return {
        "name": "TopStep 100,000",
        "account_size": 100_000,
        "daily_loss_limit": 0.05,
        "max_drawdown": 0.08,
        "profit_target": 0.08,
        "consistency_rule": True,
        "consistency_threshold": 0.35,
        "drawdown_type": "intraday",
        "min_trading_days": 30,
    }


class BacktestCompareApiTests(unittest.TestCase):
    def test_compare_keeps_old_vs_new_execution_assumptions(self):
        with TestClient(app) as client:
            sample = client.post(
                "/api/data/sample",
                params={"name": "compare_execution_contract", "bars": 1200, "interval": "1min", "seed": 33},
            )
            self.assertEqual(sample.status_code, 200, sample.text)
            dataset_id = sample.json()["dataset_id"]

            base_payload = {
                "dataset_id": dataset_id,
                "strategy": {"type": "ma_crossover", "params": {"fast_period": 9, "slow_period": 21}},
                "prop_firm_rules": _topstep_rules(),
                "initial_balance": 100_000,
                "position_size": 1.0,
                "commission": 5.0,
                "tick_size": 0.25,
                "tick_value": 12.5,
                "slippage_ticks": 1.0,
            }

            bar_mode = client.post("/api/backtests/", json=base_payload)
            self.assertEqual(bar_mode.status_code, 200, bar_mode.text)
            bar_backtest = bar_mode.json()

            quote_payload = {
                **base_payload,
                "slippage_ticks": 2.0,
                "execution_mode": "synthetic_quotes",
                "spread_ticks": 2,
                "volatile_bar_threshold_ticks": 10,
                "volatile_bar_extra_ticks": 1,
            }
            quote_mode = client.post("/api/backtests/", json=quote_payload)
            self.assertEqual(quote_mode.status_code, 200, quote_mode.text)
            quote_backtest = quote_mode.json()

            compare = client.get(
                f"/api/backtests/compare?a={bar_backtest['backtest_id']}&b={quote_backtest['backtest_id']}"
            )
            self.assertEqual(compare.status_code, 200, compare.text)
            payload = compare.json()

            run_a = payload["backtest_a"]["run_config"]
            run_b = payload["backtest_b"]["run_config"]

            self.assertEqual(run_a["execution_mode"], "bar")
            self.assertEqual(run_a["spread_ticks"], 1)
            self.assertEqual(run_a["volatile_bar_threshold_ticks"], 0)
            self.assertEqual(run_a["volatile_bar_extra_ticks"], 0)
            self.assertEqual(run_a["slippage_ticks"], 1.0)

            self.assertEqual(run_b["execution_mode"], "synthetic_quotes")
            self.assertEqual(run_b["spread_ticks"], 2)
            self.assertEqual(run_b["volatile_bar_threshold_ticks"], 10)
            self.assertEqual(run_b["volatile_bar_extra_ticks"], 1)
            self.assertEqual(run_b["slippage_ticks"], 2.0)

            self.assertIn("comparison", payload)
            self.assertIn("total_pnl", payload["comparison"])
            self.assertIn("win_rate", payload["comparison"])
            self.assertIn(payload["comparison"]["total_pnl"]["winner"], ["a", "b", "tie"])


if __name__ == "__main__":
    unittest.main()
