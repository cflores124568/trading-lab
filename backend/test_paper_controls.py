"""Control invariants and rollback; PostgreSQL uses an explicit isolated DSN."""

import os
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, contextmanager, nullcontext
from copy import deepcopy
from threading import Event
from unittest.mock import patch

import pandas as pd

from schemas import PaperSessionExecutionRequest
from services import (
    backtest_repo, candidate_repo, candidate_service, candidate_store, db, experiment_repo,
    paper_runner_lease_repo as leases, paper_runner_service as runner,
    paper_session_repo, paper_session_service as sessions, paper_session_store,
)


class _ControlCases:
    def setUp(self):
        self.scope = ExitStack()
        self.addCleanup(self.scope.close)
        self.configure_storage()
        self.scope.enter_context(patch.object(runner, "_require_db_runner_support"))
        suffix = uuid.uuid4().hex
        self.session_id = "control-" + suffix
        self.candidate_id = "candidate-" + suffix
        self.now = "2024-01-02T09:30:00+00:00"
        candidate_service._save_candidate_any({
            "candidate_id": self.candidate_id, "experiment_id": "experiment-" + suffix,
            "experiment_name": "Control fixture", "experiment_run_id": "run-" + suffix,
            "backtest_id": "backtest-" + suffix, "symbol": "ES", "interval": "1min",
            "strategy_type": "ma_crossover", "lifecycle_status": "paper_ready",
            "promotion_reason": "Control fixture", "paper_bot": {"status": "ready"},
            "promoted_at": self.now, "created_at": self.now, "updated_at": self.now,
        })
        sessions._save_paper_session_any({
            "paper_session_id": self.session_id, "candidate_id": self.candidate_id,
            "name": "Control fixture", "symbol": "ES", "interval": "1min",
            "strategy_type": "ma_crossover", "strategy_params": {},
            "prop_firm_rules": {
                "name": "Control rules", "account_size": 100_000,
                "daily_loss_limit": 0.05, "max_drawdown": 0.1,
                "profit_target": 0.1, "consistency_rule": False,
            },
            "guardrails": {}, "status": "ready", "equity_curve": [100_000],
            "current_position": sessions._open_position("buy", 100.0, self.now),
            "last_bar_time": self.now,
            "runner_state": {
                "mode": "idle", "policy_mode": "shadow", "poll_interval_ms": 1500,
                "bars_processed": 7, "start_date": "2024-01-01T00:00:00+00:00",
                "end_date": "2024-01-03T00:00:00+00:00",
            },
            "created_at": self.now, "updated_at": self.now,
        })
        self.addCleanup(runner._reset_signal_history, self.session_id)

    def session(self):
        return sessions.get_paper_session_any(self.session_id)

    def seed(self, *, status=None, **state):
        session = self.session()
        if status is not None:
            session["status"] = status
        session["runner_state"].update(state)
        sessions._save_paper_session_any(session)

    def transition(self, status):
        return sessions.update_paper_session_status(self.session_id, status)

    def reject_candidate(self):
        return candidate_service.update_candidate_status(self.candidate_id, "rejected", actor="reviewer")

    def snapshots(self):
        return (
            self.session(), candidate_service.get_candidate_any(self.candidate_id),
            sessions.list_paper_events_any(self.session_id),
            paper_session_store.get_paper_session(self.session_id),
            candidate_store.get_candidate(self.candidate_id),
        )

    def test_generic_start_sets_worker_intent_and_preserves_progress(self):
        before = self.session()
        result = self.transition("running")
        self.assertEqual((result["status"], result["runner_state"]["mode"]), ("running", "running"))
        self.assertEqual(result["last_bar_time"], before["last_bar_time"])
        for key in ("poll_interval_ms", "start_date", "end_date", "bars_processed", "policy_mode"):
            self.assertEqual(result["runner_state"][key], before["runner_state"][key])
        candidate = candidate_service.get_candidate_any(self.candidate_id)
        self.assertEqual(candidate["lifecycle_status"], "paper_running")
        self.assertEqual(candidate["paper_bot"]["status"], "paper_running")
        self.assertEqual(len(candidate["audit_log"]), 1)
        self.assertEqual(len(sessions.list_paper_events_any(self.session_id)), 1)

    def test_start_and_step_enforce_the_same_safety_guards(self):
        original = self.session()["runner_state"]
        blocked = (
            {"kill_switch_engaged": True},
            {"pending_decision": {"decision_id": "pending"}},
            {"forward_qualification": {"status": "rejected"}},
            {"forward_qualification": {"status": "collecting"}, "policy_mode": "autonomous_paper"},
            {"forward_qualification": {"status": "collecting"}, "policy_mode": "approval_required"},
        )
        for state in blocked:
            for start in (
                lambda: self.transition("running"),
                lambda: runner.start_historical_runner(self.session_id),
                lambda: runner.step_historical_runner(self.session_id),
            ):
                with self.subTest(state=state, start=start):
                    self.seed(**{**deepcopy(original), **state})
                    before = self.snapshots()
                    with self.assertRaises(ValueError):
                        start()
                    self.assertEqual(self.snapshots(), before)

    def mock_step_bars(self, signals):
        bars = [
            {"time": f"2024-01-02T09:{minute:02}:00+00:00",
             "open": 100, "high": 101, "low": 99, "close": 100, "volume": 10}
            for minute in (31, 32)
        ]
        self.scope.enter_context(patch.object(runner, "get_ohlcv", return_value=pd.DataFrame()))
        self.scope.enter_context(patch.object(runner, "_compute_strategy_signal", side_effect=signals))
        fetch = self.scope.enter_context(patch.object(runner, "get_next_ohlcv_bar", side_effect=bars))
        return bars, fetch

    def test_step_rolls_back_failed_reversal_and_keeps_the_previous_bar(self):
        self.seed(policy_mode="autonomous_paper")
        bars, fetch = self.mock_step_bars([0, -1, -1])
        execute = runner.execute_paper_session_action

        def fail_after_close(*args, **kwargs):
            result = execute(*args, **kwargs)
            if kwargs["action"] == "flatten":
                raise RuntimeError("interrupted between reversal fills")
            return result

        with patch.object(runner, "execute_paper_session_action", side_effect=fail_after_close):
            with self.assertRaisesRegex(RuntimeError, "interrupted between reversal fills"):
                runner.step_historical_runner(self.session_id, steps=2)

        saved = self.session()
        self.assertEqual(saved["last_bar_time"], bars[0]["time"])
        self.assertEqual(saved["runner_state"]["bars_processed"], 8)
        self.assertEqual(saved["current_position"]["side"], "buy")
        self.assertEqual(saved["trade_log"], [])
        self.assertEqual(saved["status"], "paused")
        self.assertEqual(candidate_service.get_candidate_any(self.candidate_id)["lifecycle_status"], "paper_paused")
        events = sessions.list_paper_events_any(self.session_id)
        self.assertEqual([e["event_type"] for e in events], ["position_marked", "policy_decision", "runner_bar_advanced"])

        fetch.side_effect = None
        fetch.return_value = bars[1]
        retried = runner.step_historical_runner(self.session_id)
        self.assertEqual(retried["last_bar_time"], bars[1]["time"])
        self.assertEqual(retried["current_position"]["side"], "sell")
        self.assertEqual(len(retried["trade_log"]), 1)
        self.assertEqual(retried["status"], "paused")

    def test_manual_fill_preserves_runner_intent_and_rolls_back_with_its_audit(self):
        request = PaperSessionExecutionRequest(action="hit_bid", price=100)
        before = self.snapshots()
        with patch.object(sessions, "_append_candidate_session_audit", side_effect=RuntimeError("audit interrupted")):
            with self.assertRaisesRegex(RuntimeError, "audit interrupted"):
                runner.execute_manual_paper_session_action(self.session_id, request)
        self.assertEqual(self.snapshots(), before)

        result = runner.execute_manual_paper_session_action(self.session_id, request)
        self.assertEqual((result["status"], result["runner_state"]["mode"]), ("ready", "idle"))
        self.assertEqual(result["current_position"]["side"], "sell")
        self.assertEqual(len(result["trade_log"]), 1)
        self.assertEqual(candidate_service.get_candidate_any(self.candidate_id)["lifecycle_status"], "paper_ready")

    def test_pause_and_stop_preserve_the_paper_book_and_cursor(self):
        self.transition("running")
        before = self.session()
        paused = runner.pause_historical_runner(self.session_id)
        self.assertEqual((paused["status"], paused["runner_state"]["mode"]), ("paused", "paused"))
        self.transition("running")
        stopped = self.transition("stopped")
        self.assertEqual((stopped["status"], stopped["runner_state"]["mode"]), ("stopped", "paused"))
        for key in ("current_position", "active_orders", "last_bar_time", "trade_log", "equity_curve"):
            self.assertEqual(stopped[key], before[key])

    def test_stopped_session_requires_explicit_reopen(self):
        self.transition("stopped")
        before = self.snapshots()
        for start in (lambda: self.transition("running"), lambda: runner.start_historical_runner(self.session_id)):
            with self.assertRaises(ValueError):
                start()
            self.assertEqual(self.snapshots(), before)
        ready = self.transition("ready")
        self.assertEqual(ready["runner_state"]["mode"], "idle")
        self.assertEqual(self.transition("running")["runner_state"]["mode"], "running")

    def test_fail_and_reopen_normalize_runner_diagnostics(self):
        self.transition("running")
        failed = sessions.update_paper_session_status(self.session_id, "failed", summary="Operator investigation")
        self.assertEqual(failed["runner_state"]["mode"], "failed")
        self.assertEqual(failed["runner_state"]["last_error"], "Operator investigation")
        ready = self.transition("ready")
        self.assertEqual(ready["runner_state"]["mode"], "idle")
        self.assertIsNone(ready["runner_state"]["last_error"])

    def test_same_status_repairs_legacy_intent(self):
        self.seed(status="running", mode="idle")
        self.assertEqual(self.transition("running")["runner_state"]["mode"], "running")
        self.seed(status="paused", mode="running")
        self.assertEqual(self.transition("paused")["runner_state"]["mode"], "paused")

    def test_pausing_completed_runner_keeps_completion_diagnostics(self):
        self.seed(status="paused", mode="completed")
        self.assertEqual(runner.pause_historical_runner(self.session_id)["runner_state"]["mode"], "completed")

    def test_kill_switch_reset_never_resumes_work(self):
        self.transition("running")
        engaged = runner.set_runner_kill_switch(self.session_id, engaged=True, reason="Inspect")
        self.assertEqual((engaged["status"], engaged["runner_state"]["mode"]), ("paused", "paused"))
        reset = runner.set_runner_kill_switch(self.session_id, engaged=False)
        self.assertFalse(reset["runner_state"]["kill_switch_engaged"])
        self.assertEqual((reset["status"], reset["runner_state"]["mode"]), ("paused", "paused"))
        self.assertEqual(self.transition("running")["status"], "running")

    def test_event_failure_rolls_back_each_control_command(self):
        append = runner._append_paper_event_any

        def fail(event):
            append(event)
            raise RuntimeError("event interrupted")

        commands = (
            lambda: self.transition("running"),
            lambda: runner.start_historical_runner(self.session_id),
            lambda: runner.pause_historical_runner(self.session_id),
            lambda: self.transition("stopped"), lambda: self.transition("failed"),
            lambda: runner.set_runner_kill_switch(self.session_id, engaged=True),
        )
        for command in commands:
            before = self.snapshots()
            with patch.object(runner, "_append_paper_event_any", side_effect=fail):
                with self.assertRaisesRegex(RuntimeError, "event interrupted"):
                    command()
            self.assertEqual(self.snapshots(), before)

    def test_candidate_audit_failure_rolls_back_state_and_events(self):
        audit = runner._append_candidate_session_audit
        before = self.snapshots()

        def fail(*args, **kwargs):
            audit(*args, **kwargs)
            raise RuntimeError("audit interrupted")

        with patch.object(runner, "_append_candidate_session_audit", side_effect=fail):
            with self.assertRaisesRegex(RuntimeError, "audit interrupted"):
                self.transition("running")
        self.assertEqual(self.snapshots(), before)

    def test_cursor_reset_publishes_only_after_success(self):
        cached = [{"time": self.now}]
        runner._set_signal_history(self.session_id, cached)
        before = self.snapshots()
        with patch.object(runner, "_append_paper_event_any", side_effect=RuntimeError("event interrupted")):
            with self.assertRaises(RuntimeError):
                runner.start_historical_runner(self.session_id, reset_cursor=True)
        self.assertEqual(self.snapshots(), before)
        self.assertEqual(runner._signal_bar_history[self.session_id], cached)
        result = runner.start_historical_runner(self.session_id, reset_cursor=True)
        self.assertIsNone(result["last_bar_time"])
        self.assertEqual(result["runner_state"]["bars_processed"], 0)
        self.assertNotIn(self.session_id, runner._signal_bar_history)

    def test_bot_handoff_creates_an_inactive_session_until_explicit_start(self):
        candidate = candidate_service.get_candidate_any(self.candidate_id)
        candidate["candidate_id"] = "handoff-" + uuid.uuid4().hex
        candidate["experiment_run_id"] = "run-" + uuid.uuid4().hex
        candidate["lifecycle_status"] = "paper_running"
        candidate["paper_bot"]["status"] = "paper_running"
        candidate_service._save_candidate_any(candidate)
        result = sessions.create_paper_session_for_candidate(candidate["candidate_id"])
        self.assertEqual((result["status"], result["runner_state"]["mode"]), ("ready", "idle"))
        self.assertIsNone(result["last_bar_time"])

    def test_candidate_rejection_stops_session_and_survives_later_updates(self):
        before = self.transition("running")
        stale_candidate = candidate_service.get_candidate_any(self.candidate_id)
        rejected = self.reject_candidate()
        self.assertEqual(rejected["lifecycle_status"], "rejected")
        self.assertEqual(rejected["paper_bot"]["status"], "stopped")
        stopped = self.session()
        self.assertEqual((stopped["status"], stopped["runner_state"]["mode"]), ("stopped", "paused"))
        for key in ("current_position", "active_orders", "last_bar_time", "trade_log"):
            self.assertEqual(stopped[key], before[key])
        events = sessions.list_paper_events_any(self.session_id)
        self.assertEqual(events[-1]["payload"]["reason"], "candidate_rejected")
        self.assertEqual(events[-1]["actor"], "reviewer")
        self.reject_candidate()
        self.assertEqual(sessions.list_paper_events_any(self.session_id), events)

        with self.assertRaisesRegex(ValueError, "rejection changed"):
            candidate_service._save_candidate_any(stale_candidate)
        with self.assertRaisesRegex(ValueError, "rejected"):
            self.transition("ready")
        with self.assertRaisesRegex(ValueError, "rejected"):
            runner.start_historical_runner(self.session_id)
        runner.set_runner_kill_switch(self.session_id, engaged=True)
        self.assertEqual(candidate_service.get_candidate_any(self.candidate_id)["lifecycle_status"], "rejected")

    def test_rejection_rolls_back_when_session_audit_fails(self):
        self.transition("running")
        lease = leases.acquire_runner_lease(self.session_id, owner_id="worker") if db.db_configured() else None
        before = self.snapshots()
        with patch.object(runner, "_append_candidate_session_audit", side_effect=RuntimeError("audit interrupted")):
            with self.assertRaisesRegex(RuntimeError, "audit interrupted"):
                self.reject_candidate()
        self.assertEqual(self.snapshots(), before)
        if lease is not None:
            self.assertEqual(leases.get_runner_lease(self.session_id)["lease_token"], lease["lease_token"])


class MemoryPaperControlTests(_ControlCases, unittest.TestCase):
    def configure_storage(self):
        self.scope.enter_context(patch.dict(os.environ, {"DATABASE_URL": ""}))


@unittest.skipUnless(os.environ.get("PAPER_FENCING_TEST_DSN"), "requires isolated PAPER_FENCING_TEST_DSN")
class PostgresPaperControlTests(_ControlCases, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg2
        from psycopg2 import pool, sql

        cls.storage = ExitStack()
        cls.addClassCleanup(cls.storage.close)
        cls.dsn = os.environ["PAPER_FENCING_TEST_DSN"]
        cls.schema = "paper_controls_" + uuid.uuid4().hex
        with psycopg2.connect(cls.dsn) as connection:
            with connection.cursor() as cursor:
                cursor.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(cls.schema)))
        test_pool = pool.ThreadedConnectionPool(
            1, 8, dsn=cls.dsn,
            options=f"-csearch_path={cls.schema} -cstatement_timeout=5000 -clock_timeout=3000",
        )
        cls.storage.callback(test_pool.closeall)
        cls.storage.enter_context(patch.object(db, "_pool", test_pool))
        cls.storage.enter_context(patch.dict(os.environ, {"DATABASE_URL": cls.dsn}))
        for repo in (backtest_repo, candidate_repo, experiment_repo, paper_session_repo):
            cls.storage.enter_context(patch.object(repo, "_schema_ready", False))
        with db._conn() as connection:
            with connection.cursor() as cursor:
                cursor.execute("CREATE TABLE backtests (backtest_id TEXT PRIMARY KEY)")
            connection.commit()
            paper_session_repo._ensure_paper_sessions_schema(connection)

    def configure_storage(self):
        pass

    def test_candidate_rejection_interrupts_step_between_bar_commits(self):
        bars, fetch = self.mock_step_bars([0])
        transaction = runner._paper_control_transaction
        committed = Event()
        rejected = Event()

        @contextmanager
        def wait_for_rejection(session_id):
            with transaction(session_id):
                yield
            committed.set()
            if not rejected.wait(3):
                raise RuntimeError("test rejection timed out")

        with patch.object(runner, "_paper_control_transaction", side_effect=wait_for_rejection), ThreadPoolExecutor(1) as executor:
            step = executor.submit(runner.step_historical_runner, self.session_id, steps=2)
            try:
                self.assertTrue(committed.wait(2))
                self.assertEqual(self.session()["last_bar_time"], bars[0]["time"])
                self.reject_candidate()
            finally:
                rejected.set()
            with self.assertRaisesRegex(paper_session_repo.PaperSessionWriteConflict, "after 1 bar"):
                step.result(timeout=5)

        fetch.assert_called_once()
        stopped = self.session()
        self.assertEqual(stopped["status"], "stopped")
        self.assertEqual(stopped["runner_state"]["bars_processed"], 8)
        self.assertEqual(candidate_service.get_candidate_any(self.candidate_id)["lifecycle_status"], "rejected")

    def test_window_close_and_completion_roll_back_if_parity_query_fails(self):
        import psycopg2

        before = self.snapshots()
        with patch.object(runner, "get_next_ohlcv_bar", return_value=None):
            with patch.object(
                runner, "_load_backtest_any",
                side_effect=lambda _: db._read_sql("SELECT * FROM missing_parity_fixture"),
            ):
                with self.assertRaises(psycopg2.Error):
                    runner.step_historical_runner(self.session_id)
            self.assertEqual(self.snapshots(), before)
            completed = runner.step_historical_runner(self.session_id)

        self.assertEqual((completed["status"], completed["runner_state"]["mode"]), ("paused", "completed"))
        self.assertEqual(completed["current_position"], {})
        self.assertEqual(len(completed["trade_log"]), 1)
        events = sessions.list_paper_events_any(self.session_id)
        self.assertEqual([e["event_type"] for e in events], ["position_closed", "runner_completed", "runner_step"])
        self.assertEqual(events[-1]["payload"]["completed_steps"], 0)

    def test_claim_rechecks_runnable_intent_and_stop_revokes_ownership(self):
        self.assertIsNone(leases.acquire_runner_lease(self.session_id, owner_id="worker"))
        self.transition("running")
        self.assertIsNotNone(leases.acquire_runner_lease(self.session_id, owner_id="worker"))
        self.transition("stopped")
        self.assertIsNone(leases.get_runner_lease(self.session_id))
        # A worker that discovered the ID before the stop cannot claim it now.
        self.assertIsNone(leases.acquire_runner_lease(self.session_id, owner_id="stale-worker"))
        self.seed(status="running", mode="idle")
        self.assertIsNone(leases.acquire_runner_lease(self.session_id, owner_id="worker"))

    def test_pause_failure_restores_lease_with_all_other_state(self):
        self.transition("running")
        lease = leases.acquire_runner_lease(self.session_id, owner_id="worker")
        before = self.snapshots()
        with patch.object(runner, "_append_candidate_session_audit", side_effect=RuntimeError("audit interrupted")):
            with self.assertRaises(RuntimeError):
                runner.pause_historical_runner(self.session_id)
        self.assertEqual(self.snapshots(), before)
        self.assertEqual(leases.get_runner_lease(self.session_id)["lease_token"], lease["lease_token"])

    def test_rejected_candidate_has_no_runnable_session_or_lease(self):
        self.transition("running")
        lease = leases.acquire_runner_lease(self.session_id, owner_id="worker")
        self.assertIsNotNone(lease)
        self.reject_candidate()
        self.assertIsNone(leases.get_runner_lease(self.session_id))
        # A pre-upgrade session could still contain runnable intent.
        self.seed(status="running", mode="running")
        self.assertNotIn(self.session_id, leases.list_runnable_paper_session_ids())
        self.assertIsNone(leases.acquire_runner_lease(self.session_id, owner_id="stale-worker"))
        self.reject_candidate()
        self.assertEqual(self.session()["status"], "stopped")

    def test_rejection_serializes_with_first_session_creation(self):
        candidate = candidate_service.get_candidate_any(self.candidate_id)
        candidate["candidate_id"] = "handoff-" + uuid.uuid4().hex
        candidate["experiment_run_id"] = "run-" + uuid.uuid4().hex
        candidate_id = candidate["candidate_id"]
        candidate_service._save_candidate_any(candidate)
        append = sessions._append_paper_event_any
        created = Event()
        release = Event()

        def pause_create(event):
            append(event)
            created.set()
            if not release.wait(3):
                raise RuntimeError("test release timed out")

        with patch.object(sessions, "_append_paper_event_any", side_effect=pause_create), ThreadPoolExecutor(2) as executor:
            create = executor.submit(sessions.create_paper_session_for_candidate, candidate_id)
            try:
                self.assertTrue(created.wait(2))
                reject = executor.submit(candidate_service.update_candidate_status, candidate_id, "rejected")
                self.assertIsNone(sessions.get_paper_session_by_candidate_any(candidate_id))
            finally:
                release.set()
            create.result(timeout=5)
            reject.result(timeout=5)
        self.assertEqual(sessions.get_paper_session_by_candidate_any(candidate_id)["status"], "stopped")
        with self.assertRaisesRegex(ValueError, "Rejected candidates"):
            sessions.create_paper_session_for_candidate(candidate_id)

    def test_concurrent_start_and_stop_serialize_without_partial_publication(self):
        append = runner._append_paper_event_any
        tentative = Event()
        release = Event()
        before = self.snapshots()

        def pause_start(event):
            append(event)
            if event["event_type"] == "runner_started":
                tentative.set()
                if not release.wait(3):
                    raise RuntimeError("test release timed out")

        with patch.object(runner, "_session_lock", side_effect=lambda _: nullcontext()), patch.object(
            runner, "_append_paper_event_any", side_effect=pause_start
        ), ThreadPoolExecutor(max_workers=2) as executor:
            start = executor.submit(runner.start_historical_runner, self.session_id)
            try:
                self.assertTrue(tentative.wait(2))
                self.assertEqual(self.snapshots(), before)
                stop = executor.submit(self.transition, "stopped")
                self.assertFalse(stop.done())
            finally:
                release.set()
            start.result(timeout=5)
            stop.result(timeout=5)
        result = self.session()
        self.assertEqual((result["status"], result["runner_state"]["mode"]), ("stopped", "paused"))
        self.assertIsNone(leases.get_runner_lease(self.session_id))
        self.assertEqual(len(sessions.list_paper_events_any(self.session_id)), 2)
        self.assertEqual(candidate_service.get_candidate_any(self.candidate_id)["lifecycle_status"], "paper_paused")


class PaperControlCacheTests(unittest.TestCase):
    def test_worker_discards_future_history_after_another_process_resets_cursor(self):
        session = {"paper_session_id": "cache-reset", "last_bar_time": None}
        self.addCleanup(runner._reset_signal_history, session["paper_session_id"])
        runner._set_signal_history(session["paper_session_id"], [{"time": "2024-01-03T00:00:00+00:00"}])
        self.assertEqual(runner._get_signal_history(session, {}), [])

    def test_worker_rebuilds_cache_when_durable_cursor_has_moved(self):
        session = {
            "paper_session_id": "cache-moved", "symbol": "ES", "interval": "1min",
            "last_bar_time": "2024-01-02T00:00:00+00:00",
        }
        self.addCleanup(runner._reset_signal_history, session["paper_session_id"])
        runner._set_signal_history(session["paper_session_id"], [{"time": "2024-01-03T00:00:00+00:00"}])
        frame = pd.DataFrame(
            [{"open": 100, "high": 101, "low": 99, "close": 100, "volume": 1}],
            index=pd.to_datetime([session["last_bar_time"]]),
        )
        with patch.object(runner, "get_ohlcv", return_value=frame) as fetch:
            rebuilt = runner._get_signal_history(session, {"start_date": "2024-01-01"})
            self.assertEqual(rebuilt[-1]["time"], session["last_bar_time"])
            fetch.assert_called_once_with(symbol="ES", interval="1min", start_date="2024-01-01", end_date=session["last_bar_time"])
        with patch.object(runner, "get_ohlcv", side_effect=AssertionError("cache should be reusable")):
            self.assertEqual(runner._get_signal_history(session, {}), rebuilt)

if __name__ == "__main__":
    unittest.main()
