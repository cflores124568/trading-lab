#!/usr/bin/env python3

import os
import sys
import unittest

import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))

from services.strategy import generate_signals


class StrategyFilterTests(unittest.TestCase):
    def test_shared_filters_can_block_a_countertrend_signal(self):
        index = pd.date_range("2024-01-02 09:30:00", periods=3, freq="min")
        df = pd.DataFrame(
            {
                "close": [100.0, 100.0, 101.0],
                "sma_9": [100.0, 102.0, 103.0],
                "sma_21": [101.0, 101.0, 102.0],
                "ema_50": [101.0, 101.0, 101.0],
                "vwap": [100.5, 101.0, 101.0],
                "atr_14": [1.0, 1.0, 1.0],
            },
            index=index,
        )

        result = generate_signals(
            df,
            "ma_crossover",
            {
                "fast_period": 9,
                "slow_period": 21,
                "trend_ema_period": 50,
                "vwap_bias": 1,
            },
        )

        self.assertEqual(result["signal"].tolist(), [0, 0, 0])

    def test_min_atr_percent_filters_out_dead_bars(self):
        index = pd.date_range("2024-01-02 09:30:00", periods=3, freq="min")
        df = pd.DataFrame(
            {
                "close": [100.0, 95.0, 101.0],
                "bb_lower": [99.0, 96.0, 99.0],
                "bb_upper": [101.0, 104.0, 103.0],
                "atr_14": [0.6, 0.2, 0.6],
            },
            index=index,
        )

        result = generate_signals(
            df,
            "bollinger_bands",
            {"bb_period": 20, "std_dev": 2.0, "min_atr_percent": 0.5},
        )

        self.assertEqual(result["signal"].tolist(), [0, 0, 0])

    def test_cooldown_bars_suppresses_the_next_setup(self):
        index = pd.date_range("2024-01-02 09:30:00", periods=5, freq="min")
        df = pd.DataFrame(
            {
                "close": [100.0, 95.0, 100.0, 105.0, 100.0],
                "bb_lower": [99.0, 96.0, 99.0, 99.0, 99.0],
                "bb_upper": [101.0, 104.0, 101.0, 104.0, 101.0],
            },
            index=index,
        )

        result = generate_signals(
            df,
            "bollinger_bands",
            {"bb_period": 20, "std_dev": 2.0, "cooldown_bars": 2},
        )

        self.assertEqual(result["signal"].tolist(), [0, 1, 0, 0, 0])


if __name__ == "__main__":
    unittest.main()
