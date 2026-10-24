import unittest
import re
from unittest.mock import MagicMock, patch

from pydantic import ValidationError

from schemas import ReplaySessionBase, ReplaySessionResult
from services import replay_session_repo as repo


def _payload(**overrides):
    payload = {
        "name": "Replay sizing test",
        "symbol": "MES",
        "interval": "1h",
        "prop_firm_rules": {"name": "Test Firm", "account_size": 100_000},
        "commission": 5,
        "tick_value": 5,
        "tick_size": 0.25,
        "position_size": 1,
        "metrics": {
            "total_trades": 0,
            "winning_trades": 0,
            "losing_trades": 0,
            "win_rate": 0,
            "total_pnl": 0,
            "average_pnl": 0,
            "profit_factor": 0,
            "max_drawdown": 0,
            "sharpe_ratio": 0,
            "sortino_ratio": 0,
            "avg_trade_duration": 0,
            "best_trade": 0,
            "worst_trade": 0,
        },
        "prop_firm_eval": {
            "passed": False,
            "daily_loss_breached": False,
            "drawdown_breached": False,
            "profit_target_hit": False,
            "consistency_passed": False,
            "details": {},
        },
    }
    payload.update(overrides)
    return payload


class ReplaySizingSchemaTests(unittest.TestCase):
    def test_accepts_risk_sizing_with_a_tick_stop(self):
        session = ReplaySessionBase(
            **_payload(
                sizing_mode="risk_percent",
                risk_per_trade_pct=0.5,
                max_position_size=3,
                stop_loss_ticks=8,
            )
        )

        self.assertEqual(session.sizing_mode, "risk_percent")
        self.assertEqual(session.risk_per_trade_pct, 0.5)
        self.assertEqual(session.max_position_size, 3)
        self.assertEqual(session.stop_loss_ticks, 8)

    def test_accepts_risk_sizing_with_an_atr_stop(self):
        session = ReplaySessionBase(
            **_payload(
                sizing_mode="risk_percent",
                risk_per_trade_pct=1,
                stop_loss_atr=1.5,
                atr_period=21,
            )
        )

        self.assertEqual(session.stop_loss_atr, 1.5)
        self.assertEqual(session.atr_period, 21)

    def test_rejects_risk_sizing_without_a_stop(self):
        with self.assertRaises(ValidationError):
            ReplaySessionBase(
                **_payload(
                    sizing_mode="risk_percent",
                    risk_per_trade_pct=1,
                )
            )

    def test_rejects_risk_fields_on_fixed_sizing(self):
        with self.assertRaises(ValidationError):
            ReplaySessionBase(
                **_payload(
                    sizing_mode="fixed",
                    risk_per_trade_pct=1,
                )
            )

    def test_rejects_two_stop_bases(self):
        with self.assertRaises(ValidationError):
            ReplaySessionBase(
                **_payload(
                    sizing_mode="risk_percent",
                    risk_per_trade_pct=1,
                    stop_loss_ticks=8,
                    stop_loss_atr=1.5,
                )
            )


class ReplayPersistenceTests(unittest.TestCase):
    def test_save_and_hydrate_risk_settings_trades_and_metrics(self):
        payload = _payload(
            sizing_mode="risk_percent", risk_per_trade_pct=0.1,
            max_position_size=3, stop_loss_atr=1.5, atr_period=21,
            trades=[{
                "trade_id": 0, "entry_time": "2026-10-22T12:00:00",
                "exit_time": "2026-10-22T12:01:00", "side": "buy",
                "entry_price": 100, "exit_price": 98, "pnl": -15,
                "status": "closed", "commission": 5, "quantity": 1,
                "initial_risk": 15, "risk_budget": 10, "r_multiple": -1,
                "risk_exceeded": True,
            }],
        )
        payload["metrics"].update(avg_r_multiple=-1, total_r=-1, r_profit_factor=0,
                                  risk_budget_exceeded_trades=1)
        result = ReplaySessionResult(**payload, replay_session_id="test-risk-roundtrip",
                                     created_at="2026-10-22T12:00:00", updated_at="2026-10-22T12:01:00").model_dump(mode="json")
        conn = MagicMock()
        with patch("services.db._conn") as connect, patch.object(repo, "_ensure_replay_sessions_schema"):
            connect.return_value.__enter__.return_value = conn
            repo.save_replay_session(result)
        sql, values = conn.cursor.return_value.__enter__.return_value.execute.call_args.args
        self.assertEqual(sql.count("%s"), len(values))
        columns = re.search(r"INSERT INTO replay_sessions \((.*?)\)\s*VALUES", sql, re.S).group(1)
        columns = [column.strip() for column in columns.split(",")]
        self.assertEqual(len(columns), len(values))
        hydrated = ReplaySessionResult(**repo._row_to_result(dict(zip(columns, values)))).model_dump(mode="json")
        self.assertEqual(hydrated, result)
        conn.commit.assert_called_once()

    def test_legacy_sessions_default_to_fixed_and_tolerate_nullable_db_values(self):
        row = dict(_payload(), replay_session_id="legacy", start_date=None, end_date=None,
                   current_bar_index=0, status="paused", actions=[], trades=[], equity_curve=[],
                   created_at="2026-10-22T12:00:00", updated_at="2026-10-22T12:00:00")
        for name in ("risk_per_trade_pct", "max_position_size", "stop_loss_ticks", "stop_loss_atr", "atr_period"):
            row[name] = float("nan")
        session = ReplaySessionResult(**repo._row_to_result(row))
        self.assertEqual(session.sizing_mode, "fixed")
        self.assertIsNone(session.risk_per_trade_pct)
        self.assertIsNone(session.max_position_size)
        self.assertEqual(session.atr_period, 14)

    def test_schema_upgrades_are_additive(self):
        conn = MagicMock()
        with patch.object(repo, "_schema_ready", False):
            repo._ensure_replay_sessions_schema(conn)
        statements = [call.args[0] for call in conn.cursor.return_value.__enter__.return_value.execute.call_args_list]
        for column in ("sizing_mode", "risk_per_trade_pct", "max_position_size", "stop_loss_ticks", "stop_loss_atr", "atr_period"):
            self.assertTrue(any(f"ADD COLUMN IF NOT EXISTS {column} " in sql for sql in statements), column)
        self.assertFalse(any("DROP " in sql or "DELETE " in sql for sql in statements))


class ReplayContractValidationTests(unittest.TestCase):
    def test_rejects_fractional_and_nonpositive_contracts(self):
        for size in (0, -1, 1.5):
            with self.subTest(size=size), self.assertRaises(ValidationError):
                ReplaySessionBase(**_payload(position_size=size))
            with self.subTest(cap=size), self.assertRaises(ValidationError):
                ReplaySessionBase(**_payload(sizing_mode="risk_percent", risk_per_trade_pct=1,
                                            stop_loss_ticks=8, max_position_size=size))

    def test_rejects_invalid_risk_percent_and_missing_percent(self):
        for risk in (None, 0, -1, 101):
            with self.subTest(risk=risk), self.assertRaises(ValidationError):
                ReplaySessionBase(**_payload(sizing_mode="risk_percent", risk_per_trade_pct=risk, stop_loss_ticks=8))


if __name__ == "__main__":
    unittest.main()
