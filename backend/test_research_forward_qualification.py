import os
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, nullcontext
from threading import Event
from unittest.mock import patch

from schemas import (
    ResearchForwardDecisionRequest,
    ResearchForwardHandoffRequest,
)
from services import (
    backtest_repo, candidate_repo, candidate_service, db, experiment_repo, paper_session_repo,
    paper_session_store, research_repo,
)
from services import paper_runner_lease_repo as leases
from services import paper_runner_service as runner
from services import paper_session_service as sessions
from services import research_forward_qualification_repo as qualifications
from services import research_forward_qualification_service as service
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

    @patch.object(service, "locked_paper_session_transaction", return_value=nullcontext())
    @patch.object(service, "_require_paper_session")
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
        create_candidate, create_bot, create_session, create_qualification, tag_session, require_session, _lock,
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
        require_session.return_value = create_session.return_value
        create_qualification.side_effect = lambda value, _event: (value, True)

        result = service.create_handoff("campaign-1", "research-candidate-1", _handoff_request())

        create_bot.assert_called_once_with("candidate-1", actor="operator")
        self.assertEqual(result["status"], "collecting")
        self.assertEqual(result["paper_session_id"], "paper-1")
        tag_session.assert_called_once_with(result, require_session.return_value)

    @patch.object(service, "list_paper_events_any")
    def test_evidence_compares_behavior_costs_and_risk_blocks(self, list_events):
        session = {
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

        evidence, diagnostics, gates = service._collect_evidence(_qualification(), session)

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
    @patch.object(service, "_refresh_evidence")
    @patch.object(service, "_locked_qualification", return_value=nullcontext((_qualification(), {"status": "paused"})))
    @patch.object(service, "_require_qualification", return_value=_qualification())
    def test_qualification_requires_gates_and_explicit_approval(
        self, _require, _lock, refresh, decide, _tag_session
    ):
        refresh.return_value = _qualification(gates={
            "minimum_forward_observations": True,
            "minimum_forward_decisions": True,
            "expected_actionable_rate": True,
            "risk_block_rate": True,
        })
        request = ResearchForwardDecisionRequest(
            outcome="qualified", decision_reason="Forward evidence is acceptable.", actor="operator"
        )
        with self.assertRaisesRegex(ValueError, "explicit operator approval"):
            service.decide("campaign-1", "qualification-1", request)
        decide.assert_not_called()

        request.approved = True
        decide.side_effect = lambda _id, **kwargs: _qualification(
            status="qualified", decided_by=kwargs["actor"], decision_reason=kwargs["reason"]
        )
        result = service.decide("campaign-1", "qualification-1", request)
        self.assertEqual(result["status"], "qualified")


@unittest.skipUnless(os.environ.get("PAPER_FENCING_TEST_DSN"), "requires isolated PAPER_FENCING_TEST_DSN")
class PostgresForwardQualificationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg2
        from psycopg2 import pool, sql

        scope = ExitStack()
        cls.addClassCleanup(scope.close)
        dsn = os.environ["PAPER_FENCING_TEST_DSN"]
        schema = "forward_qualification_" + uuid.uuid4().hex
        with psycopg2.connect(dsn) as connection:
            with connection.cursor() as cursor:
                cursor.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        test_pool = pool.ThreadedConnectionPool(
            1, 8, dsn=dsn, options=f"-csearch_path={schema} -cstatement_timeout=5000 -clock_timeout=3000",
        )
        scope.callback(test_pool.closeall)
        scope.enter_context(patch.object(db, "_pool", test_pool))
        scope.enter_context(patch.dict(os.environ, {"DATABASE_URL": dsn}))
        for repo in (backtest_repo, candidate_repo, experiment_repo, paper_session_repo, qualifications, research_repo):
            scope.enter_context(patch.object(repo, "_schema_ready", False))
        with db._conn() as connection:
            with connection.cursor() as cursor:
                cursor.execute("CREATE TABLE backtests (backtest_id TEXT PRIMARY KEY)")
            connection.commit()
            qualifications._ensure_forward_qualification_schema(connection)

    def setUp(self):
        suffix = uuid.uuid4().hex
        self.campaign_id = "campaign-" + suffix
        self.trial_id = "trial-" + suffix
        self.promotion_id = "promotion-" + suffix
        evaluation_id = "evaluation-" + suffix
        with db._conn() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """INSERT INTO research_campaigns
                    (campaign_id, name, symbol, interval, start_time, end_time,
                     development_pct, validation_pct, holdout_pct, total_bar_count)
                    VALUES (%s, 'Fixture', 'ES', '1min', '2024-01-01', '2024-01-02', 60, 20, 20, 100)""",
                    [self.campaign_id],
                )
                cursor.execute(
                    """INSERT INTO research_trials
                    (trial_id, campaign_id, fingerprint, strategy_type, status, completed_at)
                    VALUES (%s, %s, %s, 'ma_crossover', 'completed', NOW())""",
                    [self.trial_id, self.campaign_id, suffix],
                )
                cursor.execute(
                    """INSERT INTO research_trial_evaluations
                    (evaluation_id, campaign_id, trial_id, evidence_fingerprint, outcome,
                     robustness_score, score_components, gates, diagnostics, evidence)
                    VALUES (%s, %s, %s, %s, 'research_finalist', 82, '{}', '{}', '{}', '{}')""",
                    [evaluation_id, self.campaign_id, self.trial_id, suffix],
                )
                cursor.execute(
                    """INSERT INTO research_campaign_finalists
                    (campaign_id, trial_id, evaluation_id, frozen_validation_score,
                     holdout_status, holdout_result, holdout_evaluated_at, frozen_by)
                    VALUES (%s, %s, %s, 82, 'evaluated', '{"outcome":"holdout_qualified"}', NOW(), 'test')""",
                    [self.campaign_id, self.trial_id, evaluation_id],
                )
                cursor.execute(
                    """INSERT INTO research_candidate_promotions
                    (research_candidate_id, campaign_id, trial_id, evaluation_id,
                     validation_score, promotion_reason, promoted_by)
                    VALUES (%s, %s, %s, %s, 82, 'Fixture', 'test')""",
                    [self.promotion_id, self.campaign_id, self.trial_id, evaluation_id],
                )
            connection.commit()

    def handoff(self):
        result = service.create_handoff(self.campaign_id, self.promotion_id, _handoff_request())
        self.qualification_id = result["qualification_id"]
        self.session_id = result["paper_session_id"]
        return result

    def paused_handoff(self):
        self.handoff()
        sessions.update_paper_session_status(self.session_id, "ready")
        runner.pause_historical_runner(self.session_id)

    def reject(self):
        return service.decide(
            self.campaign_id, self.qualification_id,
            ResearchForwardDecisionRequest(outcome="rejected", decision_reason="Forward evidence fell short."),
        )

    def snapshot(self):
        return (
            qualifications.get_qualification(self.qualification_id),
            sessions.get_paper_session_any(self.session_id),
            paper_session_store.get_paper_session(self.session_id),
            research_repo.get_research_campaign(self.campaign_id)["audit_events"],
        )

    def test_failed_tag_rolls_back_rejection_evidence_and_audit(self):
        self.paused_handoff()
        before = self.snapshot()
        tag = service._tag_session

        def fail_after_tag(*args):
            tag(*args)
            raise RuntimeError("interrupted after session tag write")

        with patch.object(service, "_tag_session", side_effect=fail_after_tag):
            with self.assertRaisesRegex(RuntimeError, "interrupted after session tag write"):
                self.reject()
        self.assertEqual(self.snapshot(), before)

        self.assertEqual(self.reject()["status"], "rejected")
        saved = self.snapshot()
        self.assertEqual(saved[1]["runner_state"]["forward_qualification"]["status"], "rejected")
        with self.assertRaisesRegex(ValueError, "immutable"):
            self.reject()
        self.assertEqual(self.snapshot(), saved)

    def test_runner_start_waits_for_rejection_and_sees_the_committed_outcome(self):
        self.paused_handoff()
        tagged = Event()
        release = Event()
        start_requested = Event()
        tag = service._tag_session

        def hold_decision(*args):
            tag(*args)
            tagged.set()
            if not release.wait(3):
                raise RuntimeError("test decision release timed out")

        def start_runner():
            start_requested.set()
            return runner.start_historical_runner(self.session_id)

        with patch.object(service, "_tag_session", side_effect=hold_decision), ThreadPoolExecutor(2) as executor:
            reject = executor.submit(self.reject)
            try:
                self.assertTrue(tagged.wait(2))
                start = executor.submit(start_runner)
                self.assertTrue(start_requested.wait(2))
                self.assertEqual(qualifications.get_qualification(self.qualification_id)["status"], "collecting")
                self.assertFalse(start.done())
            finally:
                release.set()
            self.assertEqual(reject.result(timeout=5)["status"], "rejected")
            with self.assertRaisesRegex(ValueError, "Rejected forward qualifications"):
                start.result(timeout=5)
        self.assertEqual(sessions.get_paper_session_any(self.session_id)["status"], "paused")

    def test_decision_leaves_evidence_untouched_if_runner_started_first(self):
        self.paused_handoff()
        runner.start_historical_runner(self.session_id)
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "Pause the paper session"):
            self.reject()
        self.assertEqual(self.snapshot(), before)

    def test_legacy_stale_tag_cannot_bypass_rejection(self):
        self.paused_handoff()
        self.reject()
        for stale_tag in (None, {"status": "qualified"}):
            with self.subTest(stale_tag=stale_tag):
                session = sessions.get_paper_session_any(self.session_id)
                session["runner_state"]["forward_qualification"] = stale_tag
                sessions._save_paper_session_any(session)
                for advance in (
                    lambda: sessions.update_paper_session_status(self.session_id, "running"),
                    lambda: runner.start_historical_runner(self.session_id),
                    lambda: runner.step_historical_runner(self.session_id),
                ):
                    with self.assertRaisesRegex(ValueError, "Rejected forward qualifications"):
                        advance()

        session["status"] = "running"
        session["runner_state"]["mode"] = "running"
        sessions._save_paper_session_any(session)
        lease = leases.acquire_runner_lease(self.session_id, owner_id="legacy-worker")
        with patch.object(runner, "get_next_ohlcv_bar") as fetch:
            _, outcome = runner.advance_historical_runner_worker_once(
                self.session_id, owner_id="legacy-worker", lease_token=lease["lease_token"],
            )
        self.assertEqual(outcome, "not_running")
        fetch.assert_not_called()

    def test_failed_handoff_tag_requires_retry_before_runner_can_start(self):
        with patch.object(service, "_tag_session", side_effect=RuntimeError("interrupted handoff")):
            with self.assertRaisesRegex(RuntimeError, "interrupted handoff"):
                self.handoff()
        self.assertIsNone(qualifications.get_by_research_candidate(self.promotion_id))
        candidate = candidate_service.get_candidate_by_run_any(f"research:{self.campaign_id}:{self.trial_id}")
        session = sessions.get_paper_session_by_candidate_any(candidate["candidate_id"])
        self.assertEqual(session["status"], "draft")
        sessions.update_paper_session_status(session["paper_session_id"], "ready")
        with self.assertRaisesRegex(ValueError, "Complete the forward qualification handoff"):
            runner.start_historical_runner(session["paper_session_id"])

        result = self.handoff()
        self.assertEqual(result["paper_session_id"], session["paper_session_id"])
        state = sessions.get_paper_session_any(self.session_id)["runner_state"]
        self.assertEqual(state["policy_mode"], "shadow")
        self.assertEqual(state["forward_qualification"]["status"], "collecting")


if __name__ == "__main__":
    unittest.main()
