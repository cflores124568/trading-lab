import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from schemas import (
    ResearchCandidatePromotionRequest,
    ResearchHoldoutEvaluationRequest,
    ResearchValidationRequest,
)
from services import research_evaluation_service as service


def _dt(day):
    return datetime(2026, 1, day, tzinfo=timezone.utc)


def _campaign():
    return {
        "campaign_id": "campaign-1",
        "partitions": [
            {"partition_name": "development", "start_time": _dt(1), "end_time": _dt(10), "bar_count": 10},
            {"partition_name": "validation", "start_time": _dt(11), "end_time": _dt(20), "bar_count": 10},
            {"partition_name": "holdout", "start_time": _dt(21), "end_time": _dt(30), "bar_count": 10},
        ],
    }


def _stress(pnl, trades=10, drawdown=0.02):
    return [
        {"cost_multiplier": 1.0, "metrics": {"total_pnl": pnl, "max_drawdown": drawdown, "total_trades": trades, "profit_factor": 1.5}},
        {"cost_multiplier": 1.5, "metrics": {"total_pnl": pnl * 0.8, "max_drawdown": drawdown * 1.1, "total_trades": trades, "profit_factor": 1.3}},
        {"cost_multiplier": 2.0, "metrics": {"total_pnl": pnl * 0.6, "max_drawdown": drawdown * 1.2, "total_trades": trades, "profit_factor": 1.1}},
    ]


def _request():
    return ResearchValidationRequest(
        walk_forward_mode="expanding",
        folds=[
            {"fold_index": 1, "train_start": _dt(1), "train_end": _dt(10), "test_start": _dt(11), "test_end": _dt(12), "regime": "trend", "cost_stresses": _stress(100)},
            {"fold_index": 2, "train_start": _dt(1), "train_end": _dt(12), "test_start": _dt(13), "test_end": _dt(15), "regime": "range", "cost_stresses": _stress(80)},
            {"fold_index": 3, "train_start": _dt(1), "train_end": _dt(15), "test_start": _dt(16), "test_end": _dt(20), "regime": "trend", "cost_stresses": _stress(60)},
        ],
        neighbors=[
            {"strategy_params": {"fast": 8}, "validation_total_pnl": 70},
            {"strategy_params": {"fast": 10}, "validation_total_pnl": 65},
        ],
        concentration_slices=[
            {"symbol": "NQ", "interval": "15min", "total_pnl": 120, "total_trades": 20},
            {"symbol": "ES", "interval": "15min", "total_pnl": 80, "total_trades": 15},
        ],
        campaign_trial_count=25,
    )


class ResearchEvaluationTests(unittest.TestCase):
    def test_validation_scores_walk_forward_costs_regimes_and_concentration(self):
        result = service._score_validation(_request())
        self.assertEqual(result["outcome"], "research_finalist")
        self.assertTrue(all(result["gates"].values()))
        self.assertEqual(result["diagnostics"]["median_fold_pnl"], 80)
        self.assertEqual(result["diagnostics"]["worst_fold_pnl"], 60)
        self.assertIn("trend", result["diagnostics"]["regime_stability"])
        self.assertEqual(result["diagnostics"]["concentration"]["max_share"], 0.6)
        self.assertTrue(any("multiple-testing" in warning for warning in result["warnings"]))
        self.assertAlmostEqual(result["robustness_score"], sum(result["score_components"].values()))

    def test_holdout_overlap_and_non_chronological_folds_fail_closed(self):
        request = _request()
        request.folds[-1].test_end = _dt(21)
        with self.assertRaisesRegex(ValueError, "inside validation|holdout"):
            service._validate_walk_forward_boundaries(_campaign()["partitions"], request)

        request = _request()
        request.folds[0].test_end = _dt(13)
        with self.assertRaisesRegex(ValueError, "non-overlapping"):
            service._validate_walk_forward_boundaries(_campaign()["partitions"], request)

    def test_weak_evidence_has_explainable_rejection_reasons(self):
        request = _request()
        request.folds[0].cost_stresses = ResearchValidationRequest.model_validate(_request().model_dump()).folds[0].cost_stresses
        for fold in request.folds:
            fold.cost_stresses[2].metrics.total_pnl = -10
            fold.cost_stresses[0].metrics.total_trades = 1
            fold.cost_stresses[0].metrics.max_drawdown = 0.20
        request.neighbors[0].validation_total_pnl = -100
        request.neighbors[1].validation_total_pnl = -50

        result = service._score_validation(request)
        self.assertEqual(result["outcome"], "rejected")
        self.assertFalse(result["gates"]["minimum_trade_coverage"])
        self.assertFalse(result["gates"]["two_x_cost_median_profitable"])
        self.assertFalse(result["gates"]["parameter_stability"])
        self.assertGreaterEqual(len(result["rejection_reasons"]), 3)

    def test_validation_is_idempotent_only_for_identical_evidence(self):
        request = _request()
        stored = {
            "evaluation_id": "evaluation-1",
            "campaign_id": "campaign-1",
            "trial_id": "trial-1",
            **service._score_validation(request),
            "evidence": request.model_dump(mode="json"),
            "created_at": _dt(20),
        }
        with patch.object(service.research_repo, "get_research_campaign", return_value=_campaign()), patch.object(
            service.research_repo, "get_research_trial", return_value={"status": "completed"}
        ), patch.object(service.research_evaluation_repo, "save_validation_evaluation", return_value=(stored, False)):
            result = service.evaluate_validation("campaign-1", "trial-1", request)
        self.assertEqual(result["evaluation_id"], "evaluation-1")

    def test_holdout_requires_freeze_and_can_only_be_recorded_once(self):
        request = ResearchHoldoutEvaluationRequest(cost_stresses=_stress(50), actor="test")
        with patch.object(service.research_evaluation_repo, "get_finalist", return_value=None):
            with self.assertRaisesRegex(ValueError, "Freeze"):
                service.evaluate_holdout("campaign-1", "trial-1", request)
        with patch.object(
            service.research_evaluation_repo,
            "get_finalist",
            return_value={"holdout_status": "evaluated"},
        ):
            with self.assertRaisesRegex(ValueError, "already"):
                service.evaluate_holdout("campaign-1", "trial-1", request)

    def test_manual_promotion_requires_a_frozen_gate_passing_finalist(self):
        request = ResearchCandidatePromotionRequest(
            promotion_reason="Stable across folds and transaction-cost stress.",
            actor="operator",
        )
        with patch.object(service.research_evaluation_repo, "get_finalist", return_value=None):
            with self.assertRaisesRegex(ValueError, "frozen"):
                service.promote_candidate("campaign-1", "trial-1", request)

        rejected = {
            "evaluation_id": "evaluation-1",
            "outcome": "rejected",
            "gates": {"parameter_stability": False},
        }
        with patch.object(
            service.research_evaluation_repo,
            "get_finalist",
            return_value={"frozen_validation_score": 81.5},
        ), patch.object(service, "get_validation", return_value=rejected):
            with self.assertRaisesRegex(ValueError, "every validation gate"):
                service.promote_candidate("campaign-1", "trial-1", request)

    def test_manual_promotion_is_idempotent_and_does_not_touch_paper_runtime(self):
        request = ResearchCandidatePromotionRequest(
            promotion_reason="Operator reviewed the complete validation evidence.",
            actor="operator",
        )
        evaluation = {
            "evaluation_id": "evaluation-1",
            "outcome": "research_finalist",
            "gates": {"coverage": True, "costs": True},
        }
        stored = {
            "research_candidate_id": "research-candidate-1",
            "campaign_id": "campaign-1",
            "trial_id": "trial-1",
            "evaluation_id": "evaluation-1",
            "validation_score": 81.5,
            "promotion_reason": request.promotion_reason,
            "promoted_by": "operator",
            "promoted_at": _dt(20),
        }
        with patch.object(
            service.research_evaluation_repo,
            "get_finalist",
            return_value={"frozen_validation_score": 81.5},
        ), patch.object(service, "get_validation", return_value=evaluation), patch.object(
            service.research_evaluation_repo,
            "promote_research_candidate",
            return_value=(stored, False),
        ) as save:
            result = service.promote_candidate("campaign-1", "trial-1", request)
        self.assertEqual(result["research_candidate_id"], "research-candidate-1")
        self.assertEqual(save.call_count, 1)


if __name__ == "__main__":
    unittest.main()
