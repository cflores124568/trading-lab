import unittest

from services import research_repo


class ResearchEvaluationRepoContractTests(unittest.TestCase):
    def test_schema_freezes_one_validation_and_one_holdout_per_trial(self):
        sql = research_repo._RESEARCH_SCHEMA_SQL
        self.assertIn("UNIQUE (trial_id)", sql)
        self.assertIn("holdout_status TEXT NOT NULL DEFAULT 'sealed'", sql)
        self.assertIn("holdout_status = 'sealed' AND holdout_result IS NULL", sql)
        self.assertIn("BEFORE UPDATE OR DELETE ON research_trial_evaluations", sql)

    def test_manual_candidate_promotion_is_unique_per_finalist(self):
        sql = research_repo._RESEARCH_SCHEMA_SQL
        self.assertIn("CREATE TABLE IF NOT EXISTS research_candidate_promotions", sql)
        self.assertIn("UNIQUE (campaign_id, trial_id)", sql)
        self.assertIn("validation_score >= 0 AND validation_score <= 100", sql)


if __name__ == "__main__":
    unittest.main()
