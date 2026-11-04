"""Approval rollback, identity, retries, process crashes, and concurrent APIs.

PostgreSQL cases use only an explicit PAPER_FENCING_TEST_DSN and a unique schema.
"""

import os
import subprocess
import sys
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, nullcontext
from copy import deepcopy
from threading import Event
from unittest.mock import patch

from schemas import PaperDecisionResolutionRequest, PaperDecisionStatus
from services import (
    candidate_repo, candidate_service, candidate_store, db, experiment_repo,
    paper_runner_lease_repo, paper_runner_service, paper_session_repo,
    paper_session_service, paper_session_store,
)
from services.paper_policy_service import build_market_observation, decide_with_deterministic_policy
from services.paper_session_repo import PaperSessionWriteConflict


class _ApprovalCases:
    def setUp(self):
        self.scope = ExitStack()
        self.addCleanup(self.scope.close)
        self.configure_storage()
        suffix = uuid.uuid4().hex
        self.session_id = "approval-" + suffix
        self.candidate_id = "candidate-" + suffix
        self.now = "2024-01-02T09:30:00+00:00"
        candidate_service._save_candidate_any({
            "candidate_id": self.candidate_id, "experiment_id": "experiment-" + suffix,
            "experiment_name": "Approval fixture", "experiment_run_id": "run-" + suffix,
            "backtest_id": "backtest-" + suffix, "symbol": "ES", "interval": "1min",
            "strategy_type": "ma_crossover", "lifecycle_status": "paper_running",
            "promotion_reason": "Approval fixture", "paper_bot": {"status": "paper_running"},
            "promoted_at": self.now, "created_at": self.now, "updated_at": self.now,
        })
        self.session = {
            "paper_session_id": self.session_id, "candidate_id": self.candidate_id,
            "name": "Approval fixture", "symbol": "ES", "interval": "1min",
            "strategy_type": "ma_crossover", "strategy_params": {},
            "prop_firm_rules": {
                "name": "Approval rules", "account_size": 100_000,
                "daily_loss_limit": 0.05, "max_drawdown": 0.1,
                "profit_target": 0.1, "consistency_rule": False,
            },
            "guardrails": {}, "status": "paused", "equity_curve": [100_000],
            "current_position": paper_session_service._open_position("buy", 100.0, self.now),
            "last_quote": {"bid": 100.0, "ask": 100.25, "reference": 100.0},
            "last_bar_time": self.now,
            "runner_state": {"mode": "paused", "policy_mode": "approval_required"},
            "created_at": self.now, "updated_at": self.now,
        }
        self.bar = {
            "time": self.now, "open": 100.0, "high": 101.0, "low": 99.0,
            "close": 100.0, "volume": 10.0,
        }
        self.decision = self.proposal(self.session, -1)
        self.session["runner_state"]["pending_decision"] = self.decision.model_dump(mode="json")
        paper_session_service._save_paper_session_any(self.session)

    def proposal(self, session, signal):
        decision = decide_with_deterministic_policy(
            build_market_observation(session, self.bar, signal=signal, bar_index=1),
            policy_mode="approval_required", created_at=self.now,
        )
        decision.status = PaperDecisionStatus.PENDING_APPROVAL
        return decision

    def resolve(self, approved=True, **kwargs):
        return paper_runner_service.resolve_pending_policy_decision(
            self.session_id, decision_id=kwargs.pop("decision_id", self.decision.decision_id),
            approved=approved, actor=kwargs.pop("actor", "reviewer"), **kwargs,
        )

    def snapshots(self):
        return (
            paper_session_service.get_paper_session_any(self.session_id),
            candidate_service.get_candidate_any(self.candidate_id),
            paper_session_service.list_paper_events_any(self.session_id),
            paper_session_store.get_paper_session(self.session_id),
            candidate_store.get_candidate(self.candidate_id),
        )

    def receipts(self):
        return [e for e in paper_session_service.list_paper_events_any(self.session_id)
                if e["event_type"] == "policy_decision_resolved"]

    def test_approve_commits_both_flip_actions_and_one_receipt(self):
        result = self.resolve()
        self.assertEqual(result["status"], "paused")
        self.assertIsNone(result["runner_state"]["pending_decision"])
        self.assertEqual(result["current_position"]["side"], "sell")
        self.assertEqual(len(result["trade_log"]), 1)
        events = paper_session_service.list_paper_events_any(self.session_id)
        self.assertEqual([e["event_type"] for e in events], ["position_closed", "position_opened", "policy_decision_resolved"])
        self.assertEqual(events[2]["payload"]["action_event_ids"], [events[0]["paper_event_id"], events[1]["paper_event_id"]])
        self.assertEqual([e["payload"]["approved_action_index"] for e in events[:2]], [0, 1])
        self.assertEqual(len(candidate_service.get_candidate_any(self.candidate_id)["audit_log"]), 1)

    def test_reject_commits_no_execution_actions(self):
        result = self.resolve(approved=False)
        self.assertEqual(result["current_position"]["side"], "buy")
        self.assertEqual(result["trade_log"], [])
        self.assertEqual(result["runner_state"]["last_decision"]["status"], "rejected")
        self.assertEqual(len(self.receipts()), 1)
        self.assertEqual(self.receipts()[0]["payload"]["action_event_ids"], [])

    def test_retry_after_restart_returns_current_state_without_reexecution(self):
        for approved in (True, False):
            # Each resolution receives its own durable decision identity.
            if not approved:
                session = paper_session_service.get_paper_session_any(self.session_id)
                self.decision = self.proposal(session, 1)
                session["runner_state"]["pending_decision"] = self.decision.model_dump(mode="json")
                paper_session_service._save_paper_session_any(session)
            self.resolve(approved=approved)
            before = self.snapshots()
            with patch.object(paper_runner_service, "_session_lock", side_effect=lambda _: nullcontext()):
                self.resolve(approved=approved, actor="retry-after-restart", note="Response was lost")
            self.assertEqual(self.snapshots(), before)

    def test_opposite_resolution_is_a_conflict(self):
        self.resolve()
        before = self.snapshots()
        with self.assertRaisesRegex(PaperSessionWriteConflict, "different resolution"):
            self.resolve(approved=False)
        self.assertEqual(self.snapshots(), before)

    def test_stale_decision_id_cannot_resolve_current_proposal(self):
        before = self.snapshots()
        with self.assertRaisesRegex(PaperSessionWriteConflict, "pending policy decision changed"):
            self.resolve(decision_id="stale-proposal")
        self.assertEqual(self.snapshots(), before)

    def test_retry_does_not_clear_a_newer_pending_decision(self):
        old_id = self.decision.decision_id
        self.resolve()
        session = paper_session_service.get_paper_session_any(self.session_id)
        newer = self.proposal(session, 1)
        session["runner_state"]["pending_decision"] = newer.model_dump(mode="json")
        session["runner_state"]["last_decision"] = newer.model_dump(mode="json")
        paper_session_service._save_paper_session_any(session)
        before = self.snapshots()
        result = self.resolve(decision_id=old_id)
        self.assertEqual(result["runner_state"]["pending_decision"]["decision_id"], newer.decision_id)
        self.assertEqual(self.snapshots(), before)

    def test_exception_after_either_flip_action_rolls_back_every_effect(self):
        execute = paper_runner_service.execute_paper_session_action
        for failing_index in (0, 1):
            before = self.snapshots()

            def fail(*args, **kwargs):
                result = execute(*args, **kwargs)
                if kwargs["approved_action_index"] == failing_index:
                    raise RuntimeError("execution interrupted")
                return result

            with patch.object(paper_runner_service, "execute_paper_session_action", side_effect=fail):
                with self.assertRaisesRegex(RuntimeError, "execution interrupted"):
                    self.resolve()
            self.assertEqual(self.snapshots(), before)
        self.assertEqual(len(self.resolve()["trade_log"]), 1)

    def test_exception_after_receipt_write_rolls_back_execution(self):
        append = paper_runner_service._append_paper_event_any
        before = self.snapshots()

        def fail(event):
            append(event)
            if event["event_type"] == "policy_decision_resolved":
                raise RuntimeError("receipt interrupted")

        with patch.object(paper_runner_service, "_append_paper_event_any", side_effect=fail):
            with self.assertRaisesRegex(RuntimeError, "receipt interrupted"):
                self.resolve()
        self.assertEqual(self.snapshots(), before)

    def test_exception_after_candidate_audit_rolls_back_projection_and_execution(self):
        audit = paper_runner_service._append_candidate_session_audit
        before = self.snapshots()

        def fail(*args, **kwargs):
            audit(*args, **kwargs)
            raise RuntimeError("audit interrupted")

        with patch.object(paper_runner_service, "_append_candidate_session_audit", side_effect=fail):
            with self.assertRaisesRegex(RuntimeError, "audit interrupted"):
                self.resolve()
        self.assertEqual(self.snapshots(), before)

    def test_hard_guardrail_still_blocks_execution(self):
        before = self.snapshots()
        with patch.object(paper_runner_service, "_runner_guardrail_breached", return_value=True):
            with self.assertRaisesRegex(ValueError, "hard guardrail"):
                self.resolve()
        self.assertEqual(self.snapshots(), before)

    def test_legacy_resolution_receipt_is_also_retry_safe(self):
        legacy = self.decision.model_dump(mode="json")
        legacy.update(status="rejected", resolved_by="legacy-reviewer", resolved_at=self.now)
        session = paper_session_service.get_paper_session_any(self.session_id)
        session["runner_state"].update(pending_decision=None, last_decision=legacy)
        paper_session_service._save_paper_session_any(session)
        receipt = paper_session_service._make_paper_event(
            paper_session_id=self.session_id, candidate_id=self.candidate_id,
            event_type="policy_decision_resolved", actor="legacy-reviewer",
            summary="Legacy rejection", created_at=self.now,
            payload={"decision": legacy, "approved": False},
        )
        self.assertNotEqual(receipt["paper_event_id"], paper_session_service._policy_event_id(
            self.session_id, self.decision.decision_id, "resolution"
        ))
        paper_session_service._append_paper_event_any(receipt)
        before = self.snapshots()
        self.resolve(approved=False)
        self.assertEqual(self.snapshots(), before)

    def test_pre_upgrade_execution_without_receipt_is_not_reexecuted(self):
        # Simulate the older code committing both actions and crashing before
        # it cleared the pending decision or recorded a resolution.
        for action in self.decision.actions:
            paper_session_service.execute_paper_session_action(
                self.session_id, action=action, approved_decision_id=self.decision.decision_id,
                filled_at=self.now, sync_candidate=False,
            )
        before = self.snapshots()
        with self.assertRaisesRegex(PaperSessionWriteConflict, "without a resolution receipt"):
            self.resolve()
        self.assertEqual(self.snapshots(), before)


class MemoryApprovalResolutionTests(_ApprovalCases, unittest.TestCase):
    def configure_storage(self):
        self.scope.enter_context(patch.dict(os.environ, {"DATABASE_URL": ""}))


class ApprovalRequestTests(unittest.TestCase):
    def test_resolution_request_requires_the_displayed_decision_id(self):
        from pydantic import ValidationError

        with self.assertRaises(ValidationError):
            PaperDecisionResolutionRequest(approved=True)
        with self.assertRaises(ValidationError):
            PaperDecisionResolutionRequest(decision_id="", approved=True)


class ApprovalResolutionApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_endpoint_forwards_decision_identity(self):
        from routers import paper_sessions

        request = PaperDecisionResolutionRequest(decision_id="displayed-decision", approved=True)
        with patch.object(paper_sessions, "resolve_pending_policy_decision", return_value={}) as resolve:
            await paper_sessions.resolve_session_policy_decision("paper-1", request)
        resolve.assert_called_once_with(
            "paper-1", decision_id="displayed-decision", approved=True, actor="local-user", note=None
        )

    async def test_conflicting_resolution_returns_http_409(self):
        from fastapi import HTTPException
        from routers import paper_sessions

        request = PaperDecisionResolutionRequest(decision_id="displayed-decision", approved=False)
        with patch.object(paper_sessions, "resolve_pending_policy_decision", side_effect=PaperSessionWriteConflict("Already approved")):
            with self.assertRaises(HTTPException) as raised:
                await paper_sessions.resolve_session_policy_decision("paper-1", request)
        self.assertEqual(raised.exception.status_code, 409)


@unittest.skipUnless(os.environ.get("PAPER_FENCING_TEST_DSN"), "requires isolated PAPER_FENCING_TEST_DSN")
class PostgresApprovalResolutionTests(_ApprovalCases, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg2
        from psycopg2 import pool, sql

        cls.storage = ExitStack()
        cls.addClassCleanup(cls.storage.close)
        cls.dsn = os.environ["PAPER_FENCING_TEST_DSN"]
        cls.schema = "paper_approval_" + uuid.uuid4().hex
        with psycopg2.connect(cls.dsn) as connection:
            with connection.cursor() as cursor:
                cursor.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(cls.schema)))
        cls.connection_options = f"-csearch_path={cls.schema} -cstatement_timeout=5000 -clock_timeout=3000"
        test_pool = pool.ThreadedConnectionPool(1, 8, dsn=cls.dsn, options=cls.connection_options)
        cls.storage.callback(test_pool.closeall)
        cls.storage.enter_context(patch.object(db, "_pool", test_pool))
        cls.storage.enter_context(patch.dict(os.environ, {"DATABASE_URL": cls.dsn}))
        for repo in (candidate_repo, experiment_repo, paper_session_repo):
            cls.storage.enter_context(patch.object(repo, "_schema_ready", False))
        with db._conn() as connection:
            paper_session_repo._ensure_paper_sessions_schema(connection)

    def configure_storage(self):
        pass

    def test_concurrent_approvals_from_separate_api_contexts_execute_once(self):
        self.concurrent_resolutions(second_approved=True)

    def test_concurrent_opposite_resolution_returns_conflict(self):
        self.concurrent_resolutions(second_approved=False)

    def concurrent_resolutions(self, *, second_approved):
        execute = paper_runner_service.execute_paper_session_action
        first_action = Event()
        release = Event()
        second_started = Event()

        def pause_after_exit(*args, **kwargs):
            result = execute(*args, **kwargs)
            if kwargs["approved_action_index"] == 0:
                first_action.set()
                if not release.wait(3):
                    raise RuntimeError("test release timed out")
            return result

        def second():
            second_started.set()
            return self.resolve(approved=second_approved, actor="other-api")

        with patch.object(paper_runner_service, "_session_lock", side_effect=lambda _: nullcontext()), patch.object(
            paper_runner_service, "execute_paper_session_action", side_effect=pause_after_exit
        ), ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(self.resolve)
            try:
                self.assertTrue(first_action.wait(2))
                repeated = executor.submit(second)
                self.assertTrue(second_started.wait(2))
                self.assertFalse(repeated.done())
            finally:
                release.set()
            first.result(timeout=5)
            if second_approved:
                repeated.result(timeout=5)
            else:
                with self.assertRaises(PaperSessionWriteConflict):
                    repeated.result(timeout=5)
        session = paper_session_service.get_paper_session_any(self.session_id)
        self.assertEqual(len(session["trade_log"]), 1)
        self.assertEqual(len(self.receipts()), 1)
        self.assertEqual(len(paper_session_repo.list_paper_events(self.session_id)), 3)

    def test_process_exit_after_either_flip_action_rolls_back_and_can_retry(self):
        from psycopg2.extensions import make_dsn

        child_code = '''
import os, sys
from services import paper_runner_service as runner
execute = runner.execute_paper_session_action
def crash(*args, **kwargs):
    result = execute(*args, **kwargs)
    if kwargs["approved_action_index"] == int(sys.argv[3]):
        os._exit(23)
    return result
runner.execute_paper_session_action = crash
runner.resolve_pending_policy_decision(sys.argv[1], decision_id=sys.argv[2], approved=True)
'''
        before = self.snapshots()
        for index in (0, 1):
            child = subprocess.run(
                [sys.executable, "-c", child_code, self.session_id, self.decision.decision_id, str(index)],
                env={**os.environ, "DATABASE_URL": make_dsn(self.dsn, options=self.connection_options)},
                capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(child.returncode, 23, child.stderr)
            self.assertEqual(self.snapshots(), before)
        result = self.resolve()
        self.assertEqual(len(result["trade_log"]), 1)
        self.assertEqual(len(self.receipts()), 1)

    def test_rollback_restores_revoked_lease(self):
        lease = paper_runner_lease_repo.acquire_runner_lease(self.session_id, owner_id="fixture-worker")
        with patch.object(paper_runner_service, "_append_paper_event_any", side_effect=RuntimeError("receipt interrupted")):
            with self.assertRaisesRegex(RuntimeError, "receipt interrupted"):
                self.resolve(approved=False)
        current = paper_runner_lease_repo.get_runner_lease(self.session_id)
        self.assertEqual(current["lease_token"], lease["lease_token"])
        self.assertTrue(current["active"])


if __name__ == "__main__":
    unittest.main()
