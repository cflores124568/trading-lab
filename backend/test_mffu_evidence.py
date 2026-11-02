import unittest
from unittest.mock import patch
import os
import time
import json
from pathlib import Path
import pandas as pd
from services.mffu_evidence import assess_mffu_evidence
from services.data_loader import get_candles, _normalise_loaded_frame
from routers.backtests import _df_to_candles


def bar(time, low=5000, high=5000, close=5000):
    return {"time": time, "open": close, "low": low, "high": high, "close": close}


class MffuEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.rules = {"account_size": 50_000, "max_drawdown": .04, "evaluation_model": "mffu_eod", "daily_loss_mode": "breach", "daily_loss_limit": None}

    def assess(self, bars, trades=(), interval="1min", equity=None):
        return assess_mffu_evidence(bars=bars, trades=trades, equity=equity or [50_000] * len(bars), initial_balance=50_000, rules=self.rules, interval=interval, tick_size=1, tick_value=1)

    def test_intrabar_crossing_is_reported_even_after_close_recovers(self):
        bars = [bar("2026-01-05T20:58:00Z"), bar("2026-01-05T20:59:00Z", low=2500)]
        trade = {"entry_time": "2026-01-05T20:58:00Z", "exit_time": "2026-01-05T20:59:00Z", "entry_price": 5000, "side": "buy", "quantity": 1, "commission": 0, "pnl": 0}
        result = self.assess(bars, [trade])
        self.assertTrue(result["possible_intrabar_limit"])
        self.assertEqual(result["first_intrabar_rule"], "maximum_loss")
        self.assertEqual(result["worst_equity"], 47_500)
        self.assertFalse(result["incomplete"])

    def test_soft_pause_intrabar_crossing_is_not_a_confirmed_breach(self):
        self.rules.update(daily_loss_mode="soft_pause", daily_loss_limit=.02)
        bars = [bar("2026-01-05T20:58:00Z"), bar("2026-01-05T20:59:00Z", low=3900)]
        trade = {"entry_time": "2026-01-05T20:58:00Z", "exit_time": "2026-01-05T20:59:00Z", "entry_price": 5000, "side": "buy", "quantity": 1, "commission": 0, "pnl": 0}
        self.assertEqual(self.assess(bars, [trade])["first_intrabar_rule"], "daily_soft_pause")

    def test_short_intrabar_high_is_checked_and_out_of_window_trade_is_flagged(self):
        bars = [bar("2026-01-05T20:58:00Z"), bar("2026-01-05T20:59:00Z", high=7500)]
        trade = {"entry_time": "2026-01-05T20:57:00Z", "exit_time": "2026-01-05T20:59:00Z", "entry_price": 5000, "side": "sell", "quantity": 1, "commission": 0, "pnl": 0}
        result = self.assess(bars, [trade])
        self.assertTrue(result["possible_intrabar_limit"])
        self.assertIn("trade_outside_evidence_window", result["reasons"])

    def test_regular_close_must_align_to_known_bar_end(self):
        bars = [bar("2026-01-05T21:09:00Z"), bar("2026-01-05T23:00:00Z")]
        self.assertFalse(self.assess(bars)["incomplete"])
        result = self.assess(bars, interval="15min")
        self.assertIn("missing_or_unaligned_session_close", result["reasons"])

    def test_cutoff_tracks_daylight_saving_and_partial_final_session(self):
        bars = [bar("2026-03-09T20:09:00Z"), bar("2026-03-09T22:00:00Z")]
        result = self.assess(bars)
        self.assertFalse(result["incomplete"])
        self.assertTrue(result["partial_first_session"])
        self.assertTrue(result["partial_final_session"])

    def test_final_bar_crossing_cutoff_is_not_treated_as_complete(self):
        result = self.assess([bar("2026-01-05T21:00:00Z")], interval="15min")
        self.assertIn("missing_or_unaligned_session_close", result["reasons"])

    def test_mourning_day_early_close_only_flags_equity_index_products(self):
        bars = [bar("2025-01-09T14:00:00Z")]
        args = dict(bars=bars, trades=[], equity=[50_000], initial_balance=50_000,
                    rules=self.rules, interval="1min", tick_size=1, tick_value=1)
        for symbol in ("ES", "MES.c.0", "NQH25", "MNQ"):
            with self.subTest(symbol=symbol):
                result = assess_mffu_evidence(**args, symbol=symbol)
                self.assertIn("cme_equity_early_close_2025_01_09", result["reasons"])
        for symbol in ("GC", "MGC"):
            with self.subTest(symbol=symbol):
                result = assess_mffu_evidence(**args, symbol=symbol)
                self.assertNotIn("cme_equity_early_close_2025_01_09", result["reasons"])

    def test_shared_holidays_cover_positions_and_list_range(self):
        bars = [bar("2024-11-27T20:00:00Z"), bar("2024-11-28T15:00:00Z")]
        trade = {"entry_time": "2024-11-27T20:00:00Z", "exit_time": "2024-11-28T15:00:00Z", "entry_price": 5000, "side": "buy", "quantity": 1, "commission": 0, "pnl": 0}
        args = dict(bars=bars, trades=[trade], equity=[50_000, 50_000], initial_balance=50_000, rules=self.rules, interval="1min", tick_size=1, tick_value=1)
        for symbol in ("ES", "MES", "NQ", "MNQ", "GC", "MGC"):
            with self.subTest(symbol=symbol):
                self.assertIn("holiday_trading_requires_rule_review", assess_mffu_evidence(**args, symbol=symbol)["reasons"])
        args.update(bars=[bar("2026-01-05T20:00:00Z")], equity=[50_000], trades=[{**trade, "entry_time":"2026-01-05T20:00:00Z", "exit_time":"2026-01-05T20:00:00Z"}])
        self.assertIn("holiday_calendar_outside_coverage", assess_mffu_evidence(**args, symbol="ES")["reasons"])

    def test_frontend_and_backend_holiday_calendars_match(self):
        root = Path(__file__).resolve().parent.parent
        backend = json.loads((root / "backend/services/cme_shared_holidays_2019_2025.json").read_text())
        frontend = json.loads((root / "frontend/src/data/cme_shared_holidays_2019_2025.json").read_text())
        self.assertEqual(backend, frontend)

    def test_gap_and_open_position_across_cutoff_are_incomplete(self):
        bars = [bar("2026-01-05T21:07:00Z"), bar("2026-01-05T21:09:00Z"), bar("2026-01-05T23:00:00Z")]
        trade = {"entry_time": "2026-01-05T21:07:00Z", "exit_time": "2026-01-05T23:00:00Z", "entry_price": 5000, "side": "buy", "quantity": 1, "commission": 0, "pnl": 0}
        result = self.assess(bars, [trade])
        self.assertIn("missing_bars_within_session", result["reasons"])
        self.assertIn("position_over_regular_session_close", result["reasons"])

    def test_missing_data_and_unknown_interval_fail_closed(self):
        result = self.assess([{"time": "2026-01-05T20:58:00Z", "close": 1}], interval="1d")
        self.assertIn("missing_or_invalid_ohlc", result["reasons"])
        self.assertIn("unsupported_or_missing_intraday_interval", result["reasons"])

    def test_naive_utc_bar_is_not_shifted_by_machine_timezone(self):
        if not hasattr(time, "tzset"):
            self.skipTest("platform cannot set timezone")
        index = pd.to_datetime(["2026-01-05T21:09:00"])
        frame = pd.DataFrame({"open": [1.0], "high": [1.0], "low": [1.0], "close": [1.0], "volume": [1]}, index=index)
        frame.index.name = "date"
        try:
            with patch.dict(os.environ, {"TZ": "America/Los_Angeles"}), patch("services.data_loader.get_dataset", return_value={"df": frame}):
                time.tzset()
                timestamp = get_candles("ignored", interval="1min")[0]["time"]
                self.assertEqual(timestamp, int(pd.Timestamp("2026-01-05T21:09:00Z").timestamp()))
                self.assertEqual(_df_to_candles(frame)[0]["time"], timestamp)
        finally:
            time.tzset()

    def test_aware_input_is_converted_to_utc_before_timezone_is_removed(self):
        frame = pd.DataFrame({"ts_event": [pd.Timestamp("2026-01-05T16:09:00", tz="America/New_York")],
                              "open": [1_000_000_000], "high": [1_000_000_000],
                              "low": [1_000_000_000], "close": [1_000_000_000], "volume": [1]})
        result = _normalise_loaded_frame(frame)
        self.assertEqual(result.index[0], pd.Timestamp("2026-01-05T21:09:00"))


if __name__ == "__main__":
    unittest.main()
