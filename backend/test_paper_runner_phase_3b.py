#!/usr/bin/env python3

import os
import sys
import types
import unittest
from copy import deepcopy
from unittest.mock import patch


def _install_fastapi_stub() -> None:
    """Stub `fastapi.HTTPException` so service imports still work here.

    I only need the exception type for these unit-level runner checks. This
    keeps the file runnable on machines that haven't installed the full API
    stack yet.
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

import services.paper_runner_service as paper_runner_service


class PaperRunnerPhase3BTests(unittest.TestCase):
    def test_plan_signal_actions_covers_current_position_transitions(self):
        """Lock the current action table before `3B` semantics start moving.

        This doesn't say the table is final forever. It just gives us a clean
        snapshot of what the runner does today so the next thread can change it
        on purpose instead of by accident.
        """
        cases = [
            ({}, 1, ["buy"], "open_long"),
            ({"current_position": {"side": "buy"}}, 1, ["mark"], "hold_long"),
            ({"current_position": {"side": "sell"}}, 1, ["exit", "buy"], "flip_to_buy"),
            ({}, -1, ["sell"], "open_short"),
            ({"current_position": {"side": "sell"}}, -1, ["mark"], "hold_short"),
            ({"current_position": {"side": "buy"}}, -1, ["exit", "sell"], "flip_to_sell"),
            ({"current_position": {"side": "buy"}}, 0, ["mark"], "mark_open_position"),
            ({}, 0, [], "flat_no_signal"),
            ({"current_position": {"side": "buy"}}, 99, ["mark"], "mark_open_position"),
        ]

        for session, signal, expected_actions, expected_label in cases:
            with self.subTest(session=session, signal=signal):
                actions, label = paper_runner_service._plan_signal_actions(session, signal)
                self.assertEqual(actions, expected_actions)
                self.assertEqual(label, expected_label)

    def test_build_runner_parity_check_current_states_are_explicit(self):
        """Document the current parity helper outputs before we tighten them.

        The point is to make missing references and loose pass/fail behavior
        obvious. That way the next `3B` pass can tighten rules with intent.
        """
        session = {
            "candidate_id": "cand-1",
            "metrics_snapshot": {"total_pnl": 250.0, "max_drawdown": 0.01, "win_rate": 0.50},
            "trade_log": [{"trade_id": 1}],
        }

        with patch.object(
            paper_runner_service,
            "_require_candidate",
            return_value={"candidate_id": "cand-1", "backtest_id": None},
        ):
            result = paper_runner_service._build_runner_parity_check(deepcopy(session), now="2026-04-20T12:00:00+00:00")
            self.assertEqual(result["status"], "missing_backtest")

        with patch.object(
            paper_runner_service,
            "_require_candidate",
            return_value={"candidate_id": "cand-1", "backtest_id": "bt-1"},
        ), patch.object(paper_runner_service, "_load_backtest_any", return_value=None):
            result = paper_runner_service._build_runner_parity_check(deepcopy(session), now="2026-04-20T12:00:00+00:00")
            self.assertEqual(result["status"], "backtest_not_found")

        with patch.object(
            paper_runner_service,
            "_require_candidate",
            return_value={"candidate_id": "cand-1", "backtest_id": "bt-1"},
        ), patch.object(paper_runner_service, "_load_backtest_any", side_effect=RuntimeError("db blew up")):
            result = paper_runner_service._build_runner_parity_check(deepcopy(session), now="2026-04-20T12:00:00+00:00")
            self.assertEqual(result["status"], "parity_unavailable")
            self.assertEqual(result["error"], "db blew up")

    def test_build_runner_parity_check_currently_ignores_win_rate_delta_for_pass_fail(self):
        """Show one of the current `3B` gaps without changing behavior yet.

        Right now pass/fail is driven by trade count, total PnL, and drawdown.
        A big win-rate drift is still reported, but it doesn't fail parity.
        """
        session = {
            "candidate_id": "cand-1",
            "metrics_snapshot": {"total_pnl": 250.0, "max_drawdown": 0.01, "win_rate": 0.95},
            "trade_log": [{"trade_id": 1}, {"trade_id": 2}],
        }
        reference = {
            "metrics": {"total_pnl": 250.0, "max_drawdown": 0.01, "win_rate": 0.10},
            "trades": [{"trade_id": 1}, {"trade_id": 2}],
        }

        with patch.object(
            paper_runner_service,
            "_require_candidate",
            return_value={"candidate_id": "cand-1", "backtest_id": "bt-1"},
        ), patch.object(paper_runner_service, "_load_backtest_any", return_value=reference):
            result = paper_runner_service._build_runner_parity_check(session, now="2026-04-20T12:00:00+00:00")

        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["passed"])
        self.assertEqual(result["trade_count_delta"], 0)
        self.assertEqual(result["total_pnl_delta"], 0.0)
        self.assertEqual(result["max_drawdown_delta"], 0.0)
        self.assertEqual(result["win_rate_delta"], 0.85)

    def test_advance_one_bar_locked_currently_finishes_window_without_force_close(self):
        """Capture the current end-of-window behavior before we decide if it's wrong.

        The runner marks the window complete and writes parity state, but it
        does not flatten an open position on exhaustion the way the backtest
        engine force-closes at the final bar.
        """
        session = {
            "paper_session_id": "paper-1",
            "candidate_id": "cand-1",
            "status": "running",
            "symbol": "ES",
            "interval": "1min",
            "runner_state": {"mode": "running", "bars_processed": 5},
            "current_position": {
                "side": "buy",
                "entry_time": "2026-04-20T09:35:00+00:00",
                "entry_price": 100.0,
                "mark_price": 101.0,
                "last_mark_time": "2026-04-20T09:39:00+00:00",
                "unrealized_pnl": 12.5,
                "status": "open",
            },
            "trade_log": [],
            "metrics_snapshot": {"total_pnl": 0.0, "max_drawdown": 0.0, "win_rate": 0.0},
            "last_bar_time": "2026-04-20T09:39:00+00:00",
        }

        with patch.object(paper_runner_service, "_require_paper_session", return_value=session), patch.object(
            paper_runner_service,
            "_ensure_session_defaults",
            side_effect=lambda payload: payload,
        ), patch.object(
            paper_runner_service,
            "_apply_default_window",
            side_effect=lambda _session, state: state,
        ), patch.object(
            paper_runner_service,
            "_validate_range",
            return_value=None,
        ), patch.object(
            paper_runner_service,
            "get_next_ohlcv_bar",
            return_value=None,
        ), patch.object(
            paper_runner_service,
            "_now",
            return_value="2026-04-20T12:00:00+00:00",
        ), patch.object(
            paper_runner_service,
            "_build_runner_parity_check",
            return_value={"status": "ok", "passed": True},
        ), patch.object(
            paper_runner_service,
            "_save_paper_session_any",
            return_value=None,
        ), patch.object(
            paper_runner_service,
            "_append_paper_event_any",
            return_value=None,
        ), patch.object(
            paper_runner_service,
            "_make_paper_event",
            side_effect=lambda **payload: payload,
        ), patch.object(
            paper_runner_service,
            "_require_candidate",
            return_value={"candidate_id": "cand-1"},
        ), patch.object(
            paper_runner_service,
            "_sync_candidate_paper_session",
            return_value=None,
        ), patch.object(
            paper_runner_service,
            "_append_candidate_session_audit",
            return_value=None,
        ):
            refreshed, outcome = paper_runner_service._advance_one_bar_locked(
                "paper-1",
                actor="paper-runner",
                keep_running=True,
            )

        self.assertEqual(outcome, "window_exhausted")
        self.assertEqual(refreshed["runner_state"]["mode"], "completed")
        self.assertEqual(refreshed["runner_state"]["parity_check"], {"status": "ok", "passed": True})
        self.assertEqual(refreshed["status"], "paused")
        self.assertEqual(refreshed["current_position"]["side"], "buy")
        self.assertEqual(refreshed["trade_log"], [])


if __name__ == "__main__":
    unittest.main()
