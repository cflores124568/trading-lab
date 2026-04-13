#!/usr/bin/env python3

import os
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(__file__))

_original_database_url = os.environ.get("DATABASE_URL")
os.environ["DATABASE_URL"] = ""

from main import app
import services.experiment_service as experiment_service


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


def main() -> None:
    """Smoke the experiment API without needing a real TimescaleDB instance.

    I patch the dataset loader just for this script so Phase 1 can prove the
    orchestration layer works locally even when the DB-backed symbol loader
    isn't available on this machine.
    """
    print("=" * 60)
    print(" Trading Lab - Experiment API Smoke Test")
    print("=" * 60)

    original_loader = experiment_service.load_from_db
    original_db_required = experiment_service._db_required

    def fake_load_from_db(symbol: str, interval: str = "15min", start_date=None, end_date=None):
        from services.data_loader import generate_sample_data

        return generate_sample_data(
            name=f"{symbol}_{interval}_experiment_smoke",
            bars=1800,
            interval="1min",
            base_price=5200.0 if symbol == "ES" else 18000.0,
            seed=42 if symbol == "ES" else 7,
        )

    experiment_service.load_from_db = fake_load_from_db
    experiment_service._db_required = lambda: False

    try:
        with TestClient(app) as client:
            print("\n[1/4] Creating a saved experiment spec ...")
            payload = {
                "name": "Phase 1 experiment smoke",
                "symbols": ["ES", "NQ"],
                "intervals": ["15m"],
                "strategy_type": "ema_crossover",
                "parameter_space": {
                    "fast_period": [9, 12],
                    "slow_period": [21],
                },
                "prop_firm_rules": _topstep_rules(),
                "initial_balance": 100_000,
                "position_size": 1.0,
                "commission": 5.0,
                "scoring_rule": "prop_score_v1",
            }
            created = client.post("/api/experiments/", json=payload)
            _require(created.status_code == 200, f"Experiment create failed: {created.text}")
            experiment = created.json()
            experiment_id = experiment["experiment_id"]
            _require(experiment["status"] == "draft", "New experiment should start as draft.")
            print(f"      Experiment id: {experiment_id}")

            print("\n[2/4] Listing and reading the saved experiment ...")
            listed = client.get("/api/experiments/")
            _require(listed.status_code == 200, f"Experiment list failed: {listed.text}")
            _require(
                any(item["experiment_id"] == experiment_id for item in listed.json()),
                "Created experiment did not show up in list output.",
            )
            detail = client.get(f"/api/experiments/{experiment_id}")
            _require(detail.status_code == 200, f"Experiment detail failed: {detail.text}")

            print("\n[3/4] Running the batch and checking ranked results ...")
            run = client.post(f"/api/experiments/{experiment_id}/run")
            _require(run.status_code == 200, f"Experiment run failed: {run.text}")
            payload = run.json()
            _require(payload["experiment"]["status"] == "completed", "Experiment did not finish as completed.")
            _require(payload["experiment"]["completed_runs"] == 4, "Experiment should have completed four runs.")
            _require(len(payload["results"]) == 4, "Run endpoint returned the wrong number of results.")
            _require(payload["results"][0]["rank"] == 1, "Top result did not get rank 1.")
            _require(payload["results"][0]["backtest_id"], "Completed run is missing backtest linkage.")
            print(f"      Ranked runs: {len(payload['results'])}")

            print("\n[4/4] Reading persisted results from the results endpoint ...")
            results = client.get(f"/api/experiments/{experiment_id}/results")
            _require(results.status_code == 200, f"Experiment results failed: {results.text}")
            _require(len(results.json()) == 4, "Results endpoint returned the wrong number of rows.")
            print("      Results endpoint still lines up with the saved batch.")
    finally:
        experiment_service.load_from_db = original_loader
        experiment_service._db_required = original_db_required
        if _original_database_url is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = _original_database_url

    print("\n" + "=" * 60)
    print(" Smoke test complete")
    print("=" * 60)


if __name__ == "__main__":
    main()
