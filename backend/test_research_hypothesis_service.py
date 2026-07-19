import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from schemas import ResearchHypothesisExecuteRequest, ResearchHypothesisProposal
from services import research_hypothesis_service as service


def _campaign(status="draft"):
    return {
        "campaign_id": "campaign-1",
        "status": status,
        "search_config": {"execution_config": {"commission": 5, "slippage_ticks": 1}},
        "partitions": [],
    }


def _proposal(**overrides):
    values = {
        "name": "Fast/slow continuation",
        "rationale": "A shorter EMA may react before the regime filter reverses.",
        "expected_market_behavior": "Signals should cluster in persistent directional movement.",
        "strategy_primitive": "ema_crossover",
        "strategy_params": {"fast_period": 9, "slow_period": 21},
        "proposed_by": "fixture-agent",
    }
    values.update(overrides)
    return ResearchHypothesisProposal(**values)


def _store(attempt, event):
    return {**attempt, "trial_id": None}


class ResearchHypothesisServiceTests(unittest.TestCase):
    def _submit(self, proposal, *, budget=None, comparable=None):
        budget = budget or {
            "hypothesis_budget": 10,
            "trial_budget": 5,
            "attempted_hypotheses": 0,
            "accepted_hypotheses": 0,
            "executed_trials": 0,
        }
        with patch.object(service.research_repo, "get_research_campaign", return_value=_campaign()), patch.object(
            service.research_hypothesis_repo, "get_budget", return_value=budget
        ), patch.object(
            service.research_hypothesis_repo, "list_comparable_attempts", return_value=comparable or []
        ), patch.object(
            service.research_hypothesis_repo, "create_attempt", side_effect=_store
        ):
            return service.submit_hypothesis("campaign-1", proposal)

    def test_allowlisted_proposal_compiles_deterministically_without_agent_risk_input(self):
        first = self._submit(_proposal())
        second = self._submit(_proposal(name="Different prose", rationale="Same executable idea."))

        self.assertEqual(first["status"], "accepted")
        self.assertEqual(first["fingerprint"], second["fingerprint"])
        self.assertEqual(first["compiled_trial"], second["compiled_trial"])
        self.assertEqual(first["compiled_trial"]["execution_config"], {"commission": 5, "slippage_ticks": 1})
        self.assertEqual(first["compiled_trial"]["strategy_params"]["atr_period"], 14)

    def test_unsupported_and_unsafe_proposals_are_recorded_as_rejected(self):
        unsupported = self._submit(_proposal(strategy_primitive="python_code", strategy_params={"source": "trade()"}))
        unsafe = self._submit(_proposal(strategy_params={"fast_period": 40, "slow_period": 20}))

        self.assertEqual(unsupported["status"], "rejected")
        self.assertIsNone(unsupported["compiled_trial"])
        self.assertIn("unsupported strategy primitive", unsupported["rejection_reasons"][0])
        self.assertEqual(unsafe["status"], "rejected")
        self.assertIn("fast_period must be less", unsafe["rejection_reasons"][0])

    def test_exact_and_near_duplicates_fail_closed(self):
        accepted = self._submit(_proposal())
        comparable = [{
            "hypothesis_attempt_id": "attempt-original",
            "fingerprint": accepted["fingerprint"],
            "proposal": _proposal().model_dump(mode="json"),
        }]
        duplicate = self._submit(_proposal(rationale="Reworded rationale."), comparable=comparable)

        near_proposal = _proposal(strategy_params={"fast_period": 10, "slow_period": 22})
        comparable[0]["fingerprint"] = "different"
        near = self._submit(near_proposal, comparable=comparable)

        self.assertEqual(duplicate["status"], "duplicate")
        self.assertEqual(duplicate["duplicate_of_attempt_id"], "attempt-original")
        self.assertEqual(near["status"], "near_duplicate")
        self.assertIsNone(near["compiled_trial"])

    def test_hypothesis_and_trial_budgets_reject_but_retain_attempts(self):
        attempt_budget = self._submit(_proposal(), budget={
            "hypothesis_budget": 2, "trial_budget": 5, "attempted_hypotheses": 2,
            "accepted_hypotheses": 1, "executed_trials": 0,
        })
        trial_budget = self._submit(_proposal(), budget={
            "hypothesis_budget": 10, "trial_budget": 1, "attempted_hypotheses": 2,
            "accepted_hypotheses": 1, "executed_trials": 0,
        })

        self.assertEqual(attempt_budget["status"], "budget_rejected")
        self.assertEqual(trial_budget["status"], "budget_rejected")
        self.assertTrue(attempt_budget["rejection_reasons"])

    def test_failed_execution_is_retained_as_a_normal_terminal_trial(self):
        now = datetime.now(timezone.utc)
        attempt = self._submit(_proposal())
        accepted = {**attempt, "trial_id": None}
        linked = {**accepted, "trial_id": "trial-failed"}
        captured = {}

        def register(campaign_id, request):
            captured["request"] = request
            return {
                "trial_id": "trial-failed", "campaign_id": campaign_id, "status": request.status.value,
            }

        with patch.object(service.research_repo, "get_research_campaign", return_value=_campaign()), patch.object(
            service.research_hypothesis_repo, "get_attempt", side_effect=[accepted, linked]
        ), patch.object(service, "register_trial", side_effect=register), patch.object(
            service.research_hypothesis_repo, "link_trial", return_value="trial-failed"
        ):
            result = service.execute_hypothesis(
                "campaign-1", "attempt-1", ResearchHypothesisExecuteRequest(actor="reviewer"),
                executor=lambda campaign, plan: (_ for _ in ()).throw(RuntimeError("fixture failure")),
            )

        self.assertEqual(captured["request"].status.value, "failed")
        self.assertEqual(captured["request"].error, "fixture failure")
        self.assertEqual(result["trial_id"], "trial-failed")


if __name__ == "__main__":
    unittest.main()
