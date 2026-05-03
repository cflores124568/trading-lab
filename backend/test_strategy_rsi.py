#!/usr/bin/env python3

import os
import sys
import unittest

import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))

from services.strategy import generate_signals


class StrategyRsiTests(unittest.TestCase):
    def test_rsi_strategy_reads_rsi_period_param(self):
        index = pd.date_range("2024-01-02 09:30:00", periods=3, freq="min")
        df = pd.DataFrame(
            {
                "close": [100.0, 99.0, 101.0],
                "rsi_10": [40.0, 29.0, 35.0],
                "rsi_14": [40.0, 35.0, 35.0],
            },
            index=index,
        )

        result = generate_signals(
            df,
            "rsi_overbought",
            {"rsi_period": 10, "oversold": 30, "overbought": 70},
        )

        self.assertEqual(result["signal"].tolist(), [0, 1, 0])


if __name__ == "__main__":
    unittest.main()
