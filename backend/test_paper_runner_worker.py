import unittest
from unittest.mock import patch

from services import paper_runner_service, paper_runner_worker


class DurablePaperRunnerWorkerTests(unittest.TestCase):
    def test_worker_claims_heartbeats_and_advances_one_due_session(self):
        clock = _Clock()
        worker = paper_runner_worker.DurablePaperRunnerWorker(
            owner_id="worker-a",
            monotonic=clock,
        )
        lease = {
            "paper_session_id": "paper-1",
            "owner_id": "worker-a",
            "lease_token": "lease-a",
        }
        session = {"runner_state": {"poll_interval_ms": 750}}

        with patch.object(
            paper_runner_worker,
            "list_runnable_paper_session_ids",
            return_value=["paper-1"],
        ), patch.object(
            paper_runner_worker,
            "acquire_runner_lease",
            return_value=lease,
        ) as acquire, patch.object(
            paper_runner_worker,
            "heartbeat_runner_lease",
            return_value=lease,
        ) as heartbeat, patch.object(
            paper_runner_worker,
            "advance_historical_runner_worker_once",
            return_value=(session, "stepped"),
        ) as advance:
            self.assertEqual(worker.run_once(), 1)
            self.assertEqual(worker.run_once(), 0)

        acquire.assert_called_once()
        heartbeat.assert_called_once()
        advance.assert_called_once_with(
            "paper-1",
            owner_id="worker-a",
            lease_token="lease-a",
        )

    def test_second_worker_cannot_advance_a_session_owned_elsewhere(self):
        worker = paper_runner_worker.DurablePaperRunnerWorker(owner_id="worker-b")
        with patch.object(
            paper_runner_worker,
            "list_runnable_paper_session_ids",
            return_value=["paper-1"],
        ), patch.object(
            paper_runner_worker,
            "acquire_runner_lease",
            return_value=None,
        ) as acquire, patch.object(
            paper_runner_worker,
            "advance_historical_runner_worker_once",
        ) as advance:
            self.assertEqual(worker.run_once(), 0)

        acquire.assert_called_once_with(
            "paper-1",
            owner_id="worker-b",
            ttl_seconds=30,
        )
        advance.assert_not_called()

    def test_lost_heartbeat_drops_ownership_without_advancing(self):
        worker = paper_runner_worker.DurablePaperRunnerWorker(owner_id="worker-a")
        worker._owned["paper-1"] = paper_runner_worker._OwnedRunnerLease(
            lease_token="lease-a",
            next_advance_at=0,
            next_heartbeat_at=0,
        )
        with patch.object(
            paper_runner_worker,
            "list_runnable_paper_session_ids",
            return_value=["paper-1"],
        ), patch.object(
            paper_runner_worker,
            "heartbeat_runner_lease",
            return_value=None,
        ), patch.object(
            paper_runner_worker,
            "advance_historical_runner_worker_once",
        ) as advance:
            self.assertEqual(worker.run_once(), 0)

        self.assertNotIn("paper-1", worker._owned)

    def test_long_bar_poll_keeps_heartbeating_before_the_next_advance(self):
        clock = _Clock()
        worker = paper_runner_worker.DurablePaperRunnerWorker(
            owner_id="worker-a",
            monotonic=clock,
        )
        lease = {
            "paper_session_id": "paper-1",
            "owner_id": "worker-a",
            "lease_token": "lease-a",
        }
        session = {"runner_state": {"poll_interval_ms": 60_000}}
        with patch.object(
            paper_runner_worker,
            "list_runnable_paper_session_ids",
            return_value=["paper-1"],
        ), patch.object(
            paper_runner_worker,
            "acquire_runner_lease",
            return_value=lease,
        ), patch.object(
            paper_runner_worker,
            "heartbeat_runner_lease",
            return_value=lease,
        ) as heartbeat, patch.object(
            paper_runner_worker,
            "advance_historical_runner_worker_once",
            return_value=(session, "stepped"),
        ) as advance:
            self.assertEqual(worker.run_once(), 1)
            clock.value += 11
            self.assertEqual(worker.run_once(), 0)

        self.assertEqual(heartbeat.call_count, 2)
        advance.assert_called_once()


class LeaseGuardedAdvanceTests(unittest.TestCase):
    def test_worker_advance_rejects_the_wrong_owner(self):
        with patch.object(
            paper_runner_service,
            "get_runner_lease",
            return_value={
                "paper_session_id": "paper-1",
                "owner_id": "worker-a",
                "lease_token": "lease-a",
                "active": True,
            },
        ), patch.object(paper_runner_service, "_advance_one_bar_locked") as advance:
            with self.assertRaisesRegex(RuntimeError, "another worker"):
                paper_runner_service.advance_historical_runner_worker_once(
                    "paper-1",
                    owner_id="worker-b",
                    lease_token="lease-b",
                )

        advance.assert_not_called()

    def test_worker_advance_stops_when_session_was_paused_after_claim(self):
        paused = {
            "paper_session_id": "paper-1",
            "status": "paused",
            "runner_state": {"mode": "paused"},
        }
        with patch.object(
            paper_runner_service,
            "get_runner_lease",
            return_value={
                "paper_session_id": "paper-1",
                "owner_id": "worker-a",
                "lease_token": "lease-a",
                "active": True,
            },
        ), patch.object(
            paper_runner_service,
            "_require_paper_session",
            return_value=paused,
        ), patch.object(
            paper_runner_service,
            "_ensure_session_defaults",
            side_effect=lambda session: session,
        ), patch.object(paper_runner_service, "_advance_one_bar_locked") as advance:
            session, outcome = paper_runner_service.advance_historical_runner_worker_once(
                "paper-1",
                owner_id="worker-a",
                lease_token="lease-a",
            )

        self.assertEqual(session, paused)
        self.assertEqual(outcome, "not_running")
        advance.assert_not_called()

    def test_terminal_session_releases_its_lease(self):
        worker = paper_runner_worker.DurablePaperRunnerWorker(owner_id="worker-a")
        lease = {
            "paper_session_id": "paper-1",
            "owner_id": "worker-a",
            "lease_token": "lease-a",
        }
        with patch.object(
            paper_runner_worker,
            "list_runnable_paper_session_ids",
            return_value=["paper-1"],
        ), patch.object(
            paper_runner_worker,
            "acquire_runner_lease",
            return_value=lease,
        ), patch.object(
            paper_runner_worker,
            "heartbeat_runner_lease",
            return_value=lease,
        ), patch.object(
            paper_runner_worker,
            "advance_historical_runner_worker_once",
            return_value=({"runner_state": {"mode": "completed"}}, "window_exhausted"),
        ), patch.object(
            paper_runner_worker,
            "release_runner_lease",
            return_value=True,
        ) as release:
            self.assertEqual(worker.run_once(), 0)

        release.assert_called_once_with(
            "paper-1",
            owner_id="worker-a",
            lease_token="lease-a",
        )
        self.assertNotIn("paper-1", worker._owned)


class _Clock:
    def __init__(self) -> None:
        self.value = 100.0

    def __call__(self) -> float:
        return self.value


if __name__ == "__main__":
    unittest.main()
