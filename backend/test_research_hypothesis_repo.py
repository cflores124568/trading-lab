import unittest
from unittest.mock import MagicMock

from services import research_hypothesis_repo


class ResearchHypothesisRepoContractTests(unittest.TestCase):
    def test_attempts_and_execution_links_are_immutable(self):
        sql = research_hypothesis_repo._SCHEMA_SQL
        self.assertIn("BEFORE UPDATE OR DELETE ON research_hypothesis_attempts", sql)
        self.assertIn("BEFORE UPDATE OR DELETE ON research_hypothesis_trial_links", sql)
        self.assertIn("research hypothesis attempts are immutable", sql)

    def test_only_accepted_attempts_can_contain_compiled_trials(self):
        sql = research_hypothesis_repo._SCHEMA_SQL
        self.assertIn("status = 'accepted' AND compiled_trial IS NOT NULL", sql)
        self.assertIn("status <> 'accepted' AND compiled_trial IS NULL", sql)
        self.assertIn("hypothesis_attempt_id TEXT PRIMARY KEY", sql)

    def test_budget_columns_are_additive(self):
        sql = research_hypothesis_repo._SCHEMA_SQL
        self.assertIn("ADD COLUMN IF NOT EXISTS hypothesis_budget", sql)
        self.assertIn("ADD COLUMN IF NOT EXISTS hypothesis_trial_budget", sql)

    def test_campaign_lock_recheck_rejects_a_concurrent_exact_duplicate(self):
        cursor = MagicMock()
        cursor.fetchall.return_value = [{
            "hypothesis_attempt_id": "attempt-original",
            "fingerprint": "same",
            "compiled_trial": {
                "strategy_type": "ema_crossover",
                "strategy_params": {"fast_period": 9, "slow_period": 21},
            },
        }]
        attempt = {
            "campaign_id": "campaign-1",
            "fingerprint": "same",
            "status": "accepted",
            "compiled_trial": {
                "strategy_type": "ema_crossover",
                "strategy_params": {"fast_period": 9, "slow_period": 21},
            },
            "rejection_reasons": [],
        }

        research_hypothesis_repo._enforce_concurrent_decision(cursor, attempt)

        self.assertEqual(attempt["status"], "duplicate")
        self.assertEqual(attempt["duplicate_of_attempt_id"], "attempt-original")
        self.assertIsNone(attempt["compiled_trial"])


if __name__ == "__main__":
    unittest.main()
