#!/usr/bin/env python3

import os
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(__file__))

from main import app
from services.backtest_store import delete_backtest
from services.dataset_store import delete_dataset


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
    """Run one API smoke pass across the backtest persistence flow.

    This stays intentionally lightweight and hits the real FastAPI routes with
    a generated sample dataset, so we can prove the create/list/detail path is
    wired up without needing a whole pytest conversion yet.
    """
    print("=" * 60)
    print(" Trading Lab - Backtest API Smoke Test")
    print("=" * 60)

    with TestClient(app) as client:
        print("\n[1/5] Creating sample dataset through the API ...")
        sample = client.post(
            "/api/data/sample",
            params={"name": "ES_smoke_api", "bars": 2000, "interval": "1min", "seed": 42},
        )
        _require(sample.status_code == 200, f"Sample dataset failed: {sample.text}")
        sample_info = sample.json()
        dataset_id = sample_info["dataset_id"]
        print(f"      Dataset id: {dataset_id}")
        print(f"      Rows: {sample_info['rows']}")

        if os.getenv("DATABASE_URL"):
            print("\n[2/6] Clearing in-memory dataset and checking durable dataset_id ...")
            removed_dataset = delete_dataset(dataset_id)
            _require(removed_dataset, "Could not remove the in-memory dataset before registry check.")

            dataset_info = client.get(f"/api/data/{dataset_id}")
            _require(dataset_info.status_code == 200, f"Dataset registry read failed: {dataset_info.text}")

            dataset_candles = client.get(f"/api/data/{dataset_id}/candles")
            _require(dataset_candles.status_code == 200, f"Dataset rehydrate failed: {dataset_candles.text}")
            _require(len(dataset_candles.json()) > 0, "Rehydrated dataset returned no candles.")
            print("      Dataset registry + rehydrate path still works.")
        else:
            print("\n[2/6] Skipping dataset registry check because DATABASE_URL is not set.")

        print("\n[3/6] Running a backtest through POST /api/backtests ...")
        payload = {
            "dataset_id": dataset_id,
            "strategy": {
                "type": "ma_crossover",
                "params": {"fast_period": 9, "slow_period": 21},
            },
            "prop_firm_rules": _topstep_rules(),
            "initial_balance": 100_000,
            "position_size": 1.0,
            "commission": 5.0,
        }
        created = client.post("/api/backtests/", json=payload)
        _require(created.status_code == 200, f"Backtest create failed: {created.text}")
        backtest = created.json()
        backtest_id = backtest.get("backtest_id")
        _require(bool(backtest_id), "Backtest response did not include backtest_id.")
        _require(backtest["dataset_id"] == dataset_id, "Backtest dataset_id did not match sample dataset.")
        print(f"      Backtest id: {backtest_id}")
        print(f"      Trades: {len(backtest['trades'])}")

        print("\n[4/6] Checking GET /api/backtests list output ...")
        listed = client.get("/api/backtests/")
        _require(listed.status_code == 200, f"Backtest list failed: {listed.text}")
        summaries = listed.json()
        summary = next((item for item in summaries if item["backtest_id"] == backtest_id), None)
        _require(summary is not None, "Created backtest did not show up in the list endpoint.")
        print(f"      List entries: {len(summaries)}")

        print("\n[5/7] Checking GET /api/backtests/{id} detail output ...")
        detail = client.get(f"/api/backtests/{backtest_id}")
        _require(detail.status_code == 200, f"Backtest detail failed: {detail.text}")
        detail_payload = detail.json()
        _require(detail_payload["backtest_id"] == backtest_id, "Detail endpoint returned the wrong backtest.")
        _require(detail_payload["metrics"]["total_trades"] >= 0, "Detail endpoint returned invalid metrics.")
        _require(detail_payload["run_config"]["position_size"] == 1.0, "Detail endpoint lost the saved run config.")
        print(f"      Detail status: {detail_payload['status']}")

        print("\n[6/7] Checking GET /api/backtests/{id}/candles replay output ...")
        candles = client.get(f"/api/backtests/{backtest_id}/candles")
        _require(candles.status_code == 200, f"Backtest candles failed: {candles.text}")
        candle_payload = candles.json()
        _require(len(candle_payload) > 0, "Replay candles endpoint returned no bars.")
        print(f"      Replay candles: {len(candle_payload)}")

        print("\n[7/7] Checking GET /api/backtests/{id}/robustness output ...")
        robustness = client.get(f"/api/backtests/{backtest_id}/robustness")
        _require(robustness.status_code == 200, f"Backtest robustness failed: {robustness.text}")
        robustness_payload = robustness.json()
        _require(robustness_payload["backtest_id"] == backtest_id, "Robustness endpoint returned the wrong backtest.")
        _require(len(robustness_payload["monte_carlo"]) >= 1, "Robustness endpoint returned no Monte Carlo scenarios.")
        _require(robustness_payload["parameter_sweep"]["total_runs"] >= 1, "Parameter sweep returned no runs.")
        print(f"      Monte Carlo scenarios: {len(robustness_payload['monte_carlo'])}")

        if os.getenv("DATABASE_URL"):
            print("\n[7/7b] Clearing in-memory copy and checking persisted read path ...")
            removed = delete_backtest(backtest_id)
            _require(removed, "Could not remove the in-memory backtest before DB fallback check.")

            listed = client.get("/api/backtests/")
            _require(listed.status_code == 200, f"Persisted list read failed: {listed.text}")
            summaries = listed.json()
            summary = next((item for item in summaries if item["backtest_id"] == backtest_id), None)
            _require(summary is not None, "Persisted backtest did not survive the in-memory clear on list.")

            detail = client.get(f"/api/backtests/{backtest_id}")
            _require(detail.status_code == 200, f"Persisted detail read failed: {detail.text}")
            detail_payload = detail.json()
            _require(
                detail_payload["backtest_id"] == backtest_id,
                "Persisted detail endpoint returned the wrong backtest after in-memory clear.",
            )
            print("      DB-backed list/detail path still works.")

    print("\n" + "=" * 60)
    print(" Smoke test complete")
    print("=" * 60)


if __name__ == "__main__":
    main()
