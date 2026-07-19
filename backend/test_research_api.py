import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from fastapi.testclient import TestClient

from main import app


def _campaign():
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return {
        "campaign_id": "campaign-1",
        "name": "Phase 4A API fixture",
        "symbol": "NQ",
        "interval": "15min",
        "start_time": start,
        "end_time": start + timedelta(minutes=135),
        "development_pct": 60,
        "validation_pct": 20,
        "holdout_pct": 20,
        "status": "draft",
        "total_bar_count": 10,
        "created_by": "api-test",
        "created_at": start,
        "updated_at": start,
        "partitions": [
            {"partition_name": "development", "start_time": start, "end_time": start + timedelta(minutes=75), "bar_count": 6},
            {"partition_name": "validation", "start_time": start + timedelta(minutes=90), "end_time": start + timedelta(minutes=105), "bar_count": 2},
            {"partition_name": "holdout", "start_time": start + timedelta(minutes=120), "end_time": start + timedelta(minutes=135), "bar_count": 2},
        ],
        "audit_events": [],
    }


class ResearchApiTests(unittest.TestCase):
    def test_create_get_and_bounded_list_contracts(self):
        payload = {
            "name": "Phase 4A API fixture",
            "symbol": "NQ",
            "interval": "15min",
            "start_time": "2026-01-01T00:00:00Z",
            "end_time": "2026-01-01T02:15:00Z",
            "created_by": "api-test",
        }
        with TestClient(app) as client, patch(
            "routers.research_campaigns.research_service.create_campaign",
            return_value=_campaign(),
        ), patch(
            "routers.research_campaigns.research_service.get_campaign",
            return_value=_campaign(),
        ):
            created = client.post("/api/research-campaigns/", json=payload)
            fetched = client.get("/api/research-campaigns/campaign-1")
            over_limit = client.get("/api/research-campaigns/?limit=101")

        self.assertEqual(created.status_code, 201)
        self.assertEqual(fetched.status_code, 200)
        self.assertEqual(fetched.json()["partitions"][2]["partition_name"], "holdout")
        self.assertEqual(over_limit.status_code, 422)

    def test_invalid_percentages_fail_before_storage(self):
        payload = {
            "name": "bad split",
            "symbol": "NQ",
            "interval": "15min",
            "start_time": "2026-01-01T00:00:00Z",
            "end_time": "2026-01-02T00:00:00Z",
            "development_pct": 60,
            "validation_pct": 30,
            "holdout_pct": 20,
        }
        with TestClient(app) as client:
            response = client.post("/api/research-campaigns/", json=payload)
        self.assertEqual(response.status_code, 422)

    def test_failed_trial_is_returned_by_get_contract(self):
        now = datetime.now(timezone.utc)
        failed = {
            "trial_id": "trial-failed",
            "campaign_id": "campaign-1",
            "fingerprint": "a" * 64,
            "strategy_type": "ema_crossover",
            "strategy_params": {"fast": 9, "slow": 21},
            "execution_config": {},
            "random_seed": 0,
            "status": "failed",
            "result": None,
            "error": "kept for diagnosis",
            "created_by": "api-test",
            "created_at": now,
            "completed_at": now,
            "was_duplicate": False,
        }
        with TestClient(app) as client, patch(
            "routers.research_campaigns.research_service.get_trial",
            return_value=failed,
        ):
            response = client.get("/api/research-campaigns/campaign-1/trials/trial-failed")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "failed")
        self.assertEqual(response.json()["error"], "kept for diagnosis")

    def test_phase_4b_routes_are_exposed_and_cost_evidence_fails_closed(self):
        with TestClient(app) as client:
            paths = client.get("/openapi.json").json()["paths"]
            invalid = client.post(
                "/api/research-campaigns/campaign-1/trials/trial-1/holdout",
                json={
                    "cost_stresses": [
                        {
                            "cost_multiplier": 1.0,
                            "metrics": {
                                "total_pnl": 10,
                                "max_drawdown": 0.01,
                                "total_trades": 5,
                                "profit_factor": 1.2,
                            },
                        }
                    ]
                },
            )
        self.assertIn("/api/research-campaigns/{campaign_id}/trials/{trial_id}/validation", paths)
        self.assertIn("/api/research-campaigns/{campaign_id}/trials/{trial_id}/freeze-finalist", paths)
        self.assertIn("/api/research-campaigns/{campaign_id}/trials/{trial_id}/holdout", paths)
        self.assertIn("/api/research-campaigns/{campaign_id}/trials/{trial_id}/promote", paths)
        self.assertIn("/api/research-campaigns/{campaign_id}/candidate-promotions", paths)
        self.assertEqual(invalid.status_code, 422)

    def test_manual_promotion_route_fails_closed_when_gates_are_not_met(self):
        with TestClient(app) as client, patch(
            "routers.research_campaigns.research_evaluation_service.promote_candidate",
            side_effect=ValueError("Research candidate promotion requires every validation gate to pass."),
        ):
            response = client.post(
                "/api/research-campaigns/campaign-1/trials/trial-1/promote",
                json={"promotion_reason": "Reviewed by operator.", "actor": "api-test"},
            )
        self.assertEqual(response.status_code, 400)
        self.assertIn("every validation gate", response.json()["detail"])

    def test_candidate_promotion_list_is_bounded(self):
        with TestClient(app) as client:
            response = client.get(
                "/api/research-campaigns/campaign-1/candidate-promotions?limit=101"
            )
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
