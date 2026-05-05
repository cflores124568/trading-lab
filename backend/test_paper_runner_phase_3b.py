#!/usr/bin/env python3

import os
import math
import sys
import types
import unittest
from copy import deepcopy
from unittest.mock import patch

import pandas as pd


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

import services.paper_session_service as paper_session_service
import services.paper_runner_service as paper_runner_service
from services.strategy import generate_signals


class PaperRunnerPhase3BTests(unittest.TestCase):
    def _build_signal_frame(self, columns: dict[str, list[float]]) -> pd.DataFrame:
        """Build a tiny synthetic bar frame for strategy signal checks."""
        size = len(next(iter(columns.values())))
        index = pd.date_range("2024-01-02 09:30:00", periods=size, freq="min")
        return pd.DataFrame(columns, index=index)

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

    def test_parity_matrix_covers_supported_strategies(self):
        """Walk each supported strategy through the frozen 3B edge cases.

        This keeps the scorecard honest without pretending the strategies are
        different where they aren't. The strategy-specific part is the raw
        signal stream; the runner actions and end-of-window behavior should
        stay the same across all four rows.
        """
        strategy_cases = [
            (
                "ma_crossover",
                {"fast_period": 2, "slow_period": 3},
                {
                    "warmup": self._build_signal_frame(
                        {"sma_2": [math.nan, math.nan], "sma_3": [math.nan, math.nan]}
                    ),
                    "flat": self._build_signal_frame(
                        {"sma_2": [99.0, 99.0, 99.0], "sma_3": [100.0, 100.0, 100.0]}
                    ),
                    "bullish": self._build_signal_frame(
                        {"sma_2": [99.0, 100.0, 101.0], "sma_3": [100.0, 100.0, 100.0]}
                    ),
                    "bearish": self._build_signal_frame(
                        {"sma_2": [101.0, 100.0, 99.0], "sma_3": [100.0, 100.0, 100.0]}
                    ),
                },
            ),
            (
                "ema_crossover",
                {"fast_period": 2, "slow_period": 3},
                {
                    "warmup": self._build_signal_frame(
                        {"ema_2": [math.nan, math.nan], "ema_3": [math.nan, math.nan]}
                    ),
                    "flat": self._build_signal_frame(
                        {"ema_2": [99.0, 99.0, 99.0], "ema_3": [100.0, 100.0, 100.0]}
                    ),
                    "bullish": self._build_signal_frame(
                        {"ema_2": [99.0, 100.0, 101.0], "ema_3": [100.0, 100.0, 100.0]}
                    ),
                    "bearish": self._build_signal_frame(
                        {"ema_2": [101.0, 100.0, 99.0], "ema_3": [100.0, 100.0, 100.0]}
                    ),
                },
            ),
            (
                "rsi_overbought",
                {"rsi_period": 14, "oversold": 30, "overbought": 70},
                {
                    "warmup": self._build_signal_frame({"rsi_14": [math.nan, math.nan]}),
                    "flat": self._build_signal_frame({"rsi_14": [50.0, 50.0, 50.0]}),
                    "bullish": self._build_signal_frame({"rsi_14": [35.0, 31.0, 30.0]}),
                    "bearish": self._build_signal_frame({"rsi_14": [65.0, 69.0, 70.0]}),
                },
            ),
            (
                "bollinger_bands",
                {"bb_period": 20, "std_dev": 2.0},
                {
                    "warmup": self._build_signal_frame(
                        {
                            "close": [100.0, 100.0],
                            "bb_lower": [math.nan, math.nan],
                            "bb_upper": [math.nan, math.nan],
                        }
                    ),
                    "flat": self._build_signal_frame(
                        {
                            "close": [100.0, 100.0, 100.0],
                            "bb_lower": [95.0, 95.0, 95.0],
                            "bb_upper": [105.0, 105.0, 105.0],
                        }
                    ),
                    "bullish": self._build_signal_frame(
                        {
                            "close": [100.0, 96.0, 94.0],
                            "bb_lower": [95.0, 95.0, 95.0],
                            "bb_upper": [105.0, 105.0, 105.0],
                        }
                    ),
                    "bearish": self._build_signal_frame(
                        {
                            "close": [100.0, 104.0, 106.0],
                            "bb_lower": [95.0, 95.0, 95.0],
                            "bb_upper": [105.0, 105.0, 105.0],
                        }
                    ),
                },
            ),
        ]

        for strategy_type, params, frames in strategy_cases:
            with self.subTest(strategy=strategy_type):
                warmup = generate_signals(frames["warmup"], strategy_type, params)
                self.assertTrue((warmup["signal"] == 0).all())

                flat_result = paper_runner_service._plan_signal_actions({}, 0)
                self.assertEqual(flat_result, ([], "flat_no_signal"))

                open_result = paper_runner_service._plan_signal_actions({"current_position": {"side": "buy"}}, 0)
                self.assertEqual(open_result, (["mark"], "mark_open_position"))

                bullish = generate_signals(frames["bullish"], strategy_type, params)
                bearish = generate_signals(frames["bearish"], strategy_type, params)
                flat = generate_signals(frames["flat"], strategy_type, params)

                self.assertEqual(int(bullish["signal"].iloc[-1]), 1)
                self.assertEqual(int(bearish["signal"].iloc[-1]), -1)
                self.assertTrue((flat["signal"] == 0).all())
                self.assertEqual(paper_runner_service._plan_signal_actions({}, 1), (["buy"], "open_long"))
                self.assertEqual(paper_runner_service._plan_signal_actions({"current_position": {"side": "sell"}}, 1), (["exit", "buy"], "flip_to_buy"))
                self.assertEqual(paper_runner_service._plan_signal_actions({}, -1), (["sell"], "open_short"))
                self.assertEqual(paper_runner_service._plan_signal_actions({"current_position": {"side": "buy"}}, -1), (["exit", "sell"], "flip_to_sell"))

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

    def test_build_runner_parity_check_requires_win_rate_to_stay_within_threshold(self):
        """Lock the parity scorecard so win-rate drift isn't hand-waved away.

        Trade count, total PnL, drawdown, and win rate all need to stay inside
        the frozen thresholds if we want the runner result to count as quiet.
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
        self.assertFalse(result["passed"])
        self.assertEqual(result["trade_count_delta"], 0)
        self.assertEqual(result["total_pnl_delta"], 0.0)
        self.assertEqual(result["max_drawdown_delta"], 0.0)
        self.assertEqual(result["win_rate_delta"], 0.85)

    def test_advance_one_bar_locked_force_closes_open_positions_at_window_end(self):
        """Freeze the final-bar rule so the runner matches backtest closure.

        When the window ends with a live position, the runner should realize it
        on the final candle instead of leaving the trade open and calling the
        result comparable.
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
        ), patch.object(
            paper_session_service,
            "_require_paper_session",
            return_value=session,
        ), patch.object(
            paper_session_service,
            "_save_paper_session_any",
            return_value=None,
        ), patch.object(
            paper_session_service,
            "_append_paper_event_any",
            return_value=None,
        ), patch.object(
            paper_session_service,
            "_make_paper_event",
            side_effect=lambda **payload: payload,
        ), patch.object(
            paper_session_service,
            "_require_candidate",
            return_value={"candidate_id": "cand-1"},
        ), patch.object(
            paper_session_service,
            "_sync_candidate_paper_session",
            return_value=None,
        ), patch.object(
            paper_session_service,
            "_append_candidate_session_audit",
            return_value=None,
        ), patch.object(
            paper_session_service,
            "_now",
            return_value="2026-04-20T12:00:00+00:00",
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
        self.assertEqual(refreshed["current_position"], {})
        self.assertEqual(len(refreshed["trade_log"]), 1)
        self.assertEqual(refreshed["trade_log"][0]["side"], "buy")
        self.assertEqual(refreshed["trade_log"][0]["pnl"], 45.0)
        self.assertEqual(refreshed["equity_curve"][-1], 100045.0)

    def test_advance_one_bar_locked_fails_fast_on_guardrail_breach(self):
        """Lock the breach rule so the runner stops instead of drifting past it.

        A hard guardrail breach should fail the historical runner immediately
        and leave the session marked failed for the operator to inspect.
        """
        session = {
            "paper_session_id": "paper-1",
            "candidate_id": "cand-1",
            "status": "running",
            "symbol": "ES",
            "interval": "1min",
            "runner_state": {"mode": "running", "bars_processed": 1},
            "current_position": {},
            "trade_log": [],
            "metrics_snapshot": {"total_pnl": -1000.0, "max_drawdown": 0.25, "win_rate": 0.0},
            "guardrail_state": {
                "passed": False,
                "daily_loss_breached": True,
                "drawdown_breached": False,
            },
            "last_bar_time": "2026-04-20T09:31:00+00:00",
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
            return_value={"time": "2026-04-20T09:32:00+00:00", "open": 100.0, "high": 100.0, "low": 100.0, "close": 100.0, "volume": 1.0},
        ), patch.object(
            paper_runner_service,
            "advance_paper_session_bar",
            side_effect=lambda paper_session_id, bar, **kwargs: session,
        ), patch.object(
            paper_runner_service,
            "_get_signal_history",
            return_value=[],
        ), patch.object(
            paper_session_service,
            "_build_guardrail_state",
            return_value={
                "passed": False,
                "daily_loss_breached": True,
                "drawdown_breached": False,
            },
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

        self.assertEqual(outcome, "guardrail_breached")
        self.assertEqual(refreshed["status"], "failed")
        self.assertEqual(refreshed["runner_state"]["mode"], "failed")
        self.assertIn("daily loss", refreshed["runner_state"]["last_error"])


if __name__ == "__main__":
    unittest.main()
