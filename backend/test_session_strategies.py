"""Session strategy behavior and shared single/batch execution contracts."""

import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd
from pydantic import ValidationError

from schemas import BacktestRequest, ExperimentCreate, Strategy
from services import experiment_service
from services.backtest_service import build_backtest_result
from services.indicators import add_all_indicators
from services.strategy import generate_signals


def frame(closes, start="2024-01-02 09:30", interval="1min"):
    closes = np.asarray(closes, dtype=float)
    index = pd.date_range(start, periods=len(closes), freq=interval, tz="America/New_York").tz_convert("UTC")
    df = pd.DataFrame({"open": closes, "high": closes + 1, "low": closes - 1,
                       "close": closes, "volume": np.ones(len(closes)) * 100}, index=index)
    df.attrs["bar_interval"] = interval
    return df


def signals(df, strategy="orb", **params):
    enriched = add_all_indicators(df.copy(), params, strategy_type=strategy)
    return generate_signals(enriched, strategy, params)


class SessionStrategyTests(unittest.TestCase):
    def test_orb_waits_for_completed_range_and_only_signals_crossings(self):
        df = frame([100] * 15 + [102, 103, 100, 98, 97, 100, 102])
        result = signals(df)
        self.assertEqual(result.signal.tolist(), [0] * 15 + [1, 0, 0, -1, 0, 0, 1])
        self.assertTrue(result.orb_high.iloc[:15].isna().all())
        self.assertEqual(result.orb_high.iloc[15], 101)
        self.assertEqual(result.orb_low.iloc[15], 99)

    def test_orb_buffer_requires_a_close_beyond_buffered_boundary(self):
        result = signals(frame([100] * 15 + [101.5, 102.5]), breakout_buffer_percent=1)
        self.assertEqual(result.signal.iloc[-2:].tolist(), [0, 1])

    def test_opening_range_resets_each_day(self):
        first = frame([100] * 15 + [102, 100])
        second = frame([200] * 15 + [198, 200], start="2024-01-03 09:30")
        result = signals(pd.concat([first, second]))
        self.assertEqual(result.signal.iloc[15], 1)
        self.assertEqual(result.signal.iloc[len(first) + 15], -1)
        self.assertEqual(result.orb_high.iloc[-1], 201)

    def test_missing_opening_bar_or_mid_session_slice_skips_that_day(self):
        df = frame([100] * 15 + [102, 98])
        for partial in (df.iloc[1:], df.drop(df.index[5])):
            with self.subTest(index=partial.index[0]):
                self.assertFalse(signals(partial).signal.any())

    def test_timezone_conversion_handles_winter_and_summer(self):
        for start, utc_hour in (("2024-01-02 09:30", 14), ("2024-07-02 09:30", 13)):
            df = frame([100] * 15 + [102], start=start)
            self.assertEqual(df.index[0].hour, utc_hour)
            self.assertEqual(signals(df).signal.iloc[-1], 1)
            naive = df.copy()
            naive.index = naive.index.tz_localize(None)
            self.assertEqual(signals(naive).signal.tolist(), signals(df).signal.tolist())

    def test_five_and_fifteen_minute_opening_ranges(self):
        for interval, count in (("5min", 3), ("15min", 1)):
            with self.subTest(interval=interval):
                result = signals(frame([100] * count + [102], interval=interval))
                self.assertEqual(result.signal.tolist(), [0] * count + [1])

    def test_incompatible_intervals_fail_instead_of_using_future_highs(self):
        for interval in ("10min", "30min", "1h", "1d"):
            with self.subTest(interval=interval), self.assertRaises(ValueError):
                signals(frame([100, 102, 98], interval=interval))

    def test_last_session_bar_and_overnight_cannot_send_entries(self):
        result = signals(frame([100, 100, 102, 100, 103, 97, 102]),
                         opening_range_minutes=2, session_end=935)
        self.assertEqual(result.signal.tolist(), [0, 0, 1, 0, 0, 0, 0])

    def test_custom_opening_time(self):
        result = signals(frame([100] * 15 + [102], start="2024-01-02 08:00"),
                         session_start=800, session_end=1200)
        self.assertEqual(result.signal.iloc[-1], 1)

    def test_vwap_fades_both_bands_without_repeating_stretched_entries(self):
        result = signals(frame([100, 95, 94, 97, 105, 106]), "vwap_mean_reversion",
                         warmup_minutes=0, entry_deviation_percent=1)
        self.assertEqual(result.signal.tolist(), [0, 1, 0, 0, -1, 0])

    def test_vwap_is_volume_weighted_and_ignores_overnight(self):
        df = frame([100, 90, 80], start="2024-01-02 09:29")
        df["volume"] = [10000, 100, 300]
        result = signals(df, "vwap_mean_reversion", warmup_minutes=0)
        self.assertTrue(pd.isna(result.vwap.iloc[0]))
        self.assertEqual(result.vwap.iloc[1], 90)
        self.assertEqual(result.vwap.iloc[2], 82.5)

    def test_vwap_resets_each_session_and_skips_partial_openings(self):
        df = pd.concat([frame([100, 95, 94]).iloc[1:],
                        frame([200, 200, 195], start="2024-01-03 09:30")])
        result = signals(df, "vwap_mean_reversion", warmup_minutes=0, entry_deviation_percent=1)
        self.assertTrue(result.vwap.iloc[:2].isna().all())
        self.assertFalse(result.signal.iloc[:2].any())
        self.assertEqual(result.vwap.iloc[2], 200)
        self.assertEqual(result.signal.iloc[-1], 1)

    def test_vwap_warmup_delays_fade(self):
        result = signals(frame([100, 95, 94, 93, 92]), "vwap_mean_reversion",
                         warmup_minutes=3, entry_deviation_percent=1)
        self.assertEqual(result.signal.tolist(), [0, 0, 1, 0, 0])

    def test_zero_volume_does_not_emit_an_invalid_signal(self):
        df = frame([100, 90, 80])
        df["volume"] = 0
        result = signals(df, "vwap_mean_reversion", warmup_minutes=0)
        self.assertTrue(result.vwap.isna().all())
        self.assertFalse(result.signal.any())

    def test_future_bars_cannot_change_prior_signals_or_vwap(self):
        df = frame([100] * 15 + [102, 98, 104, 96, 100])
        for strategy in ("orb", "vwap_mean_reversion"):
            full = signals(df, strategy)
            for size in (5, 15, 16, 18):
                with self.subTest(strategy=strategy, size=size):
                    prefix = signals(df.iloc[:size], strategy)
                    pd.testing.assert_series_equal(prefix.signal, full.signal.iloc[:size])
                    pd.testing.assert_series_equal(prefix.vwap, full.vwap.iloc[:size])

    def test_shared_filters_still_apply(self):
        df = frame([100] * 15 + [102, 100, 98])
        unfiltered = signals(df)
        self.assertEqual(unfiltered.signal.iloc[15], 1)
        self.assertFalse(signals(df, min_atr_percent=100).signal.any())

    def test_invalid_settings_are_rejected_at_strategy_api_boundary(self):
        invalid = [
            ("orb", {"opening_range_minutes": 0}),
            ("orb", {"opening_range_minutes": 1.5}),
            ("orb", {"opening_range_minutes": 390}),
            ("orb", {"breakout_buffer_percent": float("inf")}),
            ("orb", {"session_start": 960}),
            ("orb", {"session_start": 1600, "session_end": 930}),
            ("orb", {"cooldown_bars": -1}),
            ("vwap_mean_reversion", {"entry_deviation_percent": 0}),
            ("vwap_mean_reversion", {"warmup_minutes": 400}),
            ("vwap_mean_reversion", {"vwap_bias": 1}),
        ]
        for strategy, params in invalid:
            with self.subTest(strategy=strategy, params=params), self.assertRaises(ValidationError):
                Strategy(type=strategy, params=params)

    def test_new_types_are_accepted_for_experiment_requests(self):
        for strategy in ("orb", "vwap_mean_reversion"):
            request = ExperimentCreate(name="session sweep", symbols=["ES"], intervals=["1min"],
                                       strategy_type=strategy, prop_firm_rules={"name": "Test Firm"})
            self.assertEqual(request.strategy_type.value, strategy)

    def test_robustness_neighbors_cannot_enable_conflicting_vwap_bias(self):
        from services.robustness_service import _generate_parameter_candidates

        candidates = _generate_parameter_candidates("vwap_mean_reversion",
                                                     {"entry_deviation_percent": 0.1, "vwap_bias": 0}, 20)
        self.assertTrue(candidates)
        self.assertTrue(all(candidate["vwap_bias"] == 0 for candidate in candidates))

    def test_single_and_batched_experiments_agree_for_both_strategies(self):
        df = frame([100] * 15 + [102, 100, 98, 100, 104, 100, 96, 100])
        dataset = {"df": df, "info": {"symbol": "MES", "interval": "1min"}}
        dataset_info = {"dataset_id": "session-test", "tick_size": 0.25, "tick_value": 1.25}
        for strategy, grid in (("orb", {"breakout_buffer_percent": [0, 0.5]}),
                               ("vwap_mean_reversion", {"entry_deviation_percent": [0.1, 1]})):
            experiment = {"experiment_id": f"session-{strategy}", "name": "session parity", "symbols": ["MES"],
                          "intervals": ["1min"], "strategy_type": strategy, "parameter_space": grid,
                          "prop_firm_rules": {"name": "Test Firm"}, "initial_balance": 100000,
                          "position_size": 1, "commission": 2.5, "slippage_ticks": 1,
                          "execution_mode": "bar", "scoring_rule": "total_pnl"}
            with self.subTest(strategy=strategy), patch.object(experiment_service, "load_from_db", return_value=dataset_info), \
                    patch.object(experiment_service, "get_dataset", return_value=dataset), \
                    patch("services.db.db_configured", return_value=False):
                updated, runs = experiment_service.run_experiment(experiment)
                self.assertEqual(updated["completed_runs"], 2)
                for run in runs:
                    request = BacktestRequest(dataset_id="session-test", strategy={"type": strategy, "params": run["strategy_params"]},
                                              prop_firm_rules=experiment["prop_firm_rules"], commission=2.5,
                                              tick_size=0.25, tick_value=1.25)
                    reference = build_backtest_result(dataset, request)
                    self.assertEqual(run["metrics"], reference["metrics"])
                    self.assertGreater(run["metrics"]["total_trades"], 0)


if __name__ == "__main__":
    unittest.main()
