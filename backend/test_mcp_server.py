import json
import unittest
from unittest.mock import patch

from mcp.shared.memory import create_connected_server_and_client_session

from mcp_server import mcp
from services import mcp_control_service, mcp_read_service


class MCPServerProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_server_advertises_only_the_phase_3d_read_and_note_tools(self):
        async with create_connected_server_and_client_session(mcp, raise_exceptions=True) as client:
            result = await client.list_tools()

        self.assertEqual(
            {tool.name for tool in result.tools},
            {
                "list_candidates",
                "get_candidate",
                "list_paper_sessions",
                "get_paper_session",
                "list_policy_decisions",
                "add_operator_note",
            },
        )

    async def test_operator_note_schema_requires_an_idempotency_key(self):
        async with create_connected_server_and_client_session(mcp, raise_exceptions=True) as client:
            result = await client.list_tools()

        tool = next(tool for tool in result.tools if tool.name == "add_operator_note")
        self.assertEqual(
            set(tool.inputSchema["required"]),
            {"paper_session_id", "note", "idempotency_key"},
        )

    async def test_server_advertises_indexes_and_detail_resource_templates(self):
        async with create_connected_server_and_client_session(mcp, raise_exceptions=True) as client:
            resources = await client.list_resources()
            templates = await client.list_resource_templates()

        self.assertEqual(
            {str(resource.uri) for resource in resources.resources},
            {"trading-lab://candidates", "trading-lab://paper-sessions"},
        )
        self.assertEqual(
            {template.uriTemplate for template in templates.resourceTemplates},
            {
                "trading-lab://candidate/{candidate_id}",
                "trading-lab://paper-session/{paper_session_id}",
                "trading-lab://paper-session/{paper_session_id}/policy-decisions",
            },
        )

    async def test_structured_candidate_tool_call_uses_the_read_service(self):
        candidates = [
            {
                "candidate_id": "candidate-1",
                "symbol": "NQ",
                "interval": "5m",
                "strategy_type": "ema_crossover",
                "lifecycle_status": "approved",
            }
        ]
        with patch.object(mcp_read_service, "list_candidates_any", return_value=candidates):
            async with create_connected_server_and_client_session(mcp, raise_exceptions=True) as client:
                result = await client.call_tool(
                    "list_candidates",
                    {"lifecycle_status": "approved", "limit": 10},
                )

        self.assertFalse(result.isError)
        self.assertEqual(result.structuredContent["count"], 1)
        self.assertEqual(
            result.structuredContent["items"][0]["candidate_id"],
            "candidate-1",
        )

    async def test_candidate_resource_returns_json_from_the_same_read_service(self):
        candidate = {
            "candidate_id": "candidate-1",
            "symbol": "NQ",
            "interval": "5m",
            "strategy_type": "ema_crossover",
            "lifecycle_status": "approved",
            "notes": [],
            "audit_log": [],
        }
        with patch.object(mcp_read_service, "get_candidate_any", return_value=candidate):
            async with create_connected_server_and_client_session(mcp, raise_exceptions=True) as client:
                result = await client.read_resource("trading-lab://candidate/candidate-1")

        payload = json.loads(result.contents[0].text)
        self.assertEqual(payload["candidate_id"], "candidate-1")
        self.assertEqual(payload["symbol"], "NQ")

    async def test_operator_note_protocol_persists_the_mcp_actor_and_replays_exactly(self):
        session = {"paper_session_id": "paper-protocol-1", "candidate_id": "candidate-1"}
        arguments = {
            "paper_session_id": "paper-protocol-1",
            "note": "Reviewed the paused paper session.",
            "idempotency_key": "protocol-note-1",
        }
        with patch.object(mcp_control_service, "_db_required", return_value=False), patch.object(
            mcp_control_service,
            "get_paper_session_any",
            return_value=session,
        ), patch.object(mcp_control_service, "_now", return_value="2026-07-19T06:00:00+00:00"):
            async with create_connected_server_and_client_session(mcp, raise_exceptions=True) as client:
                first = await client.call_tool("add_operator_note", arguments)
                retry = await client.call_tool("add_operator_note", arguments)

        self.assertFalse(first.isError)
        self.assertEqual(first.structuredContent, retry.structuredContent)
        self.assertEqual(first.structuredContent["actor"], "mcp-operator")
        self.assertEqual(first.structuredContent["event_type"], "operator_note_added")
        self.assertEqual(first.structuredContent["payload"]["scope"], "paper")
        self.assertEqual(
            first.structuredContent["payload"]["idempotency_key"],
            "protocol-note-1",
        )

    async def test_operator_note_protocol_rejects_idempotency_key_reuse(self):
        session = {"paper_session_id": "paper-protocol-2", "candidate_id": "candidate-2"}
        with patch.object(mcp_control_service, "_db_required", return_value=False), patch.object(
            mcp_control_service,
            "get_paper_session_any",
            return_value=session,
        ):
            async with create_connected_server_and_client_session(mcp) as client:
                first = await client.call_tool(
                    "add_operator_note",
                    {
                        "paper_session_id": "paper-protocol-2",
                        "note": "Original note.",
                        "idempotency_key": "protocol-conflict-1",
                    },
                )
                conflict = await client.call_tool(
                    "add_operator_note",
                    {
                        "paper_session_id": "paper-protocol-2",
                        "note": "Different note.",
                        "idempotency_key": "protocol-conflict-1",
                    },
                )

        self.assertFalse(first.isError)
        self.assertTrue(conflict.isError)


if __name__ == "__main__":
    unittest.main()
