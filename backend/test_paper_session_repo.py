import json
import unittest
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

from services import paper_session_repo


class PaperSessionRepoTests(unittest.TestCase):
    def test_save_paper_session_keeps_columns_and_values_aligned(self):
        session = {
            "paper_session_id": "paper-1",
            "candidate_id": "candidate-1",
            "paper_bot_id": "bot-1",
            "name": "Phase 3C fixture",
            "symbol": "NQ",
            "interval": "5m",
            "strategy_type": "ema_crossover",
            "strategy_params": {"fast_period": 9, "slow_period": 21},
            "prop_firm_rules": {"account_size": 100_000},
            "guardrails": {},
            "status": "ready",
            "current_position": {},
            "active_order": {"order_id": "legacy-order"},
            "last_quote": {"mid": 20_000},
            "trade_log": [],
            "equity_curve": [100_000],
            "active_orders": [{"order_id": "order-1"}],
            "metrics_snapshot": {},
            "guardrail_state": {},
            "runner_state": {"policy_mode": "approval_required"},
            "created_at": "2026-07-18T00:00:00+00:00",
            "updated_at": "2026-07-18T00:00:00+00:00",
        }
        cursor = MagicMock()
        connection = MagicMock()
        connection.cursor.return_value.__enter__.return_value = cursor

        @contextmanager
        def fake_conn():
            yield connection

        with patch("services.db._conn", fake_conn), patch.object(
            paper_session_repo, "_ensure_paper_sessions_schema"
        ):
            paper_session_repo.save_paper_session(session)

        sql, values = cursor.execute.call_args.args
        self.assertEqual(sql.count("%s"), len(values))
        self.assertEqual(json.loads(values[20]), session["last_quote"])
        self.assertEqual(json.loads(values[23]), session["active_orders"])
        self.assertEqual(json.loads(values[26]), session["runner_state"])


if __name__ == "__main__":
    unittest.main()
