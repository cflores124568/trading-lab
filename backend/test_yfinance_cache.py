#!/usr/bin/env python3

import os
import sys
import unittest
from unittest import mock

import pandas as pd
from fastapi import HTTPException

sys.path.insert(0, os.path.dirname(__file__))

from services import data_loader


def _bars() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "timestamp": ["2026-09-30 14:00:00"],
            "Open": [100.0],
            "High": [101.0],
            "Low": [99.0],
            "Close": [100.5],
            "Volume": [10.0],
        }
    )


class YfinanceCacheTests(unittest.TestCase):
    def setUp(self):
        data_loader._yfinance_cache.clear()

    def test_repeat_request_within_a_minute_reuses_the_fetch(self):
        with mock.patch.object(
            data_loader, "fetch_yfinance_intraday", return_value=(_bars(), {"rows": 1})
        ) as fetch, mock.patch.object(data_loader.time, "monotonic", side_effect=[100.0, 130.0]):
            data_loader.fetch_yfinance_intraday_cached("NQ", "15m", "30d")
            data_loader.fetch_yfinance_intraday_cached("NQ", "15m", "30d")

        self.assertEqual(fetch.call_count, 1)

    def test_expired_entry_is_fetched_again(self):
        with mock.patch.object(
            data_loader, "fetch_yfinance_intraday", return_value=(_bars(), {"rows": 1})
        ) as fetch, mock.patch.object(
            data_loader.time, "monotonic", side_effect=[100.0, 161.0, 161.0]
        ):
            data_loader.fetch_yfinance_intraday_cached("NQ", "15m", "30d")
            data_loader.fetch_yfinance_intraday_cached("NQ", "15m", "30d")

        self.assertEqual(fetch.call_count, 2)

    def test_callers_get_their_own_copy(self):
        with mock.patch.object(
            data_loader, "fetch_yfinance_intraday", return_value=(_bars(), {"rows": 1})
        ), mock.patch.object(data_loader.time, "monotonic", side_effect=[100.0, 110.0]):
            first, _ = data_loader.fetch_yfinance_intraday_cached("ES", "5m", "7d")
            first.columns = first.columns.str.lower()
            second, _ = data_loader.fetch_yfinance_intraday_cached("ES", "5m", "7d")

        self.assertIn("Close", second.columns)

    def test_failures_are_not_cached(self):
        with mock.patch.object(
            data_loader,
            "fetch_yfinance_intraday",
            side_effect=[HTTPException(503, "yfinance fetch failed"), (_bars(), {"rows": 1})],
        ) as fetch, mock.patch.object(data_loader.time, "monotonic", side_effect=[100.0, 101.0]):
            with self.assertRaises(HTTPException):
                data_loader.fetch_yfinance_intraday_cached("NQ", "5m", "7d")
            df, _ = data_loader.fetch_yfinance_intraday_cached("NQ", "5m", "7d")

        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(len(df), 1)


if __name__ == "__main__":
    unittest.main()
