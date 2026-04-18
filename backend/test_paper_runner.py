#!/usr/bin/env python3

import os
import sys
from datetime import datetime
from typing import Callable

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(__file__))

_original_database_url = os.environ.get("DATABASE_URL")
os.environ["DATABASE_URL"] = ""

from main import app
import services.experiment_service as experiment_service
import services.paper_runner_service as paper_runner_service


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _topstep_rules() -> dict:
    return {
        "name": "TopStep 100,000",
        "account_size": 100_000,
        "daily_loss_limit": 0.05,
        "max_drawdown": 0.08,
        "profit_target": 0.08,
        "consistency_rule": True,
        "consistency_threshold": 0.35,
        "drawdown_type": "intraday",
        "min_trading_days": 30,
    }


def _fake_next_factory() -> Callable:
    bars = [
        {"time": "2026-04-17T09:30:00+00:00", "open": 100.0, "high": 100.5, "low": 99.5, "close": 100.0, "volume": 10.0},
        {"time": "2026-04-17T09:31:00+00:00", "open": 100.0, "high": 100.5, "low": 99.5, "close": 100.0, "volume": 10.0},
        {"time": "2026-04-17T09:32:00+00:00", "open": 100.0, "high": 100.5, "low": 99.5, "close": 100.0, "volume": 10.0},
        {"time": "2026-04-17T09:33:00+00:00", "open": 100.0, "high": 101.5, "low": 99.5, "close": 101.0, "volume": 11.0},
        {"time": "2026-04-17T09:34:00+00:00", "open": 101.0, "high": 103.5, "low": 100.5, "close": 103.0, "volume": 13.0},
        {"time": "2026-04-17T09:35:00+00:00", "open": 103.0, "high": 104.5, "low": 102.5, "close": 104.0, "volume": 14.0},
        {"time": "2026-04-17T09:36:00+00:00", "open": 104.0, "high": 103.5, "low": 102.5, "close": 103.0, "volume": 12.0},
        {"time": "2026-04-17T09:37:00+00:00", "open": 103.0, "high": 101.5, "low": 100.5, "close": 101.0, "volume": 15.0},
        {"time": "2026-04-17T09:38:00+00:00", "open": 101.0, "high": 99.5, "low": 98.5, "close": 99.0, "volume": 12.0},
        {"time": "2026-04-17T09:39:00+00:00", "open": 99.0, "high": 98.5, "low": 97.5, "close": 98.0, "volume": 10.0},
        {"time": "2026-04-17T09:40:00+00:00", "open": 98.0, "high": 97.5, "low": 96.5, "close": 97.0, "volume": 9.0},
    ]

    def _to_dt(value: str | None) -> datetime | None:
        if value is None:
            return None
        return datetime.fromisoformat(value.replace("Z", "+00:00"))

    def _fake_next(symbol: str, interval: str = "1min", *, after_time=None, start_date=None, end_date=None):
        _ = symbol, interval
        after_dt = _to_dt(after_time)
        start_dt = _to_dt(start_date)
        end_dt = _to_dt(end_date)

        for bar in bars:
            bar_dt = _to_dt(bar["time"])
            if start_dt and bar_dt < start_dt:
                continue
            if end_dt and bar_dt > end_dt:
                continue
            if after_dt and bar_dt <= after_dt:
                continue
            return bar
        return None

    return _fake_next


def main() -> None:
    original_loader = experiment_service.load_from_db
    original_db_required = experiment_service._db_required
    original_runner_db_configured = paper_runner_service.db_configured
    original_runner_next = paper_runner_service.get_next_ohlcv_bar
    original_spawn = paper_runner_service._spawn_runner_thread

    def fake_load_from_db(symbol: str, interval: str = "15min", start_date=None, end_date=None):
        from services.data_loader import generate_sample_data

        _ = interval, start_date, end_date
        return generate_sample_data(
            name=f"{symbol}_runner_smoke",
            bars=400,
            interval="1min",
            base_price=5000.0,
            seed=11,
        )

    experiment_service.load_from_db = fake_load_from_db
    experiment_service._db_required = lambda: False
    paper_runner_service.db_configured = lambda: True
    paper_runner_service.get_next_ohlcv_bar = _fake_next_factory()
    paper_runner_service._spawn_runner_thread = lambda paper_session_id: None

    try:
        with TestClient(app) as client:
            experiment = client.post(
                "/api/experiments/",
                json={
                    "name": "Runner smoke",
                    "symbols": ["ES"],
                    "intervals": ["1min"],
                    "strategy_type": "ema_crossover",
                    "parameter_space": {"fast_period": [2], "slow_period": [3]},
                    "prop_firm_rules": _topstep_rules(),
                    "initial_balance": 100_000,
                    "position_size": 1.0,
                    "commission": 5.0,
                    "scoring_rule": "prop_score_v1",
                },
            )
            _require(experiment.status_code == 200, f"Experiment create failed: {experiment.text}")
            experiment_id = experiment.json()["experiment_id"]

            run = client.post(f"/api/experiments/{experiment_id}/run")
            _require(run.status_code == 200, f"Experiment run failed: {run.text}")
            top_run_id = run.json()["results"][0]["experiment_run_id"]

            promoted = client.post(f"/api/experiments/{experiment_id}/runs/{top_run_id}/promote")
            _require(promoted.status_code == 200, f"Promote failed: {promoted.text}")
            candidate_id = promoted.json()["candidate_id"]

            drafted = client.post(f"/api/candidates/{candidate_id}/paper-bot", json={"actor": "runner-test"})
            _require(drafted.status_code == 200, f"Paper bot draft failed: {drafted.text}")
            ready = client.patch(
                f"/api/candidates/{candidate_id}/paper-bot/status",
                json={"status": "ready", "actor": "runner-test"},
            )
            _require(ready.status_code == 200, f"Paper bot ready failed: {ready.text}")

            created = client.post(
                f"/api/candidates/{candidate_id}/paper-session",
                json={"actor": "runner-test"},
            )
            _require(created.status_code == 200, f"Paper session create failed: {created.text}")
            paper_session_id = created.json()["paper_session_id"]
            _require(created.json()["status"] == "ready", "Fresh runner test session should start in ready.")

            stepped = client.post(
                f"/api/paper-sessions/{paper_session_id}/runner/step",
                json={"actor": "runner-test", "steps": 9},
            )
            _require(stepped.status_code == 200, f"Runner step failed: {stepped.text}")
            stepped_payload = stepped.json()
            _require(
                stepped_payload["runner_state"]["bars_processed"] == 9,
                "Runner step should process the requested nine bars.",
            )
            _require(
                stepped_payload["runner_state"]["mode"] == "paused",
                "Manual step should leave runner mode paused.",
            )
            _require(
                stepped_payload["runner_state"]["last_signal"] == 0,
                "Runner step should keep the latest flat signal after the ninth bar.",
            )
            _require(
                stepped_payload["runner_state"]["last_signal_action"] == "mark_open_position",
                "Runner step should mark the open short when signal is flat.",
            )
            _require(
                stepped_payload["status"] == "paused",
                "Manual stepping should leave the paper session status paused.",
            )
            _require(
                stepped_payload["last_bar_time"] == "2026-04-17T09:38:00+00:00",
                "Runner cursor should advance to the ninth stepped bar.",
            )
            _require(
                len(stepped_payload["trade_log"]) == 1,
                "Runner should close one long trade when the bearish flip arrives.",
            )
            _require(
                stepped_payload["trade_log"][0]["side"] == "buy",
                "The closed trade should be the long opened on bullish crossover.",
            )
            _require(
                stepped_payload["current_position"]["side"] == "sell",
                "Runner should hold a short after bearish flip and follow-up mark.",
            )
            _require(
                stepped_payload["current_position"]["unrealized_pnl"] > 0,
                "Short position should be marked positive after price drops.",
            )

            started = client.post(
                f"/api/paper-sessions/{paper_session_id}/runner/start",
                json={
                    "actor": "runner-test",
                    "start_date": "2026-04-17T09:30:00+00:00",
                    "end_date": "2026-04-17T09:40:00+00:00",
                    "poll_interval_ms": 500,
                    "reset_cursor": True,
                },
            )
            _require(started.status_code == 200, f"Runner start failed: {started.text}")
            _require(started.json()["runner_state"]["mode"] == "running", "Runner start should set running mode.")
            _require(started.json()["status"] == "running", "Runner start should move session to running.")

            paused = client.post(
                f"/api/paper-sessions/{paper_session_id}/runner/pause",
                json={"actor": "runner-test"},
            )
            _require(paused.status_code == 200, f"Runner pause failed: {paused.text}")
            _require(paused.json()["runner_state"]["mode"] == "paused", "Runner pause should set paused mode.")
            _require(paused.json()["status"] == "paused", "Runner pause should move session to paused.")
    finally:
        experiment_service.load_from_db = original_loader
        experiment_service._db_required = original_db_required
        paper_runner_service.db_configured = original_runner_db_configured
        paper_runner_service.get_next_ohlcv_bar = original_runner_next
        paper_runner_service._spawn_runner_thread = original_spawn
        if _original_database_url is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = _original_database_url


if __name__ == "__main__":
    main()
