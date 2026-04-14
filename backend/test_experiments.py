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

            print("\n[4/6] Reading persisted results from the results endpoint ...")
            results = client.get(f"/api/experiments/{experiment_id}/results")
            _require(results.status_code == 200, f"Experiment results failed: {results.text}")
            _require(len(results.json()) == 4, "Results endpoint returned the wrong number of rows.")
            print("      Results endpoint still lines up with the saved batch.")

            print("\n[5/6] Promoting the top ranked run into a candidate ...")
            top_run_id = payload["results"][0]["experiment_run_id"]
            promote = client.post(f"/api/experiments/{experiment_id}/runs/{top_run_id}/promote")
            _require(promote.status_code == 200, f"Experiment promote failed: {promote.text}")
            _require(promote.json()["is_candidate"] is True, "Promoted run should be marked as a candidate.")
            _require(promote.json()["promoted_at"], "Promoted run should keep the promotion timestamp.")
            _require(promote.json()["candidate_id"], "Promoted run should point at a saved candidate.")

            persisted = client.get(f"/api/experiments/{experiment_id}/results")
            _require(persisted.status_code == 200, f"Candidate results reload failed: {persisted.text}")
            _require(persisted.json()[0]["is_candidate"] is True, "Candidate flag did not persist to results.")
            print("      Candidate flag persisted on the saved ranked run.")

            print("\n[6/6] Walking the candidate review + paper stub flow ...")
            candidates = client.get("/api/candidates/")
            _require(candidates.status_code == 200, f"Candidate list failed: {candidates.text}")
            _require(len(candidates.json()) == 1, "Expected exactly one candidate after promotion.")
            candidate = candidates.json()[0]
            candidate_id = candidate["candidate_id"]
            _require(candidate["experiment_id"] == experiment_id, "Candidate lost its experiment provenance.")
            _require(candidate["backtest_id"] == payload["results"][0]["backtest_id"], "Candidate lost its backtest link.")
            _require(candidate["lifecycle_status"] == "candidate", "Fresh candidate should start in candidate state.")

            approved = client.patch(
                f"/api/candidates/{candidate_id}/status",
                json={"status": "approved", "actor": "smoke-test"},
            )
            _require(approved.status_code == 200, f"Candidate approve failed: {approved.text}")
            _require(approved.json()["approved_at"], "Approved candidate should keep an approval timestamp.")
            _require(approved.json()["approved_by"] == "smoke-test", "Approval actor should be saved.")

            noted = client.post(
                f"/api/candidates/{candidate_id}/notes",
                json={"body": "looks good enough for paper draft", "author": "smoke-test"},
            )
            _require(noted.status_code == 200, f"Candidate note failed: {noted.text}")
            _require(len(noted.json()["notes"]) == 1, "Candidate note did not persist.")

            drafted = client.post(
                f"/api/candidates/{candidate_id}/paper-bot",
                json={"actor": "smoke-test"},
            )
            _require(drafted.status_code == 200, f"Paper bot draft create failed: {drafted.text}")
            _require(drafted.json()["paper_bot"]["status"] == "draft", "Paper bot should start as draft.")

            ready = client.patch(
                f"/api/candidates/{candidate_id}/paper-bot/status",
                json={"status": "ready", "actor": "smoke-test"},
            )
            _require(ready.status_code == 200, f"Paper bot ready failed: {ready.text}")
            _require(ready.json()["lifecycle_status"] == "paper_ready", "Candidate should move into paper_ready.")

            running = client.patch(
                f"/api/candidates/{candidate_id}/paper-bot/status",
                json={"status": "paper_running", "actor": "smoke-test"},
            )
            _require(running.status_code == 200, f"Paper bot start failed: {running.text}")
            _require(running.json()["lifecycle_status"] == "paper_running", "Candidate should move into paper_running.")

            paused = client.patch(
                f"/api/candidates/{candidate_id}/paper-bot/status",
                json={"status": "stopped", "actor": "smoke-test"},
            )
            _require(paused.status_code == 200, f"Paper bot stop failed: {paused.text}")
            _require(paused.json()["lifecycle_status"] == "paper_paused", "Stopped paper bot should map to paper_paused.")
            _require(len(paused.json()["audit_log"]) >= 5, "Candidate audit log should capture the review flow.")
            print("      Candidate review state, notes, and paper handoff all persisted.")
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
