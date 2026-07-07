#!/usr/bin/env python3

"""Experiment runner tests that don't need the Docker/TimescaleDB stack.

`test_experiments.py` exercises the API against a live DB. This file instead
patches the data loader with an in-memory dataset so the new batched
run_experiment path gets checked on any machine: grid expansion, per-plan
results, ranking, and — the important one — that batching the engine phase
produces the exact same numbers as running each plan through the normal
single-backtest pipeline.
"""

import os
import sys
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))

from schemas import BacktestRequest, Strategy
from services import experiment_service
from services.backtest_service import build_backtest_result
from services.experiment_service import run_experiment

TICK = 0.25
N_BARS = 2000


def _dataset() -> dict:
    rng = np.random.RandomState(21)
    steps = rng.randint(-8, 9, size=N_BARS)
    closes = 5_000.0 + TICK * np.cumsum(steps)
    opens = np.roll(closes, 1)
    opens[0] = closes[0]
    df = pd.DataFrame(
        {
            "open": opens,
            "high": np.maximum(opens, closes) + TICK * rng.randint(0, 8, size=N_BARS),
            "low": np.minimum(opens, closes) - TICK * rng.randint(0, 8, size=N_BARS),
            "close": closes,
            "volume": rng.randint(100, 5000, size=N_BARS).astype(float),
        },
        index=pd.date_range("2024-01-02 09:30", periods=N_BARS, freq="1min"),
    )
    return {"df": df, "info": {"symbol": "MES", "interval": "1m", "source": "test"}}


def _experiment() -> dict:
    return {
        "experiment_id": "exp-batch-test",
        "name": "batch parity",
        "symbols": ["MES"],
        "intervals": ["1m"],
        "strategy_type": "ema_crossover",
        "parameter_space": {"fast_period": [5, 9], "slow_period": [15, 21]},
        "start_date": None,
        "end_date": None,
        "prop_firm_rules": {"name": "Test Firm"},
        "initial_balance": 100_000.0,
        "position_size": 1.0,
        "commission": 2.5,
        "slippage_ticks": 1.0,
        "execution_mode": "synthetic_quotes",
        "spread_ticks": 2,
        "volatile_bar_threshold_ticks": 12,
        "volatile_bar_extra_ticks": 1,
        "scoring_rule": "total_pnl",
    }


class ExperimentBatchTests(unittest.TestCase):
    def _run_patched(self, experiment: dict):
        dataset = _dataset()
        dataset_info = {"dataset_id": "ds-batch-test", "tick_size": TICK, "tick_value": 1.25}

        with patch.object(experiment_service, "load_from_db", return_value=dataset_info), patch.object(
            experiment_service, "get_dataset", return_value=dataset
        ), patch("services.db.db_configured", return_value=False):
            return run_experiment(experiment), dataset, dataset_info

    def test_batched_experiment_completes_and_ranks(self):
        (updated, runs), _, _ = self._run_patched(_experiment())

        self.assertEqual(updated["status"], "completed")
        self.assertEqual(updated["total_runs"], 4)
        self.assertEqual(updated["completed_runs"], 4)
        self.assertEqual(updated["failed_runs"], 0)
        self.assertEqual([run["rank"] for run in runs], [1, 2, 3, 4])
        for run in runs:
            self.assertEqual(run["status"], "completed")
            self.assertIsNotNone(run["backtest_id"])
            self.assertIsNotNone(run["score"])

    def test_batched_runs_match_single_backtest_pipeline(self):
        experiment = _experiment()
        (_, runs), dataset, dataset_info = self._run_patched(experiment)

        # Re-run every plan through the untouched single-run pipeline and
        # demand the same numbers the batch path saved.
        for run in runs:
            request = BacktestRequest(
                dataset_id=dataset_info["dataset_id"],
                strategy=Strategy(type=experiment["strategy_type"], params=run["strategy_params"]),
                prop_firm_rules=experiment["prop_firm_rules"],
                initial_balance=experiment["initial_balance"],
                position_size=experiment["position_size"],
                commission=experiment["commission"],
                slippage_ticks=experiment["slippage_ticks"],
                tick_size=dataset_info["tick_size"],
                tick_value=dataset_info["tick_value"],
                execution_mode=experiment["execution_mode"],
                spread_ticks=experiment["spread_ticks"],
                volatile_bar_threshold_ticks=experiment["volatile_bar_threshold_ticks"],
                volatile_bar_extra_ticks=experiment["volatile_bar_extra_ticks"],
            )
            reference = build_backtest_result(dataset, request)

            self.assertEqual(run["metrics"], reference["metrics"], f"params {run['strategy_params']} drifted")
            self.assertEqual(run["total_pnl"], reference["metrics"]["total_pnl"])
            self.assertEqual(
                run["prop_firm_eval"]["passed"],
                reference["prop_firm_eval"]["passed"],
            )

    def test_bad_plan_fails_alone_without_sinking_the_batch(self):
        experiment = _experiment()
        # A non-numeric period blows up indicator prep for exactly half the
        # grid. (A zero period doesn't cut it — that just makes a NaN column
        # and a trade-free run, which still counts as completed.)
        experiment["parameter_space"] = {"fast_period": [5], "slow_period": ["junk", 21]}

        (updated, runs), _, _ = self._run_patched(experiment)

        self.assertEqual(updated["status"], "completed")
        self.assertEqual(updated["completed_runs"], 1)
        self.assertEqual(updated["failed_runs"], 1)
        failed = [run for run in runs if run["status"] == "failed"]
        self.assertEqual(len(failed), 1)
        self.assertIsNotNone(failed[0]["error"])


if __name__ == "__main__":
    unittest.main()
