import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from schemas import ResearchCampaignCreate, ResearchTrialCreate
from services import research_service


class ResearchServiceTests(unittest.TestCase):
    def test_campaign_creation_persists_exact_partition_boundaries(self):
        start = datetime(2026, 1, 1, tzinfo=timezone.utc)
        timestamps = [start + timedelta(minutes=15 * index) for index in range(10)]
        request = ResearchCampaignCreate(
            name="Phase 4A fixture",
            symbol="nq",
            interval="15m",
            start_time=timestamps[0],
            end_time=timestamps[-1],
        )

        with patch.object(research_service.research_repo, "list_research_bar_timestamps", return_value=timestamps), patch.object(
            research_service.research_repo,
            "create_research_campaign",
            side_effect=lambda campaign, partitions, event: {
                **campaign,
                "partitions": partitions,
                "audit_events": [event],
            },
        ):
            campaign = research_service.create_campaign(request)

        self.assertEqual(campaign["symbol"], "NQ")
        self.assertEqual(campaign["interval"], "15min")
        self.assertEqual(campaign["partitions"][0]["start_time"], timestamps[0])
        self.assertEqual(campaign["partitions"][0]["end_time"], timestamps[5])
        self.assertEqual(campaign["partitions"][1]["start_time"], timestamps[6])
        self.assertEqual(campaign["partitions"][2]["end_time"], timestamps[9])

    def test_trial_fingerprint_is_canonical(self):
        first = research_service.trial_fingerprint(
            campaign_id="campaign-1",
            strategy_type="ema_crossover",
            strategy_params={"slow": 21, "fast": 9},
            execution_config={"spread_ticks": 1, "mode": "bar"},
            random_seed=7,
        )
        second = research_service.trial_fingerprint(
            campaign_id="campaign-1",
            strategy_type="ema_crossover",
            strategy_params={"fast": 9, "slow": 21},
            execution_config={"mode": "bar", "spread_ticks": 1},
            random_seed=7,
        )
        self.assertEqual(first, second)

    def test_duplicate_trial_returns_original_failed_attempt(self):
        request = ResearchTrialCreate(
            strategy_type="ema_crossover",
            strategy_params={"fast": 9, "slow": 21},
            status="failed",
            error="fixture failure",
        )
        original = {
            "trial_id": "trial-original",
            "campaign_id": "campaign-1",
            "fingerprint": "same",
            "strategy_type": "ema_crossover",
            "strategy_params": {"fast": 9, "slow": 21},
            "execution_config": {},
            "random_seed": 0,
            "status": "failed",
            "result": None,
            "error": "fixture failure",
            "created_by": "local-user",
            "created_at": datetime.now(timezone.utc),
            "completed_at": datetime.now(timezone.utc),
            "was_duplicate": True,
        }
        with patch.object(research_service.research_repo, "get_research_campaign", return_value={"campaign_id": "campaign-1"}), patch.object(
            research_service.research_repo,
            "create_research_trial",
            return_value=(original, False),
        ):
            result = research_service.register_trial("campaign-1", request)

        self.assertEqual(result["trial_id"], "trial-original")
        self.assertTrue(result["was_duplicate"])
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"], "fixture failure")


if __name__ == "__main__":
    unittest.main()
