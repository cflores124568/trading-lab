#!/usr/bin/env python3

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from routers.prop_firms import PRESETS


class PropFirmPresetTests(unittest.TestCase):
    def test_topstep_eval_rules_do_not_reuse_funded_targets(self):
        rules = PRESETS["topstep_50k"]

        self.assertEqual(rules["profit_target"], 0.06)
        self.assertEqual(rules["consistency_threshold"], 0.50)
        self.assertIsNone(rules["min_trading_days"])
        self.assertEqual(rules["rules_scope"], "evaluation")

    def test_mff_pro_keeps_old_generic_name_as_match_alias(self):
        rules = PRESETS["mff_50k"]

        self.assertEqual(rules["name"], "My Funded Futures Pro 50,000")
        self.assertIn("My Funded Futures 50,000", rules["match_names"])
        self.assertEqual(rules["profit_target"], 0.06)
        self.assertEqual(rules["min_trading_days"], 2)

    def test_mff_rapid_includes_current_25k_plan(self):
        rules = PRESETS["mff_rapid_25k"]

        self.assertEqual(rules["account_size"], 25_000)
        self.assertEqual(rules["profit_target"], 0.06)
        self.assertEqual(rules["max_drawdown"], 0.04)
        self.assertEqual(rules["min_trading_days"], 2)

    def test_mff_flex_only_keeps_current_sizes(self):
        self.assertIn("mff_flex_25k", PRESETS)
        self.assertIn("mff_flex_50k", PRESETS)
        self.assertNotIn("mff_flex_100k", PRESETS)
        self.assertNotIn("mff_flex_150k", PRESETS)

    def test_lucid_pro_eval_rules_no_longer_reuse_funded_payout_gates(self):
        rules = PRESETS["lucid_pro_50k"]

        self.assertFalse(rules["consistency_rule"])
        self.assertIsNone(rules["min_trading_days"])
        self.assertEqual(rules["profit_target"], 0.06)
        self.assertAlmostEqual(rules["daily_loss_limit"], 0.024)


if __name__ == "__main__":
    unittest.main()
