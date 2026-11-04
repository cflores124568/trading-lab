"""Database transaction and memory-publication boundaries."""

import unittest
import uuid
from unittest.mock import MagicMock, patch

from services import db, paper_session_store


class DatabaseTransactionTests(unittest.TestCase):
    def setUp(self):
        self.connection = MagicMock()
        self.pool = MagicMock()
        self.pool.getconn.return_value = self.connection
        self.pool_patch = patch.object(db, "_pool", self.pool)
        self.pool_patch.start()
        self.addCleanup(self.pool_patch.stop)

    def test_nested_repository_commits_and_memory_publish_wait_for_outer_commit(self):
        publish = MagicMock()
        with db.transaction():
            with db._conn() as nested:
                nested.cursor().execute("tentative write")
                nested.commit()
            db.after_commit(publish)
            self.connection.commit.assert_not_called()
            publish.assert_not_called()
        self.connection.commit.assert_called_once()
        self.connection.rollback.assert_not_called()
        publish.assert_called_once()
        self.pool.getconn.assert_called_once()

    def test_rollback_discards_memory_publish_and_restores_connection_scope(self):
        publish = MagicMock()
        with self.assertRaisesRegex(RuntimeError, "lost lease"):
            with db.transaction():
                db.after_commit(publish)
                raise RuntimeError("lost lease")
        self.connection.rollback.assert_called_once()
        self.connection.commit.assert_not_called()
        publish.assert_not_called()
        self.assertIsNone(db._transaction.get())
        db.after_commit(publish)
        publish.assert_called_once()

    def test_commit_failure_discards_memory_publish(self):
        self.connection.commit.side_effect = RuntimeError("commit failed")
        publish = MagicMock()
        with self.assertRaisesRegex(RuntimeError, "commit failed"):
            with db.transaction():
                db.after_commit(publish)
        self.connection.rollback.assert_called_once()
        publish.assert_not_called()
        self.assertIsNone(db._transaction.get())

    def test_delayed_memory_publication_cannot_replace_a_newer_committed_version(self):
        session_id = "mirror-" + uuid.uuid4().hex
        old = {"paper_session_id": session_id, "_state_version": 1, "status": "running"}
        newer = {**old, "_state_version": 2, "status": "paused"}
        with db.transaction():
            db.after_commit(lambda: paper_session_store.upsert_paper_session(session_id, old))
            paper_session_store.upsert_paper_session(session_id, newer)
        self.assertEqual(paper_session_store.get_paper_session(session_id)["status"], "paused")


if __name__ == "__main__":
    unittest.main()
