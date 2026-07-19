import copy
import unittest

from services.paper_policy_service import build_market_observation, decide_with_deterministic_policy
from services.paper_risk_service import assess_pretrade_risk


class PaperRiskServiceTests(unittest.TestCase):
    def _bar(self):
        return {
            "time": "2019-01-02T06:20:00+00:00",
            "open": 6202.0,
            "high": 6204.5,
            "low": 6198.25,
            "close": 6199.75,
            "volume": 593.0,
        }

    def _session(self):
        return {
            "paper_session_id": "paper-1",
            "candidate_id": "cand-1",
            "symbol": "NQ",
            "interval": "5m",
            "last_bar_time": "2019-01-02T06:20:00+00:00",
            "last_quote": {"bid": 6199.5, "ask": 6200.25, "reference": 6199.75},
            "current_position": {},
            "active_orders": [],
            "metrics_snapshot": {},
            "guardrail_state": {
                "daily_loss_breached": False,
                "drawdown_breached": False,
            },
            "guardrails": {"max_position_size": 1, "autonomous_order_quantity": 1},
            "runner_state": {
                "kill_switch_engaged": False,
                "pending_decision": None,
            },
        }

    def _decision(self, session=None):
        source = session or self._session()
        observation = build_market_observation(source, self._bar(), signal=1, bar_index=148)
        return decide_with_deterministic_policy(
            observation,
            policy_mode="autonomous_paper",
            created_at="2026-07-19T05:00:00+00:00",
        )

    def test_clean_autonomous_trade_intent_is_approved(self):
        session = self._session()
        assessment = assess_pretrade_risk(
            session,
            self._decision(session),
            checked_at="2026-07-19T05:00:00+00:00",
        )

        self.assertEqual(assessment.status, "approved")
        self.assertEqual(assessment.violations, [])
        self.assertTrue(all(check.passed for check in assessment.checks))

    def test_each_hard_pretrade_rule_returns_an_explicit_block(self):
        cases = {
            "kill_switch": lambda session: session["runner_state"].update(kill_switch_engaged=True),
            "daily_loss": lambda session: session["guardrail_state"].update(daily_loss_breached=True),
            "stale_market": lambda session: session.update(last_bar_time="2019-01-02T06:15:00+00:00"),
            "resting_order": lambda session: session.update(active_orders=[{"id": "order-1"}]),
            "exposure": lambda session: session["guardrails"].update(max_position_size=0.5),
            "session_hours": lambda session: session["guardrails"].update(
                session_start_utc="07:00", session_end_utc="20:00"
            ),
        }

        for name, mutate in cases.items():
            with self.subTest(rule=name):
                session = copy.deepcopy(self._session())
                mutate(session)
                assessment = assess_pretrade_risk(
                    session,
                    self._decision(session),
                    checked_at="2026-07-19T05:00:00+00:00",
                )

                self.assertEqual(assessment.status, "blocked")
                self.assertTrue(assessment.violations)
                self.assertTrue(any(not check.passed for check in assessment.checks))


if __name__ == "__main__":
    unittest.main()
