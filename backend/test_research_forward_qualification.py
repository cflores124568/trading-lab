import unittest
from unittest.mock import patch

from schemas import (
    ResearchForwardDecisionRequest,
    ResearchForwardHandoffRequest,
)
from services import research_forward_qualification_service as service
from services import candidate_service
from services.paper_runner_service import _validate_forward_qualification_mode


def _handoff_request() -> ResearchForwardHandoffRequest:
    return ResearchForwardHandoffRequest(
        handoff_rationale="Holdout and validation evidence were reviewed by the operator.",
        min_forward_observations=10,
        min_forward_decisions=2,
        prop_firm_rules={
            "name": "Forward paper limits",
            "account_size": 100_000,
            "daily_loss_limit": 0.04,
            "max_drawdown": 0.08,
            "profit_target": 0.10,
            "consistency_rule": True,
            "consistency_threshold": 0.30,
            "drawdown_type": "eod",
            "min_trading_days": None,
        },
        actor="operator",
    )


def _qualification(**updates) -> dict:
    value = {
        "qualification_id": "qualification-1",
        "research_candidate_id": "research-candidate-1",
        "campaign_id": "campaign-1",
        "trial_id": "trial-1",
        "candidate_id": "candidate-1",
        "paper_session_id": "paper-1",
        "status": "collecting",
        "min_forward_observations": 10,
        "min_forward_decisions": 2,
        "expected_behavior": {
            "min_actionable_rate": 0.01,
            "max_actionable_rate": 0.50,
            "max_risk_block_rate": 0.25,
        },
        "evidence": {},
        "diagnostics": {},
        "gates": {},
        "approval_required": True,
        "handoff_rationale": "Reviewed.",
        "handed_off_by": "operator",
        "handed_off_at": "2026-07-19T00:00:00+00:00",
        "refreshed_at": None,
        "decided_by": None,
        "decided_at": None,
        "decision_reason": None,
    }
    value.update(updates)
    return value


class ResearchForwardQualificationTests(unittest.TestCase):
    @patch.object(candidate_service, "update_experiment_run_candidate_state")
    def test_alpha_lab_candidate_updates_do_not_require_a_fake_experiment(self, update_pointer):
        candidate_service._sync_experiment_candidate_pointer(
            {
                "candidate_id": "candidate-1",
                "experiment_id": "research:campaign-1",
                "experiment_run_id": "research:campaign-1:trial-1",
                "experiment_snapshot": {"source_kind": "alpha_lab"},
            },
            is_candidate=True,
            promoted_at="2026-07-19T00:00:00",
        )
        update_pointer.assert_not_called()

    @patch.object(service.research_forward_qualification_repo, "get_by_research_candidate", return_value=None)
    @patch.object(service.research_evaluation_repo, "get_finalist")
    @patch.object(service.research_repo, "get_research_trial")
    @patch.object(service.research_repo, "get_research_campaign")
    @patch.object(service.research_evaluation_repo, "get_research_candidate_promotion")
    def test_handoff_requires_a_qualified_holdout(
        self, get_promotion, get_campaign, get_trial, get_finalist, _get_existing
    ):
        get_promotion.return_value = {
            "research_candidate_id": "research-candidate-1",
            "trial_id": "trial-1",
        }
        get_campaign.return_value = {"campaign_id": "campaign-1"}
        get_trial.return_value = {"trial_id": "trial-1"}
        get_finalist.return_value = {
            "holdout_status": "evaluated",
            "holdout_result": {"outcome": "holdout_rejected"},
        }

        with self.assertRaisesRegex(ValueError, "holdout-rejected"):
            service.create_handoff("campaign-1", "research-candidate-1", _handoff_request())

    @patch.object(service, "_tag_session")
    @patch.object(service.research_forward_qualification_repo, "create_qualification")
    @patch.object(service, "create_paper_session_for_candidate")
    @patch.object(service, "create_paper_bot_from_candidate")
    @patch.object(service, "create_research_candidate_handoff")
    @patch.object(service.research_forward_qualification_repo, "get_by_research_candidate", return_value=None)
    @patch.object(service.research_evaluation_repo, "get_finalist")
    @patch.object(service.research_repo, "get_research_trial")
    @patch.object(service.research_repo, "get_research_campaign")
    @patch.object(service.research_evaluation_repo, "get_research_candidate_promotion")
    def test_explicit_handoff_creates_a_draft_paper_seam(
        self, get_promotion, get_campaign, get_trial, get_finalist, _get_existing,
        create_candidate, create_bot, create_session, create_qualification, tag_session,
    ):
        get_promotion.return_value = {
            "research_candidate_id": "research-candidate-1",
            "trial_id": "trial-1",
            "validation_score": 82.0,
        }
        get_campaign.return_value = {
            "campaign_id": "campaign-1", "name": "Alpha", "symbol": "NQ", "interval": "5m"
        }
        get_trial.return_value = {"trial_id": "trial-1", "strategy_type": "ma_crossover"}
        get_finalist.return_value = {
            "holdout_status": "evaluated",
            "holdout_result": {"outcome": "holdout_qualified"},
        }
        create_candidate.return_value = {"candidate_id": "candidate-1"}
        create_session.return_value = {"paper_session_id": "paper-1", "status": "draft"}
        create_qualification.side_effect = lambda value, _event: (value, True)

        result = service.create_handoff("campaign-1", "research-candidate-1", _handoff_request())

        create_bot.assert_called_once_with("candidate-1", actor="operator")
        self.assertEqual(result["status"], "collecting")
        self.assertEqual(result["paper_session_id"], "paper-1")
        tag_session.assert_called_once_with(result)

    @patch.object(service, "list_paper_events_any")
    @patch.object(service, "get_paper_session_any")
    def test_evidence_compares_behavior_costs_and_risk_blocks(self, get_session, list_events):
        get_session.return_value = {
            "paper_session_id": "paper-1",
            "status": "paused",
            "runner_state": {
                "bars_processed": 12,
                "policy_mode": "shadow",
                "shadow_scorecard": {"total_decisions": 10, "actionable_decisions": 2},
            },
            "trade_log": [{"commission": 5}, {"commission": 5}],
            "metrics_snapshot": {"total_pnl": 125},
        }
        list_events.return_value = [
            {"event_type": "policy_decision"},
            {"event_type": "policy_decision"},
            {"event_type": "risk_blocked"},
        ]

        evidence, diagnostics, gates = service._collect_evidence(_qualification())

        self.assertEqual(evidence["actionable_rate"], 0.2)
        self.assertEqual(diagnostics["execution_cost"]["average_commission_per_trade"], 5.0)
        self.assertFalse(gates["risk_block_rate"])
        self.assertTrue(gates["minimum_forward_observations"])

    def test_shadow_first_blocks_early_or_autonomous_modes(self):
        state = {
            "policy_mode": "shadow",
            "forward_qualification": {
                "status": "collecting",
                "min_forward_observations": 10,
                "min_forward_decisions": 2,
            },
            "shadow_scorecard": {"total_decisions": 9, "actionable_decisions": 2},
        }
        with self.assertRaisesRegex(ValueError, "minimum shadow observation"):
            _validate_forward_qualification_mode(state, "approval_required")
        with self.assertRaisesRegex(ValueError, "cannot use autonomous-paper"):
            _validate_forward_qualification_mode(state, "autonomous_paper")

        state["shadow_scorecard"]["total_decisions"] = 10
        _validate_forward_qualification_mode(state, "approval_required")

    @patch.object(service, "_tag_session")
    @patch.object(service.research_forward_qualification_repo, "decide")
    @patch.object(service, "get_paper_session_any")
    @patch.object(service, "refresh")
    def test_qualification_requires_gates_and_explicit_approval(
        self, refresh, get_session, decide, _tag_session
    ):
        refresh.return_value = _qualification(gates={
            "minimum_forward_observations": True,
            "minimum_forward_decisions": True,
            "expected_actionable_rate": True,
            "risk_block_rate": True,
        })
        get_session.return_value = {"status": "paused"}
        request = ResearchForwardDecisionRequest(
            outcome="qualified", decision_reason="Forward evidence is acceptable.", actor="operator"
        )
        with self.assertRaisesRegex(ValueError, "explicit operator approval"):
            service.decide("campaign-1", "qualification-1", request)

        request.approved = True
        decide.side_effect = lambda _id, **kwargs: _qualification(
            status="qualified", decided_by=kwargs["actor"], decision_reason=kwargs["reason"]
        )
        result = service.decide("campaign-1", "qualification-1", request)
        self.assertEqual(result["status"], "qualified")


if __name__ == "__main__":
    unittest.main()
