#!/usr/bin/env python3

import os
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(__file__))

from main import app
from services.backtest_store import delete_backtest


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _ftmo_rules() -> dict:
    return {
        "name": "FTMO",
        "account_size": 100_000,
        "daily_loss_limit": 0.05,
        "max_drawdown": 0.10,
        "profit_target": 0.10,
        "consistency_rule": True,
        "consistency_threshold": 0.30,
        "drawdown_type": "eod",
        "min_trading_days": None,
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

        print("\n[2/5] Running a backtest through POST /api/backtests ...")
        payload = {
            "dataset_id": dataset_id,
            "strategy": {
                "type": "ma_crossover",
                "params": {"fast_period": 9, "slow_period": 21},
            },
            "prop_firm_rules": _ftmo_rules(),
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

        print("\n[3/5] Checking GET /api/backtests list output ...")
        listed = client.get("/api/backtests/")
        _require(listed.status_code == 200, f"Backtest list failed: {listed.text}")
        summaries = listed.json()
        summary = next((item for item in summaries if item["backtest_id"] == backtest_id), None)
        _require(summary is not None, "Created backtest did not show up in the list endpoint.")
        print(f"      List entries: {len(summaries)}")

        print("\n[4/5] Checking GET /api/backtests/{id} detail output ...")
        detail = client.get(f"/api/backtests/{backtest_id}")
        _require(detail.status_code == 200, f"Backtest detail failed: {detail.text}")
        detail_payload = detail.json()
        _require(detail_payload["backtest_id"] == backtest_id, "Detail endpoint returned the wrong backtest.")
        _require(detail_payload["metrics"]["total_trades"] >= 0, "Detail endpoint returned invalid metrics.")
        print(f"      Detail status: {detail_payload['status']}")

        if os.getenv("DATABASE_URL"):
            print("\n[5/5] Clearing in-memory copy and checking persisted read path ...")
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
        else:
            print("\n[5/5] Skipping DB fallback check because DATABASE_URL is not set.")

    print("\n" + "=" * 60)
    print(" Smoke test complete")
    print("=" * 60)


if __name__ == "__main__":
    main()
