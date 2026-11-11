import os
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, nullcontext
from datetime import datetime, timedelta, timezone
from threading import Event
from unittest.mock import Mock, patch

from schemas import (
    ResearchCampaignControlRequest, ResearchCampaignQueueRequest, ResearchHypothesisBudgetRequest,
    ResearchHypothesisExecuteRequest, ResearchHypothesisProposal, ResearchTrialCreate,
)
from services import db, research_hypothesis_repo, research_repo, research_search_worker, research_service
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
        attempt = self._submit(_proposal())
        captured = {}

        def register(campaign_id, request):
            captured["request"] = request
            return {
                "trial_id": "trial-failed", "campaign_id": campaign_id, "status": request.status.value,
            }

        with patch.object(service.research_repo, "get_research_campaign", return_value=_campaign()), patch.object(
            service.research_hypothesis_repo, "get_attempt", return_value=attempt
        ), patch.object(
            service.research_hypothesis_repo, "execution_transaction", return_value=nullcontext()
        ), patch.object(
            service.research_hypothesis_repo, "lock_campaign_status", return_value="draft"
        ), patch.object(
            service.research_repo, "get_research_trial_status_by_fingerprint", return_value=None
        ), patch.object(
            service, "savepoint", return_value=nullcontext()
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

    def test_explicit_empty_execution_config_uses_defaults(self):
        campaign = _campaign()
        campaign["symbol"] = "ES"
        campaign["interval"] = "1min"
        now = datetime.now(timezone.utc)
        campaign["partitions"] = [{"partition_name": "development", "start_time": now, "end_time": now}]
        campaign["search_config"]["execution_config"]["commission"] = 25
        plan = {"strategy_type": "ema_crossover", "strategy_params": {}, "execution_config": {}}
        with patch.object(research_search_worker, "load_from_db", return_value={"dataset_id": "data-1"}), patch.object(
            research_search_worker, "get_dataset", return_value={}
        ), patch.object(
            research_search_worker, "build_backtest_result",
            return_value={"metrics": {}, "prop_firm_eval": {}, "run_config": {}},
        ) as backtest:
            research_search_worker.execute_search_plan(campaign, plan)
        self.assertEqual(backtest.call_args.args[1].commission, 5)


@unittest.skipUnless(os.environ.get("PAPER_FENCING_TEST_DSN"), "requires isolated PAPER_FENCING_TEST_DSN")
class PostgresHypothesisExecutionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg2
        from psycopg2 import pool, sql

        scope = ExitStack()
        cls.addClassCleanup(scope.close)
        dsn = os.environ["PAPER_FENCING_TEST_DSN"]
        schema = "hypothesis_execution_" + uuid.uuid4().hex
        with psycopg2.connect(dsn) as connection:
            with connection.cursor() as cursor:
                cursor.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        test_pool = pool.ThreadedConnectionPool(
            1, 8, dsn=dsn, options=f"-csearch_path={schema} -cstatement_timeout=5000 -clock_timeout=3000",
        )
        scope.callback(test_pool.closeall)
        scope.enter_context(patch.object(db, "_pool", test_pool))
        scope.enter_context(patch.dict(os.environ, {"DATABASE_URL": dsn}))
        for repo in (research_repo, research_hypothesis_repo):
            scope.enter_context(patch.object(repo, "_schema_ready", False))
        with db._conn() as connection:
            research_repo._ensure_research_schema(connection)
            research_hypothesis_repo._ensure_schema(connection)

    def setUp(self):
        self.campaign_id = "campaign-" + uuid.uuid4().hex
        now = datetime.now(timezone.utc)
        research_repo.create_research_campaign(
            {
                "campaign_id": self.campaign_id, "name": "Hypothesis execution fixture",
                "symbol": "ES", "interval": "1min", "start_time": now,
                "end_time": now + timedelta(minutes=4), "development_pct": 60,
                "validation_pct": 20, "holdout_pct": 20, "status": "draft",
                "total_bar_count": 5, "created_by": "test", "created_at": now, "updated_at": now,
            },
            [{"partition_name": "development", "start_time": now, "end_time": now + timedelta(minutes=2), "bar_count": 3}],
            research_service._event(
                campaign_id=self.campaign_id, event_type="campaign_created", actor="test",
                summary="Created hypothesis fixture.", payload={}, created_at=now,
            ),
        )
        self.queue(commission=7)
        self.pause()
        service.configure_budget(self.campaign_id, ResearchHypothesisBudgetRequest(hypothesis_budget=3, trial_budget=2))
        self.attempt = service.submit_hypothesis(self.campaign_id, _proposal())
        self.attempt_id = self.attempt["hypothesis_attempt_id"]
        self.assertEqual(self.attempt["status"], "accepted")

    def queue(self, *, commission=25):
        return research_service.queue_campaign(self.campaign_id, ResearchCampaignQueueRequest(
            strategy_type="ema_crossover", parameter_space={"fast_period": [9], "slow_period": [21]},
            execution_config={"commission": commission, "slippage_ticks": 2},
            trial_budget=2, wall_clock_budget_seconds=600,
        ))

    def pause(self):
        research_service.pause_campaign(self.campaign_id, ResearchCampaignControlRequest())

    def execute(self, **kwargs):
        return service.execute_hypothesis(
            self.campaign_id, self.attempt_id, ResearchHypothesisExecuteRequest(actor="reviewer"), **kwargs,
        )

    def snapshot(self):
        return (
            service.get_hypothesis(self.campaign_id, self.attempt_id),
            research_repo.list_research_trials(self.campaign_id, limit=20, offset=0),
            research_repo.get_research_campaign(self.campaign_id)["audit_events"],
        )

    def test_backtest_and_trial_use_the_same_frozen_execution_config(self):
        self.queue(commission=40)
        self.pause()

        def backtest(_dataset, request):
            return {
                "metrics": {}, "prop_firm_eval": {},
                "run_config": {"commission": request.commission, "slippage_ticks": request.slippage_ticks},
            }

        with patch.object(research_search_worker, "load_from_db", return_value={"dataset_id": "fixture"}), patch.object(
            research_search_worker, "get_dataset", return_value={}
        ), patch.object(research_search_worker, "build_backtest_result", side_effect=backtest):
            linked = self.execute()
        trial = research_repo.get_research_trial(self.campaign_id, linked["trial_id"])
        self.assertEqual(trial["execution_config"], {"commission": 7, "slippage_ticks": 2})
        self.assertEqual(trial["result"]["run_config"], trial["execution_config"])

    def test_concurrent_requests_compute_once_and_retry_returns_link(self):
        entered = Event()
        release = Event()
        duplicate_executor = Mock()

        def compute(*_args):
            entered.set()
            if not release.wait(3):
                raise RuntimeError("test executor release timed out")
            return {"metrics": {}}

        with ThreadPoolExecutor(2) as executor:
            first = executor.submit(self.execute, executor=compute)
            try:
                self.assertTrue(entered.wait(2))
                duplicate = executor.submit(self.execute, executor=duplicate_executor)
                with self.assertRaisesRegex(service.HypothesisExecutionConflict, "already executing"):
                    duplicate.result(timeout=2)
                self.assertIsNone(self.snapshot()[0]["trial_id"])
            finally:
                release.set()
            linked = first.result(timeout=5)
        self.assertIsNotNone(linked["trial_id"])
        self.queue()
        self.assertEqual(self.execute(executor=duplicate_executor)["trial_id"], linked["trial_id"])
        duplicate_executor.assert_not_called()
        _, trials, events = self.snapshot()
        self.assertEqual(len(trials), 1)
        self.assertEqual(sum(event["event_type"] == "hypothesis_trial_executed" for event in events), 1)

    def test_failure_after_link_rolls_back_trial_link_and_audit(self):
        before = self.snapshot()
        link = research_hypothesis_repo.link_trial

        def fail_after_link(*args, **kwargs):
            link(*args, **kwargs)
            raise RuntimeError("interrupted after linking")

        with patch.object(research_hypothesis_repo, "link_trial", side_effect=fail_after_link):
            with self.assertRaisesRegex(RuntimeError, "interrupted after linking"):
                self.execute(executor=lambda *_: {})
        self.assertEqual(self.snapshot(), before)
        linked = self.execute(executor=lambda *_: {})
        self.assertIsNotNone(linked["trial_id"])
        self.assertEqual(len(self.snapshot()[1]), 1)

    def test_failed_market_query_still_commits_a_failed_trial(self):
        linked = self.execute(executor=lambda *_: db._read_sql("SELECT * FROM missing_hypothesis_market_fixture"))
        trial = research_repo.get_research_trial(self.campaign_id, linked["trial_id"])
        self.assertEqual(trial["status"], "failed")
        self.assertIn("missing_hypothesis_market_fixture", trial["error"])

    def test_queue_during_computation_prevents_publication(self):
        def compute(*_args):
            with ThreadPoolExecutor(1) as executor:
                executor.submit(self.queue).result(timeout=3)
            return {"metrics": {}}

        with self.assertRaisesRegex(ValueError, "Pause the campaign worker"):
            self.execute(executor=compute)
        attempt, trials, events = self.snapshot()
        self.assertIsNone(attempt["trial_id"])
        self.assertEqual(trials, [])
        self.assertEqual(events[0]["event_type"], "campaign_queued")

    def test_unlinked_legacy_trial_cannot_be_published_as_verified(self):
        old = research_service.register_trial(self.campaign_id, ResearchTrialCreate(
            **self.attempt["compiled_trial"], status="completed", result={"run_config": {"commission": 99}},
        ))
        compute = Mock()
        before = self.snapshot()
        with self.assertRaisesRegex(service.HypothesisExecutionConflict, "unlinked trial"):
            self.execute(executor=compute)
        compute.assert_not_called()
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(before[1][0]["trial_id"], old["trial_id"])


if __name__ == "__main__":
    unittest.main()
