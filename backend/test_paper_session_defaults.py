#!/usr/bin/env python3

import os
import sys
import types
import unittest
from unittest.mock import patch


def _install_fastapi_stub() -> None:
    """Stub `fastapi.HTTPException` so this stays easy to run locally.

    I only need service imports to work here. Pulling the whole API stack into
    this tiny unit test would be overkill and just makes the loop slower.
    """
    if "fastapi" in sys.modules:
        return

    fastapi = types.ModuleType("fastapi")

    class HTTPException(Exception):
        def __init__(self, status_code=None, detail=None):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

    fastapi.HTTPException = HTTPException
    sys.modules["fastapi"] = fastapi


_install_fastapi_stub()
sys.path.insert(0, os.path.dirname(__file__))

import services.paper_session_service as paper_session_service


class PaperSessionDefaultTests(unittest.TestCase):
    def test_new_paper_sessions_boot_with_symbol_execution_defaults(self):
        """New sessions should inherit the smarter Phase 2 execution knobs.

        This is only for fresh paper sessions. Older saved sessions keep their
        old one-tick behavior unless they already persisted the newer fields.
        """
        candidate = {
            "candidate_id": "cand-1",
            "symbol": "NQ_c_0",
            "interval": "1min",
            "strategy_type": "ema_crossover",
            "strategy_params": {},
            "prop_firm_rules": {"account_size": 100_000},
            "lifecycle_status": "approved",
            "paper_bot": {"paper_bot_id": "bot-1", "status": "ready", "guardrails": {}},
        }

        with patch.object(paper_session_service, "_require_candidate", return_value=candidate), patch.object(
            paper_session_service,
            "get_paper_session_by_candidate_any",
            return_value=None,
        ), patch.object(
            paper_session_service,
            "_now",
            return_value="2026-05-01T12:00:00+00:00",
        ), patch.object(
            paper_session_service,
            "_save_paper_session_any",
            side_effect=lambda session: session,
        ), patch.object(
            paper_session_service,
            "_append_paper_event_any",
            return_value=None,
        ), patch.object(
            paper_session_service,
            "_sync_candidate_paper_session",
            return_value=None,
        ), patch.object(
            paper_session_service,
            "_append_candidate_session_audit",
            return_value=None,
        ):
            session = paper_session_service.create_paper_session_for_candidate("cand-1", actor="test")

        self.assertEqual(session["spread_ticks"], 2)
        self.assertEqual(session["volatile_bar_threshold_ticks"], 12)
        self.assertEqual(session["volatile_bar_extra_ticks"], 1)
        self.assertEqual(session["resting_fill_mode"], "touch")
        self.assertEqual(session["status"], "ready")


if __name__ == "__main__":
    unittest.main()
