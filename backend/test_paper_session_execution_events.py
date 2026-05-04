#!/usr/bin/env python3

import os
import sys
import types
import unittest
from unittest.mock import patch


def _install_fastapi_stub() -> None:
    """Stub `fastapi.HTTPException` so these service tests stay lightweight.

    I only need imports to work here. Pulling the whole API stack into a tiny
    unit test just makes the loop slower and more brittle than it needs to be.
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


class PaperSessionExecutionEventTests(unittest.TestCase):
    def test_reversal_open_event_keeps_the_closed_trade_payload(self):
        """Opposite taker fills should log the trade they just closed.

        I want the paper event trail to say both things that happened on a
        reversal: the old position got flattened, and the new one opened at the
        same print. That keeps the analytics honest instead of quietly dropping
        the exit side.
        """
        captured_event = {}
        session = {
            "paper_session_id": "paper-1",
            "candidate_id": "cand-1",
            "status": "running",
            "symbol": "ES",
            "interval": "1min",
            "prop_firm_rules": {"account_size": 100_000},
            "guardrails": {},
            "commission": 5.0,
            "tick_value": 50.0,
            "tick_size": 0.25,
            "spread_ticks": 1,
            "volatile_bar_threshold_ticks": 0,
            "volatile_bar_extra_ticks": 0,
            "resting_fill_mode": "touch",
            "current_position": {
                "side": "buy",
                "contracts": 1,
                "entry_price": 100.25,
                "entry_time": "2026-05-01T09:30:00+00:00",
                "mark_price": 100.25,
                "last_mark_time": "2026-05-01T09:30:00+00:00",
                "unrealized_pnl": 0.0,
                "status": "open",
            },
            "active_order": {},
            "last_quote": {"bid": 101.0, "ask": 101.25, "reference": 101.0},
            "trade_log": [],
            "equity_curve": [100_000.0],
            "runner_state": {},
            "last_bar_time": "2026-05-01T09:31:00+00:00",
            "last_event_at": "2026-05-01T09:31:00+00:00",
            "created_by": "test",
            "created_at": "2026-05-01T09:30:00+00:00",
            "updated_at": "2026-05-01T09:31:00+00:00",
        }

        with patch.object(paper_session_service, "_require_paper_session", return_value=session), patch.object(
            paper_session_service,
            "_save_paper_session_any",
            side_effect=lambda payload: payload,
        ), patch.object(
            paper_session_service,
            "_append_paper_event_any",
            side_effect=lambda payload: captured_event.update(payload),
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
            return_value="2026-05-01T09:31:00+00:00",
        ):
            updated = paper_session_service.execute_paper_session_action(
                "paper-1",
                action="hit_bid",
                actor="tester",
            )

        self.assertEqual(updated["current_position"]["side"], "sell")
        self.assertEqual(len(updated["trade_log"]), 1)
        self.assertEqual(captured_event["event_type"], "position_opened")
        self.assertEqual(captured_event["payload"]["side"], "sell")
        self.assertIsNotNone(captured_event["payload"]["closed_trade"])
        self.assertEqual(captured_event["payload"]["closed_trade"]["side"], "buy")
        self.assertEqual(captured_event["payload"]["closed_trade"]["exit_price"], 101.0)

    def test_resting_exit_fill_closes_the_open_trade(self):
        """Resting exits should actually behave like exits.

        This is the first real split between entry and exit order lifecycle.
        If a long posts a resting exit, the later fill needs to flatten that
        trade and log it, not quietly open a weird new short.
        """
        captured_events = []
        session = {
            "paper_session_id": "paper-1",
            "candidate_id": "cand-1",
            "status": "running",
            "symbol": "ES",
            "interval": "1min",
            "prop_firm_rules": {"account_size": 100_000},
            "guardrails": {},
            "commission": 5.0,
            "tick_value": 50.0,
            "tick_size": 0.25,
            "spread_ticks": 1,
            "volatile_bar_threshold_ticks": 0,
            "volatile_bar_extra_ticks": 0,
            "resting_fill_mode": "touch",
            "current_position": {
                "side": "buy",
                "contracts": 1,
                "entry_price": 100.25,
                "entry_time": "2026-05-01T09:30:00+00:00",
                "mark_price": 100.25,
                "last_mark_time": "2026-05-01T09:30:00+00:00",
                "unrealized_pnl": 0.0,
                "status": "open",
            },
            "active_order": {},
            "last_quote": {"bid": 101.0, "ask": 101.25, "reference": 101.0},
            "trade_log": [],
            "equity_curve": [100_000.0],
            "runner_state": {"bars_processed": 1},
            "last_bar_time": "2026-05-01T09:31:00+00:00",
            "last_event_at": "2026-05-01T09:31:00+00:00",
            "created_by": "test",
            "created_at": "2026-05-01T09:30:00+00:00",
            "updated_at": "2026-05-01T09:31:00+00:00",
        }

        with patch.object(paper_session_service, "_require_paper_session", return_value=session), patch.object(
            paper_session_service,
            "_save_paper_session_any",
            side_effect=lambda payload: payload,
        ), patch.object(
            paper_session_service,
            "_append_paper_event_any",
            side_effect=lambda payload: captured_events.append(payload),
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
            side_effect=[
                "2026-05-01T09:31:00+00:00",
                "2026-05-01T09:32:00+00:00",
            ],
        ):
            updated = paper_session_service.execute_paper_session_action(
                "paper-1",
                action="rest_exit",
                actor="tester",
            )
            self.assertEqual(updated["active_order"]["intent"], "exit")
            self.assertEqual(updated["active_order"]["side"], "sell")
            self.assertEqual(updated["active_order"]["price"], 101.25)

            advanced = paper_session_service.advance_paper_session_bar(
                "paper-1",
                {
                    "time": "2026-05-01T09:32:00+00:00",
                    "open": 101.0,
                    "high": 101.5,
                    "low": 100.75,
                    "close": 101.25,
                    "volume": 10.0,
                },
                actor="tester",
            )

        self.assertEqual(advanced["current_position"], {})
        self.assertEqual(advanced["active_order"], {})
        self.assertEqual(len(advanced["trade_log"]), 1)
        self.assertEqual(advanced["trade_log"][0]["side"], "buy")
        self.assertEqual(advanced["trade_log"][0]["exit_price"], 101.25)
        self.assertEqual(captured_events[-1]["event_type"], "order_filled")
        self.assertEqual(captured_events[-1]["payload"]["order"]["intent"], "exit")
        self.assertEqual(captured_events[-1]["payload"]["closed_trade"]["side"], "buy")

    def test_replace_creates_a_new_child_order_with_lineage(self):
        """Replacing should behave like cancel-and-new-child, not mutation.

        I want the working order trail to stay honest. The old order should end
        life as `replaced`, the new one should get a fresh id, and the session
        should keep the lineage so later UI/event views can show what happened.
        """
        captured_event = {}
        session = {
            "paper_session_id": "paper-1",
            "candidate_id": "cand-1",
            "status": "running",
            "symbol": "ES",
            "interval": "1min",
            "prop_firm_rules": {"account_size": 100_000},
            "guardrails": {},
            "commission": 5.0,
            "tick_value": 50.0,
            "tick_size": 0.25,
            "spread_ticks": 1,
            "volatile_bar_threshold_ticks": 0,
            "volatile_bar_extra_ticks": 0,
            "resting_fill_mode": "touch",
            "current_position": {},
            "active_order": {
                "id": "order-1",
                "intent": "entry",
                "side": "buy",
                "price": 100.0,
                "submitted_at": "2026-05-01T09:30:00+00:00",
                "submitted_bar_index": 1,
                "type": "join_bid",
                "status": "pending",
                "first_touch_at": "2026-05-01T09:31:00+00:00",
                "first_touch_bar_index": 2,
            },
            "last_quote": {"bid": 99.75, "ask": 100.0, "reference": 99.75},
            "trade_log": [],
            "equity_curve": [100_000.0],
            "runner_state": {"bars_processed": 3},
            "last_bar_time": "2026-05-01T09:32:00+00:00",
            "last_event_at": "2026-05-01T09:32:00+00:00",
            "created_by": "test",
            "created_at": "2026-05-01T09:30:00+00:00",
            "updated_at": "2026-05-01T09:32:00+00:00",
        }

        with patch.object(paper_session_service, "_require_paper_session", return_value=session), patch.object(
            paper_session_service,
            "_save_paper_session_any",
            side_effect=lambda payload: payload,
        ), patch.object(
            paper_session_service,
            "_append_paper_event_any",
            side_effect=lambda payload: captured_event.update(payload),
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
            return_value="2026-05-01T09:32:00+00:00",
        ), patch.object(
            paper_session_service.uuid,
            "uuid4",
            return_value="order-2",
        ):
            updated = paper_session_service.execute_paper_session_action(
                "paper-1",
                action="replace",
                actor="tester",
            )

        self.assertEqual(updated["active_order"]["id"], "order-2")
        self.assertEqual(updated["active_order"]["price"], 99.75)
        self.assertEqual(updated["active_order"]["replaces_order_id"], "order-1")
        self.assertEqual(updated["active_order"]["parent_order_id"], "order-1")
        self.assertEqual(updated["active_order"]["replace_count"], 1)
        self.assertNotIn("first_touch_at", updated["active_order"])
        self.assertEqual(captured_event["event_type"], "order_replaced")
        self.assertEqual(captured_event["payload"]["replaced_order"]["status"], "replaced")
        self.assertEqual(captured_event["payload"]["replaced_order"]["replaced_by_order_id"], "order-2")
        self.assertEqual(captured_event["payload"]["order"]["id"], "order-2")

    def test_bracket_target_fill_closes_the_trade_and_cancels_the_stop(self):
        """Target-first brackets should flatten and kill the sibling stop.

        I want the bracket to stay explicit in the event trail. When the target
        fills, the long should close, the stop should get canceled as the OCO
        sibling, and the session should end up with no live exits left around.
        """
        captured_events = []
        session = {
            "paper_session_id": "paper-1",
            "candidate_id": "cand-1",
            "status": "running",
            "symbol": "ES",
            "interval": "1min",
            "prop_firm_rules": {"account_size": 100_000},
            "guardrails": {},
            "commission": 5.0,
            "tick_value": 50.0,
            "tick_size": 0.25,
            "spread_ticks": 1,
            "volatile_bar_threshold_ticks": 0,
            "volatile_bar_extra_ticks": 0,
            "resting_fill_mode": "touch",
            "current_position": {
                "side": "buy",
                "contracts": 1,
                "entry_price": 100.25,
                "entry_time": "2026-05-01T09:30:00+00:00",
                "mark_price": 100.5,
                "last_mark_time": "2026-05-01T09:31:00+00:00",
                "unrealized_pnl": 12.5,
                "status": "open",
            },
            "active_order": {},
            "last_quote": {"bid": 100.5, "ask": 100.75, "reference": 100.5},
            "trade_log": [],
            "equity_curve": [100_000.0],
            "runner_state": {"bars_processed": 1},
            "last_bar_time": "2026-05-01T09:31:00+00:00",
            "last_event_at": "2026-05-01T09:31:00+00:00",
            "created_by": "test",
            "created_at": "2026-05-01T09:30:00+00:00",
            "updated_at": "2026-05-01T09:31:00+00:00",
        }

        with patch.object(paper_session_service, "_require_paper_session", return_value=session), patch.object(
            paper_session_service,
            "_save_paper_session_any",
            side_effect=lambda payload: payload,
        ), patch.object(
            paper_session_service,
            "_append_paper_event_any",
            side_effect=lambda payload: captured_events.append(payload),
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
            side_effect=[
                "2026-05-01T09:31:00+00:00",
                "2026-05-01T09:32:00+00:00",
            ],
        ), patch.object(
            paper_session_service.uuid,
            "uuid4",
            side_effect=["bracket-1", "stop-1", "target-1", "evt-1", "evt-2", "evt-3"],
        ):
            updated = paper_session_service.execute_paper_session_action(
                "paper-1",
                action="attach_bracket",
                stop_price=99.75,
                target_price=102.0,
                actor="tester",
            )
            self.assertEqual(len(updated["active_orders"]), 2)
            self.assertEqual(updated["active_orders"][0]["bracket_role"], "target")
            self.assertTrue(all(order["intent"] == "exit" for order in updated["active_orders"]))

            advanced = paper_session_service.advance_paper_session_bar(
                "paper-1",
                {
                    "time": "2026-05-01T09:32:00+00:00",
                    "open": 100.5,
                    "high": 102.5,
                    "low": 100.25,
                    "close": 102.0,
                    "volume": 10.0,
                },
                actor="tester",
            )

        self.assertEqual(advanced["current_position"], {})
        self.assertEqual(advanced["active_order"], {})
        self.assertEqual(advanced["active_orders"], [])
        self.assertEqual(len(advanced["trade_log"]), 1)
        self.assertEqual(advanced["trade_log"][0]["exit_price"], 102.0)
        self.assertEqual(captured_events[-2]["event_type"], "order_filled")
        self.assertEqual(captured_events[-2]["payload"]["order"]["bracket_role"], "target")
        self.assertEqual(captured_events[-1]["event_type"], "order_canceled")
        self.assertEqual(captured_events[-1]["payload"]["order"]["bracket_role"], "stop")
        self.assertEqual(captured_events[-1]["payload"]["reason"], "oco_sibling_filled")

    def test_bracket_stop_fill_closes_the_trade(self):
        """Stops should behave like reduce-only exits, not flip trades.

        If the stop gets tagged first, I still want the long closed cleanly and
        the target gone from the live state right after.
        """
        captured_events = []
        session = {
            "paper_session_id": "paper-1",
            "candidate_id": "cand-1",
            "status": "running",
            "symbol": "ES",
            "interval": "1min",
            "prop_firm_rules": {"account_size": 100_000},
            "guardrails": {},
            "commission": 5.0,
            "tick_value": 50.0,
            "tick_size": 0.25,
            "spread_ticks": 1,
            "volatile_bar_threshold_ticks": 0,
            "volatile_bar_extra_ticks": 0,
            "resting_fill_mode": "touch",
            "current_position": {
                "side": "buy",
                "contracts": 1,
                "entry_price": 100.25,
                "entry_time": "2026-05-01T09:30:00+00:00",
                "mark_price": 100.5,
                "last_mark_time": "2026-05-01T09:31:00+00:00",
                "unrealized_pnl": 12.5,
                "status": "open",
            },
            "active_order": {},
            "last_quote": {"bid": 100.5, "ask": 100.75, "reference": 100.5},
            "trade_log": [],
            "equity_curve": [100_000.0],
            "runner_state": {"bars_processed": 1},
            "last_bar_time": "2026-05-01T09:31:00+00:00",
            "last_event_at": "2026-05-01T09:31:00+00:00",
            "created_by": "test",
            "created_at": "2026-05-01T09:30:00+00:00",
            "updated_at": "2026-05-01T09:31:00+00:00",
        }

        with patch.object(paper_session_service, "_require_paper_session", return_value=session), patch.object(
            paper_session_service,
            "_save_paper_session_any",
            side_effect=lambda payload: payload,
        ), patch.object(
            paper_session_service,
            "_append_paper_event_any",
            side_effect=lambda payload: captured_events.append(payload),
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
            side_effect=[
                "2026-05-01T09:31:00+00:00",
                "2026-05-01T09:32:00+00:00",
            ],
        ), patch.object(
            paper_session_service.uuid,
            "uuid4",
            side_effect=["bracket-1", "stop-1", "target-1", "evt-1", "evt-2", "evt-3"],
        ):
            paper_session_service.execute_paper_session_action(
                "paper-1",
                action="attach_bracket",
                stop_price=99.75,
                target_price=102.0,
                actor="tester",
            )
            advanced = paper_session_service.advance_paper_session_bar(
                "paper-1",
                {
                    "time": "2026-05-01T09:32:00+00:00",
                    "open": 100.5,
                    "high": 100.75,
                    "low": 99.5,
                    "close": 99.75,
                    "volume": 10.0,
                },
                actor="tester",
            )

        self.assertEqual(advanced["current_position"], {})
        self.assertEqual(advanced["trade_log"][0]["exit_price"], 99.75)
        self.assertEqual(captured_events[-2]["payload"]["order"]["bracket_role"], "stop")

    def test_same_bar_bracket_hit_chooses_stop_first(self):
        """When both bracket legs get touched, I want the conservative answer.

        Same-bar OHLC data can't tell me which one really traded first. I use
        the same stop-first rule as the backtest engine so this doesn't get
        unrealistically flattering.
        """
        captured_events = []
        session = {
            "paper_session_id": "paper-1",
            "candidate_id": "cand-1",
            "status": "running",
            "symbol": "ES",
            "interval": "1min",
            "prop_firm_rules": {"account_size": 100_000},
            "guardrails": {},
            "commission": 5.0,
            "tick_value": 50.0,
            "tick_size": 0.25,
            "spread_ticks": 1,
            "volatile_bar_threshold_ticks": 0,
            "volatile_bar_extra_ticks": 0,
            "resting_fill_mode": "touch",
            "current_position": {
                "side": "buy",
                "contracts": 1,
                "entry_price": 100.25,
                "entry_time": "2026-05-01T09:30:00+00:00",
                "mark_price": 100.5,
                "last_mark_time": "2026-05-01T09:31:00+00:00",
                "unrealized_pnl": 12.5,
                "status": "open",
            },
            "active_order": {},
            "last_quote": {"bid": 100.5, "ask": 100.75, "reference": 100.5},
            "trade_log": [],
            "equity_curve": [100_000.0],
            "runner_state": {"bars_processed": 1},
            "last_bar_time": "2026-05-01T09:31:00+00:00",
            "last_event_at": "2026-05-01T09:31:00+00:00",
            "created_by": "test",
            "created_at": "2026-05-01T09:30:00+00:00",
            "updated_at": "2026-05-01T09:31:00+00:00",
        }

        with patch.object(paper_session_service, "_require_paper_session", return_value=session), patch.object(
            paper_session_service,
            "_save_paper_session_any",
            side_effect=lambda payload: payload,
        ), patch.object(
            paper_session_service,
            "_append_paper_event_any",
            side_effect=lambda payload: captured_events.append(payload),
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
            side_effect=[
                "2026-05-01T09:31:00+00:00",
                "2026-05-01T09:32:00+00:00",
            ],
        ), patch.object(
            paper_session_service.uuid,
            "uuid4",
            side_effect=["bracket-1", "stop-1", "target-1", "evt-1", "evt-2", "evt-3"],
        ):
            paper_session_service.execute_paper_session_action(
                "paper-1",
                action="attach_bracket",
                stop_price=99.75,
                target_price=102.0,
                actor="tester",
            )
            advanced = paper_session_service.advance_paper_session_bar(
                "paper-1",
                {
                    "time": "2026-05-01T09:32:00+00:00",
                    "open": 100.5,
                    "high": 102.5,
                    "low": 99.5,
                    "close": 101.0,
                    "volume": 10.0,
                },
                actor="tester",
            )

        self.assertEqual(advanced["trade_log"][0]["exit_price"], 99.75)
        self.assertEqual(captured_events[-2]["payload"]["order"]["bracket_role"], "stop")


if __name__ == "__main__":
    unittest.main()
