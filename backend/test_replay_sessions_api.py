"""Replay sizing API contracts, isolated from live storage and app startup."""
import unittest
from copy import deepcopy
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers import replay_sessions
from services.replay_session_store import delete_replay_session
from test_replay_sessions import _payload


class ReplaySizingApiTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(replay_sessions.router, prefix="/api/replay-sessions")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.storage = {}
        self.db_mode = patch.object(replay_sessions, "_db_required", return_value=True)
        self.db_mode.start()
        self.addCleanup(self.db_mode.stop)
        for name, replacement in (
            ("save_replay_session", lambda result: self.storage.update({result["replay_session_id"]: deepcopy(result)})),
            ("get_replay_session_db", lambda session_id: deepcopy(self.storage.get(session_id))),
        ):
            mock = patch.object(replay_sessions, name, side_effect=replacement)
            mock.start()
            self.addCleanup(mock.stop)

    def create(self, payload):
        response = self.client.post("/api/replay-sessions/", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        session = response.json()
        self.addCleanup(delete_replay_session, session["replay_session_id"])
        return session

    def test_risk_settings_survive_create_get_and_update(self):
        payload = _payload(sizing_mode="risk_percent", risk_per_trade_pct=0.5,
                           max_position_size=3, stop_loss_ticks=8)
        created = self.create(payload)
        session_id = created["replay_session_id"]
        loaded = self.client.get(f"/api/replay-sessions/{session_id}")
        self.assertEqual(loaded.status_code, 200, loaded.text)
        self.assertEqual(loaded.json(), created)
        updated_payload = dict(payload, stop_loss_ticks=None, stop_loss_atr=1.5, atr_period=21,
                               risk_per_trade_pct=0.75, max_position_size=4)
        updated = self.client.put(f"/api/replay-sessions/{session_id}", json=updated_payload)
        self.assertEqual(updated.status_code, 200, updated.text)
        reloaded = self.client.get(f"/api/replay-sessions/{session_id}").json()
        self.assertEqual(reloaded, updated.json())
        self.assertEqual(reloaded["stop_loss_atr"], 1.5)
        self.assertEqual(reloaded["atr_period"], 21)
        self.assertEqual(reloaded["risk_per_trade_pct"], 0.75)
        self.assertEqual(reloaded["max_position_size"], 4)
        self.assertEqual(reloaded["created_at"], created["created_at"])

    def test_legacy_fixed_payload_remains_valid(self):
        created = self.create(_payload())
        self.assertEqual(created["sizing_mode"], "fixed")
        self.assertIsNone(created["risk_per_trade_pct"])
        self.assertIsNone(created["stop_loss_ticks"])

    def test_invalid_sizing_returns_422_before_persistence(self):
        for fields in (
            {"position_size": 1.5}, {"position_size": 0},
            {"sizing_mode": "risk_percent", "risk_per_trade_pct": 1},
            {"sizing_mode": "risk_percent", "risk_per_trade_pct": 1, "stop_loss_ticks": 8, "max_position_size": 1.5},
        ):
            with self.subTest(fields=fields):
                response = self.client.post("/api/replay-sessions/", json=_payload(**fields))
                self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.storage, {})


if __name__ == "__main__":
    unittest.main()
