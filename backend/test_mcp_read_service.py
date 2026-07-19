import unittest
from unittest.mock import patch

from services import mcp_read_service


class MCPReadServiceTests(unittest.TestCase):
    def test_candidate_list_is_filtered_bounded_and_compact(self):
        candidates = [
            {
                "candidate_id": "approved",
                "symbol": "NQ",
                "interval": "5m",
                "strategy_type": "ema_crossover",
                "lifecycle_status": "approved",
                "score": 9.5,
                "notes": [{"body": "not included"}],
                "audit_log": [{"summary": "not included"}],
            },
            {
                "candidate_id": "rejected",
                "lifecycle_status": "rejected",
            },
        ]
        with patch.object(mcp_read_service, "list_candidates_any", return_value=candidates):
            result = mcp_read_service.list_candidate_snapshots("approved", limit=1)

        self.assertEqual(result["count"], 1)
        self.assertEqual(result["items"][0]["candidate_id"], "approved")
        self.assertNotIn("notes", result["items"][0])
        self.assertNotIn("audit_log", result["items"][0])

    def test_paper_snapshot_exposes_safety_state_without_full_equity_curve(self):
        session = {
            "paper_session_id": "paper-1",
            "candidate_id": "candidate-1",
            "name": "Paper one",
            "status": "paused",
            "trade_log": [{"trade_id": index} for index in range(12)],
            "equity_curve": list(range(500)),
            "runner_state": {
                "mode": "paused",
                "policy_mode": "approval_required",
                "pending_decision": {"decision_id": "decision-1"},
                "shadow_scorecard": {"total_decisions": 71},
                "market_event_cursor": {"last_sequence": 42, "data_quality": "good"},
                "last_market_trade": {"price": 20000.0, "size": 2.0},
                "kill_switch_engaged": True,
            },
        }
        with patch.object(mcp_read_service, "get_paper_session_any", return_value=session):
            result = mcp_read_service.get_paper_session_snapshot("paper-1")

        self.assertNotIn("equity_curve", result)
        self.assertEqual(result["runner"]["pending_decision"]["decision_id"], "decision-1")
        self.assertTrue(result["runner"]["kill_switch_engaged"])
        self.assertEqual(result["runner"]["shadow_scorecard"]["total_decisions"], 71)
        self.assertEqual(result["runner"]["market_event_cursor"]["last_sequence"], 42)
        self.assertEqual(result["runner"]["last_market_trade"]["price"], 20000.0)
        self.assertEqual(result["execution"]["closed_trade_count"], 12)
        self.assertEqual(len(result["execution"]["recent_closed_trades"]), 10)

    def test_policy_decisions_are_newest_first_and_skip_unrelated_events(self):
        events = [
            {
                "paper_event_id": "old",
                "event_type": "policy_decision",
                "payload": {"decision": {"decision_id": "decision-old"}},
            },
            {"paper_event_id": "mark", "event_type": "position_marked", "payload": {}},
            {
                "paper_event_id": "new",
                "event_type": "policy_decision_resolved",
                "payload": {"approved": False, "decision": {"decision_id": "decision-new"}},
            },
        ]
        with (
            patch.object(mcp_read_service, "get_paper_session_any", return_value={"paper_session_id": "paper-1"}),
            patch.object(mcp_read_service, "list_paper_events_any", return_value=events),
        ):
            result = mcp_read_service.list_policy_decision_snapshots("paper-1")

        self.assertEqual([item["paper_event_id"] for item in result["items"]], ["new", "old"])
        self.assertFalse(result["items"][0]["approved"])

    def test_reads_raise_for_unknown_ids_and_invalid_limits(self):
        with patch.object(mcp_read_service, "get_candidate_any", return_value=None):
            with self.assertRaises(LookupError):
                mcp_read_service.get_candidate_snapshot("missing")
        with self.assertRaises(ValueError):
            mcp_read_service.list_candidate_snapshots(limit=0)
        with self.assertRaises(ValueError):
            mcp_read_service.list_paper_session_snapshots(limit=101)


if __name__ == "__main__":
    unittest.main()
