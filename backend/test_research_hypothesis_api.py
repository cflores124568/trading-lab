import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from fastapi.testclient import TestClient

from main import app


def _attempt(status="accepted"):
    return {
        "hypothesis_attempt_id": "attempt-1",
        "campaign_id": "campaign-1",
        "fingerprint": "a" * 64,
        "near_duplicate_key": None,
        "status": status,
        "proposal": {
            "name": "Bounded EMA idea",
            "rationale": "Test bounded continuation behavior.",
            "expected_market_behavior": "Signals cluster during directional regimes.",
            "strategy_primitive": "ema_crossover",
            "strategy_params": {"fast_period": 9, "slow_period": 21},
            "proposed_by": "fixture-agent",
        },
        "compiled_trial": {
            "strategy_type": "ema_crossover",
            "strategy_params": {
                "fast_period": 9, "slow_period": 21, "trend_ema_period": 0,
                "min_atr_percent": 0, "vwap_bias": 0, "cooldown_bars": 0, "atr_period": 14,
            },
            "execution_config": {},
            "random_seed": 7,
        } if status == "accepted" else None,
        "rejection_reasons": [] if status == "accepted" else ["rejected fixture"],
        "duplicate_of_attempt_id": None,
        "trial_id": None,
        "created_at": datetime.now(timezone.utc),
    }


class ResearchHypothesisApiTests(unittest.TestCase):
    def test_phase_4e_routes_are_exposed_and_lists_are_bounded(self):
        with TestClient(app) as client:
            paths = client.get("/openapi.json").json()["paths"]
            over_limit = client.get("/api/research-campaigns/campaign-1/hypotheses?limit=101")

        self.assertIn("/api/research-campaigns/{campaign_id}/hypothesis-budget", paths)
        self.assertIn("/api/research-campaigns/{campaign_id}/hypotheses", paths)
        self.assertIn("/api/research-campaigns/{campaign_id}/hypotheses/{attempt_id}/execute", paths)
        self.assertEqual(over_limit.status_code, 422)

    def test_typed_proposal_returns_durable_attempt_contract(self):
        payload = _attempt()["proposal"]
        with TestClient(app) as client, patch(
            "routers.research_campaigns.research_hypothesis_service.submit_hypothesis",
            return_value=_attempt(),
        ):
            response = client.post("/api/research-campaigns/campaign-1/hypotheses", json=payload)

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["status"], "accepted")
        self.assertEqual(response.json()["compiled_trial"]["strategy_type"], "ema_crossover")

    def test_rejected_attempt_remains_visible(self):
        rejected = _attempt("rejected")
        with TestClient(app) as client, patch(
            "routers.research_campaigns.research_hypothesis_service.list_hypotheses",
            return_value=[rejected],
        ):
            response = client.get("/api/research-campaigns/campaign-1/hypotheses?status=rejected")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()[0]["status"], "rejected")
        self.assertTrue(response.json()[0]["rejection_reasons"])

    def test_unaccepted_hypothesis_execution_fails_closed(self):
        with TestClient(app) as client, patch(
            "routers.research_campaigns.research_hypothesis_service.execute_hypothesis",
            side_effect=ValueError("Only statically accepted hypotheses can be executed."),
        ):
            response = client.post(
                "/api/research-campaigns/campaign-1/hypotheses/attempt-1/execute",
                json={"actor": "reviewer"},
            )

        self.assertEqual(response.status_code, 400)
        self.assertIn("statically accepted", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
