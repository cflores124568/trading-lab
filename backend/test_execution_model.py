import unittest

from services.execution_model import (
    make_resting_order,
    resting_order_touched,
    synthetic_quote_for_bar,
)


class ExecutionModelTests(unittest.TestCase):
    def test_synthetic_quote_uses_close_reference_and_tick_spread(self):
        quote = synthetic_quote_for_bar(
            {"close": 100.12, "high": 101, "low": 99},
            tick_size=0.25,
            spread_ticks=1,
        )

        self.assertEqual(quote.reference, 100.0)
        self.assertEqual(quote.bid, 100.0)
        self.assertEqual(quote.ask, 100.25)

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


if __name__ == "__main__":
    unittest.main()
