import unittest

from services.execution_model import (
    default_execution_config_for_symbol,
    make_resting_order,
    normalize_backtest_execution_mode,
    replace_resting_order,
    resting_order_fill_update,
    resting_order_penetrated,
    resting_order_touched,
    synthetic_quote_for_bar,
)


class ExecutionModelTests(unittest.TestCase):
    def test_backtest_execution_mode_falls_back_to_bar(self):
        self.assertEqual(normalize_backtest_execution_mode("synthetic_quotes"), "synthetic_quotes")
        self.assertEqual(normalize_backtest_execution_mode("BAR"), "bar")
        self.assertEqual(normalize_backtest_execution_mode("nonsense"), "bar")

    def test_synthetic_quote_uses_close_reference_and_tick_spread(self):
        quote = synthetic_quote_for_bar(
            {"close": 100.12, "high": 101, "low": 99},
            tick_size=0.25,
            spread_ticks=1,
        )

        self.assertEqual(quote.reference, 100.0)
        self.assertEqual(quote.bid, 100.0)
        self.assertEqual(quote.ask, 100.25)
        self.assertEqual(quote.base_spread_ticks, 1)
        self.assertEqual(quote.volatility_spread_ticks, 0)
        self.assertFalse(quote.is_volatile)

    def test_synthetic_quote_can_widen_during_volatile_bars(self):
        quote = synthetic_quote_for_bar(
            {"close": 100.75, "high": 102.25, "low": 99.75},
            tick_size=0.25,
            spread_ticks=1,
            volatile_bar_threshold_ticks=8,
            volatile_bar_extra_ticks=2,
        )

        self.assertEqual(quote.reference, 100.75)
        self.assertEqual(quote.bar_range_ticks, 10)
        self.assertTrue(quote.is_volatile)
        self.assertEqual(quote.base_spread_ticks, 1)
        self.assertEqual(quote.volatility_spread_ticks, 2)
        self.assertEqual(quote.spread_ticks, 3)
        self.assertEqual(quote.bid, 100.5)
        self.assertEqual(quote.ask, 101.25)

    def test_symbol_execution_defaults_use_root_symbols(self):
        es = default_execution_config_for_symbol("ES_c_0")
        unknown = default_execution_config_for_symbol("custom-market")

        self.assertEqual(es["spread_ticks"], 1)
        self.assertEqual(es["volatile_bar_threshold_ticks"], 8)
        self.assertEqual(es["volatile_bar_extra_ticks"], 1)
        self.assertEqual(unknown["spread_ticks"], 1)
        self.assertEqual(unknown["volatile_bar_threshold_ticks"], 0)
        self.assertEqual(unknown["volatile_bar_extra_ticks"], 0)

    def test_resting_order_touch_rules_follow_side(self):
        buy = make_resting_order(
            order_id="buy-1",
            action="join_bid",
            price=100.0,
            submitted_at="2026-05-01T09:30:00+00:00",
        )
        sell = make_resting_order(
            order_id="sell-1",
            action="join_ask",
            price=101.0,
            submitted_at="2026-05-01T09:30:00+00:00",
        )
        bar = {"open": 100.5, "high": 101.25, "low": 99.75, "close": 100.75}

        self.assertTrue(resting_order_touched(buy, bar))
        self.assertTrue(resting_order_touched(sell, bar))

        buy["status"] = "canceled"
        self.assertFalse(resting_order_touched(buy, bar))

    def test_penetrate_mode_requires_trading_through_order_price(self):
        buy = make_resting_order(
            order_id="buy-1",
            action="join_bid",
            price=100.0,
            submitted_at="2026-05-01T09:30:00+00:00",
        )

        self.assertFalse(resting_order_penetrated(buy, {"low": 100.0, "high": 101.0, "close": 100.5}))
        self.assertTrue(resting_order_penetrated(buy, {"low": 99.75, "high": 101.0, "close": 100.5}))

    def test_touch_plus_one_bar_arms_then_fills_on_later_touch(self):
        order = make_resting_order(
            order_id="buy-1",
            action="join_bid",
            price=100.0,
            submitted_at="2026-05-01T09:30:00+00:00",
        )

        should_fill, armed = resting_order_fill_update(
            order,
            {"low": 100.0, "high": 101.0, "close": 100.5},
            fill_mode="touch_plus_1_bar",
            bar_index=3,
            timestamp="2026-05-01T09:33:00+00:00",
        )
        self.assertFalse(should_fill)
        self.assertEqual(armed.get("first_touch_bar_index"), 3)
        self.assertEqual(armed.get("first_touch_at"), "2026-05-01T09:33:00+00:00")

        should_fill, still_armed = resting_order_fill_update(
            armed,
            {"low": 100.25, "high": 101.0, "close": 100.75},
            fill_mode="touch_plus_1_bar",
            bar_index=4,
            timestamp="2026-05-01T09:34:00+00:00",
        )
        self.assertFalse(should_fill)
        self.assertEqual(still_armed.get("first_touch_bar_index"), 3)

        should_fill, ready = resting_order_fill_update(
            still_armed,
            {"low": 99.75, "high": 100.75, "close": 100.25},
            fill_mode="touch_plus_1_bar",
            bar_index=5,
            timestamp="2026-05-01T09:35:00+00:00",
        )
        self.assertTrue(should_fill)
        self.assertEqual(ready.get("first_touch_bar_index"), 3)

    def test_replace_resting_order_keeps_lineage_and_resets_arming(self):
        order = make_resting_order(
            order_id="buy-1",
            action="join_bid",
            price=100.0,
            submitted_at="2026-05-01T09:30:00+00:00",
            submitted_bar_index=1,
        )
        order["first_touch_at"] = "2026-05-01T09:31:00+00:00"
        order["first_touch_bar_index"] = 2

        replaced, child = replace_resting_order(
            order,
            new_order_id="buy-2",
            price=99.75,
            submitted_at="2026-05-01T09:32:00+00:00",
            submitted_bar_index=3,
        )

        self.assertEqual(replaced["status"], "replaced")
        self.assertEqual(replaced["replaced_by_order_id"], "buy-2")
        self.assertEqual(replaced["parent_order_id"], "buy-1")
        self.assertEqual(replaced["replace_count"], 1)
        self.assertEqual(child["status"], "pending")
        self.assertEqual(child["id"], "buy-2")
        self.assertEqual(child["replaces_order_id"], "buy-1")
        self.assertEqual(child["parent_order_id"], "buy-1")
        self.assertEqual(child["replace_count"], 1)
        self.assertNotIn("first_touch_at", child)
        self.assertNotIn("first_touch_bar_index", child)


if __name__ == "__main__":
    unittest.main()
