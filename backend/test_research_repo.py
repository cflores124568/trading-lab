import unittest
from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from services import research_repo


def _trial_row(status="failed"):
    now = datetime.now(timezone.utc)
    return {
        "trial_id": f"trial-{status}",
        "campaign_id": "campaign-1",
        "fingerprint": f"fingerprint-{status}",
        "strategy_type": "ema_crossover",
        "strategy_params": {"fast": 9},
        "execution_config": {},
        "random_seed": 0,
        "status": status,
        "result": {"total_pnl": 10} if status == "completed" else None,
        "error": "kept failure" if status == "failed" else None,
        "created_by": "test",
        "created_at": now,
        "completed_at": now,
    }


class ResearchRepoTests(unittest.TestCase):
    def test_duplicate_fingerprint_returns_existing_row_without_audit_append(self):
        cursor = MagicMock()
        cursor.fetchone.side_effect = [None, _trial_row()]
        connection = MagicMock()
        connection.cursor.return_value.__enter__.return_value = cursor

        @contextmanager
        def fake_conn():
            yield connection

        trial = _trial_row()
        event = {
            "research_campaign_event_id": "event-1",
            "campaign_id": "campaign-1",
            "event_type": "trial_recorded",
            "actor": "test",
            "summary": "should not append",
            "payload": {},
            "created_at": trial["created_at"],
        }
        with patch("services.db._conn", fake_conn), patch.object(research_repo, "_ensure_research_schema"):
            result, created = research_repo.create_research_trial(trial, event)

        self.assertFalse(created)
        self.assertTrue(result["was_duplicate"])
        self.assertEqual(result["trial_id"], "trial-failed")
        self.assertEqual(cursor.execute.call_count, 2)

    def test_failed_trials_remain_visible_in_bounded_listing(self):
        cursor = MagicMock()
        cursor.fetchall.return_value = [_trial_row("completed"), _trial_row("failed")]
        connection = MagicMock()
        connection.cursor.return_value.__enter__.return_value = cursor

        @contextmanager
        def fake_conn():
            yield connection

        with patch("services.db._conn", fake_conn), patch.object(research_repo, "_ensure_research_schema"):
            rows = research_repo.list_research_trials("campaign-1", limit=50, offset=0)

        self.assertEqual([row["status"] for row in rows], ["completed", "failed"])
        self.assertEqual(rows[1]["error"], "kept failure")

    def test_audit_schema_rejects_update_and_delete(self):
        self.assertIn("BEFORE UPDATE OR DELETE ON research_campaign_events", research_repo._RESEARCH_SCHEMA_SQL)
        self.assertIn("audit events are append-only", research_repo._RESEARCH_SCHEMA_SQL)


if __name__ == "__main__":
    unittest.main()
