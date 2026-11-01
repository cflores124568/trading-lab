#!/usr/bin/env python3

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.prop_firms import PRESETS, router
from services.mffu_catalog import MFFU_EVALUATION_CATALOG
from services.mffu_contracts import contract_limit, effective_max_contracts
from schemas import PropFirmRules
from types import SimpleNamespace


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

    def test_mff_rapid_eod_evaluation_variants(self):
        for size in (25, 50):
            rules = PRESETS[f"mff_rapid_eod_{size}k"]
            self.assertEqual(rules["account_size"], size * 1000)
            self.assertEqual(rules["max_drawdown"], 0.04)
            self.assertEqual(rules["profit_target"], 0.06)
            self.assertEqual(rules["consistency_threshold"], 0.30)
            self.assertEqual(rules["min_trading_days"], 4)
            self.assertIsNone(rules["daily_loss_limit"])

    def test_mff_pro_one_day_addon_evaluation(self):
        rules = PRESETS["mff_pro_one_day_50k"]
        self.assertEqual(rules["profit_target"], 0.08)
        self.assertEqual(rules["max_drawdown"], 0.04)
        self.assertFalse(rules["consistency_rule"])
        self.assertIsNone(rules["consistency_threshold"])
        self.assertEqual(rules["min_trading_days"], 1)

    def test_mffu_catalog_matches_executable_presets(self):
        self.assertEqual(len(MFFU_EVALUATION_CATALOG), 20)
        self.assertEqual(len({plan["key"] for plan in MFFU_EVALUATION_CATALOG}), 20)
        for plan in MFFU_EVALUATION_CATALOG:
            with self.subTest(plan=plan["name"]):
                preset = PRESETS[plan["preset_key"]]
                self.assertEqual(plan["simulation_status"], "approximate")
                self.assertEqual(preset["account_size"], plan["account_size"])
                self.assertAlmostEqual(preset["profit_target"] * plan["account_size"], plan["profit_target"])
                self.assertAlmostEqual(preset["max_drawdown"] * plan["account_size"], plan["max_loss"])
                self.assertEqual(preset["consistency_threshold"], plan["consistency_threshold"])
                self.assertEqual(preset["min_trading_days"], plan["min_trading_days"])
                if plan["daily_soft_pause"] is not None:
                    self.assertEqual(preset["daily_loss_mode"], "soft_pause")
                    self.assertAlmostEqual(preset["daily_loss_limit"] * plan["account_size"], plan["daily_soft_pause"])

    def test_catalog_route_is_not_captured_by_preset_lookup(self):
        app = FastAPI()
        app.include_router(router, prefix="/api/prop-firms")
        response = TestClient(app).get("/api/prop-firms/mffu-catalog")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["stage"], "evaluation")
        self.assertEqual(len(response.json()["plans"]), 20)
        addon = TestClient(app).get("/api/prop-firms/mff_builder_50k_addon")
        self.assertEqual(addon.status_code, 200)
        self.assertAlmostEqual(addon.json()["max_drawdown"], 0.03)
        self.assertEqual(addon.json()["daily_loss_mode"], "soft_pause")

    def test_studio_allows_micros_only_and_enforces_quantity(self):
        rules = PropFirmRules(**PRESETS["mff_studio_003"])
        self.assertEqual(contract_limit("MES.c.0", rules), 5)
        with self.assertRaises(ValueError):
            contract_limit("ES.c.0", rules)
        with self.assertRaises(ValueError):
            contract_limit("unknown", rules)
        with self.assertRaises(ValueError):
            effective_max_contracts("MNQ.c.0", SimpleNamespace(prop_firm_rules=rules, sizing_mode="fixed", position_size=6, max_position_size=None))
        self.assertEqual(effective_max_contracts("MNQ.c.0", SimpleNamespace(prop_firm_rules=rules, sizing_mode="risk_percent", position_size=1, max_position_size=9)), 5)

    def test_lucid_pro_eval_rules_no_longer_reuse_funded_payout_gates(self):
        rules = PRESETS["lucid_pro_50k"]

        self.assertFalse(rules["consistency_rule"])
        self.assertIsNone(rules["min_trading_days"])
        self.assertEqual(rules["profit_target"], 0.06)
        self.assertAlmostEqual(rules["daily_loss_limit"], 0.024)


if __name__ == "__main__":
    unittest.main()
