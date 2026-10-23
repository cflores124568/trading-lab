import unittest

from schemas import BacktestRunConfig
from services.backtest_repo import _hydrate_run_config


class BacktestRepoHydrationTests(unittest.TestCase):
    def _row(self, run_config: dict) -> dict:
        return {
            "run_config": run_config,
            "prop_firm_rules": {"account_size": 100_000},
            "trades": [],
        }

    def test_hydrates_sizing_and_dynamic_exit_fields(self):
        config = _hydrate_run_config(
            self._row(
                {
                    "initial_balance": 50_000,
                    "position_size": 2,
                    "sizing_mode": "risk_percent",
                    "risk_per_trade_pct": 1.5,
                    "max_position_size": 4,
                    "commission": 2.5,
                    "tick_size": 0.25,
                    "tick_value": 12.5,
                    "slippage_ticks": 0,
                    "stop_loss_ticks": 8,
                    "take_profit_atr": 3.0,
                    "trailing_stop_atr": 2.0,
                    "trailing_activation_r": 1.5,
                    "breakeven_at_r": 1.0,
                    "time_stop_bars": 12,
                    "exit_at_session_end": True,
                }
            )
        )

        validated = BacktestRunConfig(**config)
        self.assertEqual(validated.position_size, 2)
        self.assertEqual(validated.sizing_mode, "risk_percent")
        self.assertEqual(validated.risk_per_trade_pct, 1.5)
        self.assertEqual(validated.max_position_size, 4)
        self.assertEqual(validated.stop_loss_ticks, 8)
        self.assertEqual(validated.take_profit_atr, 3.0)
        self.assertEqual(validated.trailing_stop_atr, 2.0)
        self.assertEqual(validated.trailing_activation_r, 1.5)
        self.assertEqual(validated.breakeven_at_r, 1.0)
        self.assertEqual(validated.time_stop_bars, 12)
        self.assertTrue(validated.exit_at_session_end)

    def test_floors_legacy_fractional_position_size(self):
        config = _hydrate_run_config(
            self._row(
                {
                    "position_size": 2.75,
                    "sizing_mode": "fixed",
                }
            )
        )

        self.assertEqual(config["position_size"], 2)
        self.assertEqual(BacktestRunConfig(**config).position_size, 2)


if __name__ == "__main__":
    unittest.main()
