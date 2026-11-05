"""Worker commit fencing. PostgreSQL cases require an explicitly isolated DSN.

PAPER_FENCING_TEST_DSN never defaults to the application's DATABASE_URL.
Integration cases create a unique schema and leave existing schemas untouched.
"""

import os
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, nullcontext
from copy import deepcopy
from unittest.mock import patch

from services import (
    backtest_repo,
    candidate_repo,
    candidate_service,
    candidate_store,
    db,
    experiment_repo,
    paper_runner_lease_repo,
    paper_runner_service,
    paper_session_repo,
    paper_session_service,
    paper_session_store,
)
from services.paper_session_repo import PaperSessionWriteConflict, RunnerLeaseLost


@unittest.skipUnless(os.environ.get("PAPER_FENCING_TEST_DSN"), "requires isolated PAPER_FENCING_TEST_DSN")
class PaperRunnerPostgresFencingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg2
        from psycopg2 import pool, sql

        cls.scope = ExitStack()
        cls.addClassCleanup(cls.scope.close)
        dsn = os.environ["PAPER_FENCING_TEST_DSN"]
        cls.schema = "paper_fencing_" + uuid.uuid4().hex
        with psycopg2.connect(dsn) as connection:
            with connection.cursor() as cursor:
                cursor.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(cls.schema)))
        test_pool = pool.ThreadedConnectionPool(
            1, 8, dsn=dsn,
            options=f"-csearch_path={cls.schema} -cstatement_timeout=5000 -clock_timeout=3000",
        )
        cls.scope.callback(test_pool.closeall)
        cls.scope.enter_context(patch.object(db, "_pool", test_pool))
        cls.scope.enter_context(patch.dict(os.environ, {"DATABASE_URL": dsn}))
        for repo in (backtest_repo, candidate_repo, experiment_repo, paper_session_repo):
            cls.scope.enter_context(patch.object(repo, "_schema_ready", False))
        with db._conn() as connection:
            with connection.cursor() as cursor:
                # The paper tests need no Timescale extension or market data.
                cursor.execute("CREATE TABLE backtests (backtest_id TEXT PRIMARY KEY)")
            connection.commit()
            paper_session_repo._ensure_paper_sessions_schema(connection)
            backtest_repo._ensure_backtests_schema(connection)

    def setUp(self):
        suffix = uuid.uuid4().hex
        self.session_id = "paper-" + suffix
        self.candidate_id = "candidate-" + suffix
        self.now = "2024-01-02T09:30:00+00:00"
        self.candidate = {
            "candidate_id": self.candidate_id,
            "experiment_id": "experiment-" + suffix,
            "experiment_name": "Fencing fixture",
            "experiment_run_id": "run-" + suffix,
            "backtest_id": "backtest-" + suffix,
            "symbol": "ES", "interval": "1min", "strategy_type": "ma_crossover",
            "lifecycle_status": "paper_running", "promotion_reason": "Fencing test",
            "paper_bot": {"status": "paper_running"},
            "promoted_at": self.now, "created_at": self.now, "updated_at": self.now,
        }
        candidate_service._save_candidate_any(self.candidate)
        self.session = {
            "paper_session_id": self.session_id, "candidate_id": self.candidate_id,
            "name": "Fencing fixture", "symbol": "ES", "interval": "1min",
            "strategy_type": "ma_crossover", "strategy_params": {},
            "prop_firm_rules": {
                "name": "Fencing rules", "account_size": 100_000,
                "daily_loss_limit": 0.05, "max_drawdown": 0.1,
                "profit_target": 0.1, "consistency_rule": False,
            },
            "guardrails": {}, "status": "running", "current_position": {},
            "equity_curve": [100_000],
            "runner_state": {
                "mode": "running", "policy_mode": "shadow",
                "start_date": self.now, "end_date": "2024-01-02T16:00:00+00:00",
            },
            "created_at": self.now, "updated_at": self.now,
        }
        paper_session_service._save_paper_session_any(self.session)
        lease = paper_runner_lease_repo.acquire_runner_lease(self.session_id, owner_id="worker-a")
        self.token = lease["lease_token"]
        self.bar = {
            "time": self.now, "open": 100.0, "high": 101.0, "low": 99.0,
            "close": 100.0, "volume": 10.0,
        }
        self.addCleanup(paper_runner_service._reset_signal_history, self.session_id)

    def outside_transaction(self, work):
        # A separate context/connection models a different API or worker process.
        with ThreadPoolExecutor(max_workers=1) as executor:
            return executor.submit(work).result(timeout=6)

    def expire_lease(self):
        with db._conn() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE paper_runner_leases SET expires_at = clock_timestamp() - INTERVAL '1 millisecond' WHERE paper_session_id = %s",
                    [self.session_id],
                )
            connection.commit()

    def advance(self, signal=None, next_bar=None):
        with patch.object(paper_runner_service, "get_next_ohlcv_bar", side_effect=next_bar or (lambda **kwargs: self.bar)), patch.object(
            paper_runner_service, "_compute_strategy_signal", side_effect=signal or (lambda *args: 1)
        ), patch.object(paper_runner_service, "_session_lock", side_effect=lambda _: nullcontext()):
            return paper_runner_service.advance_historical_runner_worker_once(
                self.session_id, owner_id="worker-a", lease_token=self.token
            )

    def assert_no_bar_committed(self):
        current = paper_session_repo.get_paper_session(self.session_id)
        self.assertIsNone(current["last_bar_time"])
        self.assertEqual(current["runner_state"].get("bars_processed", 0), 0)
        self.assertNotIn(self.session_id, paper_runner_service._signal_bar_history)
        return current

    def test_successful_bar_publishes_session_and_event_only_after_commit(self):
        def signal(*args):
            independent = self.outside_transaction(lambda: paper_session_repo.get_paper_session(self.session_id))
            self.assertIsNone(independent["last_bar_time"])
            self.assertIsNone(paper_session_store.get_paper_session(self.session_id).get("last_bar_time"))
            return 1

        session, outcome = self.advance(signal=signal)
        self.assertEqual(outcome, "stepped")
        self.assertEqual(session["runner_state"]["bars_processed"], 1)
        self.assertEqual(len(paper_session_repo.list_paper_events(self.session_id)), 1)
        self.assertEqual(len(paper_session_store.list_paper_events(self.session_id)), 1)
        self.assertIsNotNone(paper_session_store.get_paper_session(self.session_id)["last_bar_time"])

    def test_pause_after_worker_read_rejects_stale_bar(self):
        def next_bar(**kwargs):
            self.outside_transaction(lambda: paper_runner_service.pause_historical_runner(self.session_id))
            return self.bar

        with self.assertRaises(PaperSessionWriteConflict):
            self.advance(next_bar=next_bar)
        current = self.assert_no_bar_committed()
        self.assertEqual(current["status"], "paused")
        self.assertEqual(current["runner_state"]["mode"], "paused")
        self.assertEqual([e["event_type"] for e in paper_session_repo.list_paper_events(self.session_id)], ["runner_paused"])

    def test_kill_switch_after_worker_read_remains_engaged(self):
        def next_bar(**kwargs):
            self.outside_transaction(lambda: paper_runner_service.set_runner_kill_switch(self.session_id, engaged=True))
            return self.bar

        with self.assertRaises(PaperSessionWriteConflict):
            self.advance(next_bar=next_bar)
        current = self.assert_no_bar_committed()
        self.assertTrue(current["runner_state"]["kill_switch_engaged"])
        self.assertEqual(current["status"], "paused")
        self.assertEqual([e["event_type"] for e in paper_session_repo.list_paper_events(self.session_id)], ["kill_switch_engaged"])

    def test_version_conflict_rejects_even_while_worker_lease_is_unchanged(self):
        def update_quote():
            session = paper_session_repo.get_paper_session(self.session_id)
            session["last_quote"] = {"reference": 123.0}
            paper_session_service._save_paper_session_any(session)

        def next_bar(**kwargs):
            self.outside_transaction(update_quote)
            return self.bar

        with self.assertRaises(PaperSessionWriteConflict):
            self.advance(next_bar=next_bar)
        current = self.assert_no_bar_committed()
        self.assertEqual(current["last_quote"], {"reference": 123.0})
        self.assertEqual(paper_runner_lease_repo.get_runner_lease(self.session_id)["lease_token"], self.token)
        self.assertEqual(paper_session_repo.list_paper_events(self.session_id), [])

    def test_takeover_rolls_back_tentative_session_events_and_memory(self):
        with ThreadPoolExecutor(max_workers=1) as executor:
            takeover = None

            def signal(*args):
                nonlocal takeover
                self.outside_transaction(self.expire_lease)
                # Claims now lock the session too. The replacement owner
                # waits for the expired worker's tentative bar to roll back.
                takeover = executor.submit(
                    paper_runner_lease_repo.acquire_runner_lease,
                    self.session_id, owner_id="worker-b",
                )
                return 1

            with self.assertRaises(RunnerLeaseLost):
                self.advance(signal=signal)
            lease = takeover.result(timeout=5)
        self.assertNotEqual(lease["lease_token"], self.token)
        current = self.assert_no_bar_committed()
        self.assertEqual(current["status"], "running")
        self.assertEqual(paper_session_repo.list_paper_events(self.session_id), [])
        self.assertEqual(paper_session_store.list_paper_events(self.session_id), [])
        self.assertIsNone(paper_session_store.get_paper_session(self.session_id).get("last_bar_time"))
        self.assertEqual(paper_runner_lease_repo.get_runner_lease(self.session_id)["owner_id"], "worker-b")

    def test_expiry_uses_wall_clock_rather_than_transaction_start(self):
        def signal(*args):
            with db._conn() as connection:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT pg_sleep(0.02)")
            self.outside_transaction(self.expire_lease)
            with db._conn() as connection:
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT expires_at > transaction_timestamp(), expires_at > clock_timestamp() FROM paper_runner_leases WHERE paper_session_id = %s",
                        [self.session_id],
                    )
                    self.assertEqual(cursor.fetchone(), (True, False))
            return 1

        with self.assertRaises(RunnerLeaseLost):
            self.advance(signal=signal)
        self.assert_no_bar_committed()
        self.assertEqual(paper_session_repo.list_paper_events(self.session_id), [])

    def test_revocation_after_execution_began_rolls_back_bar(self):
        def signal(*args):
            self.outside_transaction(lambda: paper_runner_lease_repo.revoke_runner_lease(self.session_id))
            return 1

        with self.assertRaises(RunnerLeaseLost):
            self.advance(signal=signal)
        self.assert_no_bar_committed()
        self.assertEqual(paper_session_repo.list_paper_events(self.session_id), [])

    def test_lease_loss_after_taker_fill_rolls_back_position_and_execution_events(self):
        self.session["runner_state"]["policy_mode"] = "autonomous_paper"
        paper_session_service._save_paper_session_any(self.session)
        execute = paper_runner_service.execute_paper_session_action

        def execute_then_revoke(*args, **kwargs):
            result = execute(*args, **kwargs)
            self.assertEqual(result["current_position"]["side"], "buy")
            self.outside_transaction(lambda: paper_runner_lease_repo.revoke_runner_lease(self.session_id))
            return result

        with patch.object(paper_runner_service, "execute_paper_session_action", side_effect=execute_then_revoke):
            with self.assertRaises(RunnerLeaseLost):
                self.advance()
        current = self.assert_no_bar_committed()
        self.assertEqual(current["current_position"], {})
        self.assertEqual(current["trade_log"], [])
        self.assertEqual(current["equity_curve"], [100_000])
        self.assertEqual(paper_session_repo.list_paper_events(self.session_id), [])
        self.assertEqual(paper_session_store.get_paper_session(self.session_id)["current_position"], {})
        self.assertEqual(paper_session_store.list_paper_events(self.session_id), [])

    def test_current_owner_can_commit_taker_fill_and_policy_event(self):
        self.session["runner_state"]["policy_mode"] = "autonomous_paper"
        paper_session_service._save_paper_session_any(self.session)
        session, outcome = self.advance()
        self.assertEqual(outcome, "stepped")
        self.assertEqual(session["current_position"]["side"], "buy")
        self.assertEqual(session["runner_state"]["last_decision"]["status"], "executed")
        self.assertEqual(
            [event["event_type"] for event in paper_session_repo.list_paper_events(self.session_id)],
            ["position_opened", "policy_decision"],
        )
        self.assertEqual(paper_session_store.get_paper_session(self.session_id)["current_position"]["side"], "buy")

    def test_failed_bar_is_rolled_back_before_fenced_failure_marker(self):
        def signal(*args):
            raise ValueError("strategy failed")

        session, outcome = self.advance(signal=signal)
        self.assertEqual(outcome, "failed")
        self.assertEqual(session["status"], "failed")
        self.assert_no_bar_committed()
        events = paper_session_repo.list_paper_events(self.session_id)
        self.assertEqual([event["event_type"] for event in events], ["runner_failed"])

    def test_failure_handler_cannot_overwrite_a_later_kill_switch(self):
        original = paper_runner_service._mark_runner_failed_locked

        def fail(session_id, message):
            self.outside_transaction(lambda: paper_runner_service.set_runner_kill_switch(session_id, engaged=True))
            original(session_id, message)

        def signal(*args):
            raise ValueError("strategy failed")

        with patch.object(paper_runner_service, "_mark_runner_failed_locked", side_effect=fail):
            with self.assertRaises(PaperSessionWriteConflict):
                self.advance(signal=signal)
        current = self.assert_no_bar_committed()
        self.assertTrue(current["runner_state"]["kill_switch_engaged"])
        self.assertEqual(current["status"], "paused")
        self.assertEqual([e["event_type"] for e in paper_session_repo.list_paper_events(self.session_id)], ["kill_switch_engaged"])

    def test_rejected_completion_rolls_back_candidate_projection_and_audit(self):
        def parity(*args, **kwargs):
            self.outside_transaction(lambda: paper_runner_lease_repo.revoke_runner_lease(self.session_id))
            return {"status": "parity_unavailable"}

        before = deepcopy(candidate_repo.get_candidate(self.candidate_id))
        with patch.object(paper_runner_service, "_build_runner_parity_check", side_effect=parity):
            with self.assertRaises(RunnerLeaseLost):
                self.advance(next_bar=lambda **kwargs: None)
        self.assert_no_bar_committed()
        self.assertEqual(candidate_repo.get_candidate(self.candidate_id), before)
        self.assertEqual(candidate_store.get_candidate(self.candidate_id)["lifecycle_status"], "paper_running")
        self.assertEqual(paper_session_repo.list_paper_events(self.session_id), [])

    def test_unfenced_stale_api_snapshot_is_rejected(self):
        stale = paper_session_repo.get_paper_session(self.session_id)
        newer = deepcopy(stale)
        newer["runner_state"]["kill_switch_engaged"] = True
        paper_session_repo.save_paper_session(newer)
        stale["last_bar_time"] = self.now
        with self.assertRaises(PaperSessionWriteConflict):
            paper_session_repo.save_paper_session(stale)
        current = paper_session_repo.get_paper_session(self.session_id)
        self.assertTrue(current["runner_state"]["kill_switch_engaged"])
        self.assertIsNone(current["last_bar_time"])


if __name__ == "__main__":
    unittest.main()
