#!/usr/bin/env python3

import os
import sys
import unittest
from contextlib import ExitStack
from copy import deepcopy
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

from schemas import PaperDecisionStatus, PaperPolicyMode, PaperRiskAssessment
from services.paper_policy_service import (
    build_market_observation,
    decide_with_deterministic_policy,
    decision_requires_approval,
    normalize_policy_mode,
    update_shadow_scorecard,
)
import services.paper_runner_service as paper_runner_service


class PaperPolicyTests(unittest.TestCase):
    def _session(self, position=None):
        return {
            "paper_session_id": "paper-1",
            "candidate_id": "cand-1",
            "symbol": "ES",
            "interval": "1min",
            "current_position": position or {},
            "active_orders": [],
            "metrics_snapshot": {"total_pnl": 125.0},
            "guardrail_state": {"daily_loss_breached": False},
        }

    def _bar(self):
        return {
            "time": "2026-07-18T16:00:00+00:00",
            "open": 6400.0,
            "high": 6401.0,
            "low": 6399.0,
            "close": 6400.5,
            "volume": 100.0,
        }

    def test_observation_freezes_the_policy_input(self):
        session = self._session({"side": "buy"})
        observation = build_market_observation(session, self._bar(), signal=1, bar_index=12)
        session["current_position"]["side"] = "sell"

        self.assertEqual(observation.current_position["side"], "buy")
        self.assertEqual(observation.signal, 1)
        self.assertEqual(observation.bar_index, 12)
        self.assertEqual(observation.metrics_snapshot["total_pnl"], 125.0)

    def test_deterministic_policy_preserves_phase_3b_flip_semantics(self):
        observation = build_market_observation(
            self._session({"side": "sell"}),
            self._bar(),
            signal=1,
            bar_index=4,
        )
        decision = decide_with_deterministic_policy(
            observation,
            policy_mode=PaperPolicyMode.AUTONOMOUS_PAPER,
            created_at="2026-07-18T16:00:01+00:00",
        )

        self.assertEqual(decision.actions, ["exit", "buy"])
        self.assertEqual(decision.action_label, "flip_to_buy")
        self.assertTrue(decision_requires_approval(decision))
        self.assertEqual(decision.status, PaperDecisionStatus.GENERATED)
        self.assertEqual(decision.policy_name, "deterministic_signal")
        self.assertEqual(decision.policy_version, "1")

    def test_mark_and_no_action_do_not_require_operator_approval(self):
        hold = decide_with_deterministic_policy(
            build_market_observation(
                self._session({"side": "buy"}),
                self._bar(),
                signal=0,
                bar_index=1,
            ),
            policy_mode="approval_required",
            created_at="2026-07-18T16:00:01+00:00",
        )
        flat = decide_with_deterministic_policy(
            build_market_observation(self._session(), self._bar(), signal=0, bar_index=1),
            policy_mode="approval_required",
            created_at="2026-07-18T16:00:01+00:00",
        )

        self.assertEqual(hold.actions, ["mark"])
        self.assertFalse(decision_requires_approval(hold))
        self.assertEqual(flat.actions, [])
        self.assertFalse(decision_requires_approval(flat))

    def test_unknown_policy_mode_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "Unknown paper policy mode"):
            normalize_policy_mode("send_it")

    def test_shadow_scorecard_accumulates_durable_policy_proposals(self):
        scorecard = None
        for signal in [0, 1, -1]:
            decision = decide_with_deterministic_policy(
                build_market_observation(self._session(), self._bar(), signal=signal, bar_index=signal + 1),
                policy_mode="shadow",
                created_at="2026-07-18T16:00:01+00:00",
            )
            decision.status = PaperDecisionStatus.SHADOWED
            scorecard = update_shadow_scorecard(scorecard, decision)

        self.assertEqual(scorecard.total_decisions, 3)
        self.assertEqual(scorecard.actionable_decisions, 2)
        self.assertEqual(scorecard.no_action_decisions, 1)
        self.assertEqual(scorecard.buy_proposals, 1)
        self.assertEqual(scorecard.sell_proposals, 1)
        self.assertEqual(scorecard.exit_proposals, 0)
        self.assertEqual(scorecard.bullish_observations, 1)
        self.assertEqual(scorecard.bearish_observations, 1)
        self.assertEqual(scorecard.flat_observations, 1)

    def test_runner_modes_share_one_policy_but_gate_execution_differently(self):
        cases = [
            ("autonomous_paper", "approved", "stepped", ["lift_ask"], "executed", False),
            ("autonomous_paper", "blocked", "risk_blocked", [], "blocked", False),
            ("shadow", "approved", "stepped", [], "shadowed", False),
            ("approval_required", "approved", "approval_required", [], "pending_approval", True),
        ]

        for mode, risk_status, expected_outcome, expected_execution, expected_status, expects_pending in cases:
            with self.subTest(mode=mode, risk_status=risk_status):
                session = {
                    **self._session(),
                    "status": "running",
                    "interval": "5m",
                    "strategy_type": "ema_crossover",
                    "strategy_params": {},
                    "runner_state": {
                        "mode": "running",
                        "policy_mode": mode,
                        "bars_processed": 0,
                    },
                    "last_bar_time": None,
                    "last_quote": {"bid": 6400.25, "ask": 6400.75, "reference": 6400.5},
                }
                executed = []
                events = []

                with ExitStack() as stack:
                    stack.enter_context(patch.object(paper_runner_service, "_require_paper_session", return_value=session))
                    stack.enter_context(
                        patch.object(
                            paper_runner_service,
                            "_ensure_session_defaults",
                            side_effect=lambda payload: payload,
                        )
                    )
                    stack.enter_context(
                        patch.object(
                            paper_runner_service,
                            "_apply_default_window",
                            side_effect=lambda _session, state: state,
                        )
                    )
                    stack.enter_context(patch.object(paper_runner_service, "_validate_range", return_value=None))
                    next_bar_mock = stack.enter_context(
                        patch.object(paper_runner_service, "get_next_ohlcv_bar", return_value=self._bar())
                    )
                    stack.enter_context(patch.object(paper_runner_service, "_get_signal_history", return_value=[]))
                    stack.enter_context(patch.object(paper_runner_service, "_set_signal_history", return_value=None))
                    stack.enter_context(patch.object(paper_runner_service, "_compute_strategy_signal", return_value=1))
                    stack.enter_context(
                        patch.object(
                            paper_runner_service,
                            "assess_pretrade_risk",
                            side_effect=lambda _session, decision, **_kwargs: PaperRiskAssessment(
                                assessment_id="risk-1",
                                decision_id=decision.decision_id,
                                status=risk_status,
                                violations=["Emergency kill switch is engaged."] if risk_status == "blocked" else [],
                                checked_at="2026-07-18T16:00:01+00:00",
                            ),
                        )
                    )
                    stack.enter_context(
                        patch.object(
                            paper_runner_service,
                            "advance_paper_session_bar",
                            return_value=session,
                        )
                    )
                    stack.enter_context(
                        patch.object(
                            paper_runner_service,
                            "execute_paper_session_action",
                            side_effect=lambda _session_id, *, action, **_kwargs: executed.append(action) or session,
                        )
                    )
                    stack.enter_context(patch.object(paper_runner_service, "_save_paper_session_any", return_value=session))
                    stack.enter_context(
                        patch.object(
                            paper_runner_service,
                            "_append_paper_event_any",
                            side_effect=lambda event: events.append(event) or event,
                        )
                    )
                    stack.enter_context(
                        patch.object(
                            paper_runner_service,
                            "_make_paper_event",
                            side_effect=lambda **payload: payload,
                        )
                    )
                    stack.enter_context(patch.object(paper_runner_service, "_runner_guardrail_breached", return_value=False))
                    stack.enter_context(patch.object(paper_runner_service, "_require_candidate", return_value={"candidate_id": "cand-1"}))
                    stack.enter_context(patch.object(paper_runner_service, "_sync_candidate_paper_session", return_value=None))
                    stack.enter_context(patch.object(paper_runner_service, "_append_candidate_session_audit", return_value=None))
                    stack.enter_context(
                        patch.object(
                            paper_runner_service,
                            "_now",
                            return_value="2026-07-18T16:00:01+00:00",
                        )
                    )

                    _, outcome = paper_runner_service._advance_one_bar_locked(
                        "paper-1",
                        actor="test",
                        keep_running=True,
                    )

                self.assertEqual(outcome, expected_outcome)
                self.assertEqual(next_bar_mock.call_args.kwargs["interval"], "5min")
                self.assertEqual(executed, expected_execution)
                self.assertEqual(session["runner_state"]["last_decision"]["status"], expected_status)
                self.assertEqual(bool(session["runner_state"]["pending_decision"]), expects_pending)
                self.assertTrue(any(event["event_type"] == "policy_decision" for event in events))
                if mode == "shadow":
                    self.assertEqual(session["runner_state"]["shadow_scorecard"]["total_decisions"], 1)
                if risk_status == "blocked":
                    self.assertTrue(any(event["event_type"] == "policy_action_blocked" for event in events))

    def test_pending_decision_resolution_is_explicit_and_durable(self):
        for approved, expected_status, expected_execution in [
            (True, "executed", ["lift_ask"]),
            (False, "rejected", []),
        ]:
            with self.subTest(approved=approved):
                decision = decide_with_deterministic_policy(
                    build_market_observation(self._session(), self._bar(), signal=1, bar_index=2),
                    policy_mode="approval_required",
                    created_at="2026-07-18T16:00:01+00:00",
                )
                decision.status = PaperDecisionStatus.PENDING_APPROVAL
                session = {
                    **self._session(),
                    "status": "paused",
                    "runner_state": {
                        "mode": "paused",
                        "policy_mode": "approval_required",
                        "pending_decision": decision.model_dump(mode="json"),
                    },
                }
                executed = []
                events = []

                with ExitStack() as stack:
                    stack.enter_context(patch.object(paper_runner_service, "_stop_runner_thread", return_value=None))
                    stack.enter_context(patch.object(paper_runner_service, "_require_paper_session", return_value=session))
                    stack.enter_context(
                        patch.object(
                            paper_runner_service,
                            "_ensure_session_defaults",
                            side_effect=lambda payload: payload,
                        )
                    )
                    stack.enter_context(patch.object(paper_runner_service, "_runner_guardrail_breached", return_value=False))
                    stack.enter_context(
                        patch.object(
                            paper_runner_service,
                            "execute_paper_session_action",
                            side_effect=lambda _session_id, *, action, **_kwargs: executed.append(action) or session,
                        )
                    )
                    stack.enter_context(patch.object(paper_runner_service, "_save_paper_session_any", return_value=session))
                    stack.enter_context(
                        patch.object(
                            paper_runner_service,
                            "_append_paper_event_any",
                            side_effect=lambda event: events.append(event) or event,
                        )
                    )
                    stack.enter_context(
                        patch.object(
                            paper_runner_service,
                            "_make_paper_event",
                            side_effect=lambda **payload: payload,
                        )
                    )
                    stack.enter_context(patch.object(paper_runner_service, "_require_candidate", return_value={"candidate_id": "cand-1"}))
                    stack.enter_context(patch.object(paper_runner_service, "_sync_candidate_paper_session", return_value=None))
                    stack.enter_context(patch.object(paper_runner_service, "_append_candidate_session_audit", return_value=None))
                    stack.enter_context(
                        patch.object(
                            paper_runner_service,
                            "_now",
                            return_value="2026-07-18T16:01:00+00:00",
                        )
                    )

                    result = paper_runner_service.resolve_pending_policy_decision(
                        "paper-1",
                        approved=approved,
                        actor="reviewer",
                    )

                self.assertIs(result, session)
                self.assertEqual(executed, expected_execution)
                self.assertIsNone(session["runner_state"]["pending_decision"])
                self.assertEqual(session["runner_state"]["last_decision"]["status"], expected_status)
                self.assertEqual(events[-1]["event_type"], "policy_decision_resolved")

    def test_pending_decision_blocks_manual_step(self):
        session = {
            **self._session(),
            "status": "paused",
            "runner_state": {
                "mode": "paused",
                "policy_mode": "approval_required",
                "pending_decision": {"decision_id": "pending-1"},
            },
        }

        with patch.object(paper_runner_service, "_require_db_runner_support", return_value=None), patch.object(
            paper_runner_service,
            "_runner_thread_alive",
            return_value=False,
        ), patch.object(
            paper_runner_service,
            "_require_paper_session",
            return_value=session,
        ), patch.object(
            paper_runner_service,
            "_ensure_session_defaults",
            side_effect=lambda payload: payload,
        ), patch.object(
            paper_runner_service,
            "_apply_default_window",
            side_effect=lambda _session, state: state,
        ):
            with self.assertRaisesRegex(ValueError, "Resolve the pending policy decision"):
                paper_runner_service.step_historical_runner("paper-1")

    def test_pending_approval_survives_restart_and_resolves_once(self):
        decision = decide_with_deterministic_policy(
            build_market_observation(self._session(), self._bar(), signal=1, bar_index=9),
            policy_mode="approval_required",
            created_at="2026-07-18T16:00:01+00:00",
        )
        decision.status = PaperDecisionStatus.PENDING_APPROVAL
        durable = {
            "session": {
                **self._session(),
                "status": "paused",
                "runner_state": {
                    "mode": "paused",
                    "policy_mode": "approval_required",
                    "pending_decision": decision.model_dump(mode="json"),
                },
            }
        }
        executions = []

        def load_durable(_paper_session_id):
            return deepcopy(durable["session"])

        def save_durable(payload):
            durable["session"] = deepcopy(payload)
            return deepcopy(payload)

        with ExitStack() as stack:
            stack.enter_context(patch.object(paper_runner_service, "_require_db_runner_support", return_value=None))
            stack.enter_context(patch.object(paper_runner_service, "_stop_runner_thread", return_value=None))
            stack.enter_context(patch.object(paper_runner_service, "_require_paper_session", side_effect=load_durable))
            stack.enter_context(
                patch.object(paper_runner_service, "_ensure_session_defaults", side_effect=lambda payload: payload)
            )
            stack.enter_context(
                patch.object(paper_runner_service, "_apply_default_window", side_effect=lambda _session, state: state)
            )
            stack.enter_context(patch.object(paper_runner_service, "_save_paper_session_any", side_effect=save_durable))
            stack.enter_context(patch.object(paper_runner_service, "_runner_guardrail_breached", return_value=False))
            stack.enter_context(
                patch.object(
                    paper_runner_service,
                    "execute_paper_session_action",
                    side_effect=lambda _session_id, *, action, **_kwargs: executions.append(action)
                    or load_durable(_session_id),
                )
            )
            stack.enter_context(patch.object(paper_runner_service, "_append_paper_event_any", return_value=None))
            stack.enter_context(
                patch.object(paper_runner_service, "_make_paper_event", side_effect=lambda **payload: payload)
            )
            stack.enter_context(
                patch.object(paper_runner_service, "_require_candidate", return_value={"candidate_id": "cand-1"})
            )
            stack.enter_context(patch.object(paper_runner_service, "_sync_candidate_paper_session", return_value=None))
            stack.enter_context(patch.object(paper_runner_service, "_append_candidate_session_audit", return_value=None))
            stack.enter_context(
                patch.object(paper_runner_service, "_now", return_value="2026-07-18T16:01:00+00:00")
            )

            with self.assertRaisesRegex(ValueError, "Resolve the pending policy decision"):
                paper_runner_service.start_historical_runner("paper-1")

            resolved = paper_runner_service.resolve_pending_policy_decision(
                "paper-1",
                approved=True,
                actor="reviewer-after-restart",
            )
            with self.assertRaisesRegex(ValueError, "no pending policy decision"):
                paper_runner_service.resolve_pending_policy_decision(
                    "paper-1",
                    approved=True,
                    actor="duplicate-retry",
                )

        self.assertEqual(executions, ["lift_ask"])
        self.assertIsNone(durable["session"]["runner_state"]["pending_decision"])
        self.assertEqual(resolved["runner_state"]["last_decision"]["status"], "executed")
        self.assertEqual(resolved["runner_state"]["last_decision"]["resolved_by"], "reviewer-after-restart")


if __name__ == "__main__":
    unittest.main()
