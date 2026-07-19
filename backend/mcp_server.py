"""MCP entrypoint for Trading Lab's research and narrow paper control plane."""

import json

from typing import Any

from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP

from services.mcp_control_service import add_operator_note as add_operator_note_control
from services.mcp_read_service import (
    get_candidate_snapshot,
    get_paper_session_snapshot,
    list_candidate_snapshots,
    list_paper_session_snapshots,
    list_policy_decision_snapshots,
)

load_dotenv()

mcp = FastMCP(
    "Trading Lab",
    instructions=(
        "Read access to Trading Lab candidates and paper sessions, plus an audited "
        "paper-only operator-note control. This server cannot create orders, start "
        "runners, resolve approvals, change policy modes, or mutate risk controls."
    ),
    json_response=True,
)


def _json_resource(payload: Any) -> str:
    return json.dumps(payload, indent=2, sort_keys=True, default=str)


@mcp.resource(
    "trading-lab://candidates",
    title="Trading Lab candidates",
    description="Compact index of the newest research candidates.",
    mime_type="application/json",
)
def candidates_resource() -> str:
    """Return the default candidate index as stable JSON context."""
    return _json_resource(list_candidate_snapshots(limit=100))


@mcp.resource(
    "trading-lab://candidate/{candidate_id}",
    title="Trading Lab candidate",
    description="Research snapshot and paper handoff for one candidate.",
    mime_type="application/json",
)
def candidate_resource(candidate_id: str) -> str:
    """Return one candidate as stable JSON context."""
    return _json_resource(get_candidate_snapshot(candidate_id))


@mcp.resource(
    "trading-lab://paper-sessions",
    title="Trading Lab paper sessions",
    description="Compact index of paper-session runtime health.",
    mime_type="application/json",
)
def paper_sessions_resource() -> str:
    """Return the default paper-session index as stable JSON context."""
    return _json_resource(list_paper_session_snapshots(limit=100))


@mcp.resource(
    "trading-lab://paper-session/{paper_session_id}",
    title="Trading Lab paper session",
    description="Bounded execution, policy, risk, and scorecard state for one session.",
    mime_type="application/json",
)
def paper_session_resource(paper_session_id: str) -> str:
    """Return one paper-session snapshot as stable JSON context."""
    return _json_resource(get_paper_session_snapshot(paper_session_id))


@mcp.resource(
    "trading-lab://paper-session/{paper_session_id}/policy-decisions",
    title="Trading Lab policy decisions",
    description="The 100 most recent policy proposals, risk blocks, and resolutions.",
    mime_type="application/json",
)
def policy_decisions_resource(paper_session_id: str) -> str:
    """Return a bounded policy-decision trace as stable JSON context."""
    return _json_resource(list_policy_decision_snapshots(paper_session_id, limit=100))


@mcp.tool()
def list_candidates(
    lifecycle_status: str | None = None,
    limit: int = 20,
) -> dict[str, Any]:
    """List research candidates. This tool is read-only."""
    return list_candidate_snapshots(lifecycle_status=lifecycle_status, limit=limit)


@mcp.tool()
def get_candidate(candidate_id: str) -> dict[str, Any]:
    """Inspect one research candidate and its paper handoff. This tool is read-only."""
    return get_candidate_snapshot(candidate_id)


@mcp.tool()
def list_paper_sessions(
    status: str | None = None,
    limit: int = 20,
) -> dict[str, Any]:
    """List compact paper-session health summaries. This tool is read-only."""
    return list_paper_session_snapshots(status=status, limit=limit)


@mcp.tool()
def get_paper_session(paper_session_id: str) -> dict[str, Any]:
    """Inspect bounded execution, policy, scorecard, and risk state. This tool is read-only."""
    return get_paper_session_snapshot(paper_session_id)


@mcp.tool()
def list_policy_decisions(
    paper_session_id: str,
    limit: int = 20,
) -> dict[str, Any]:
    """List recent policy proposals, risk blocks, and resolutions. This tool is read-only."""
    return list_policy_decision_snapshots(paper_session_id, limit=limit)


@mcp.tool()
def add_operator_note(
    paper_session_id: str,
    note: str,
    idempotency_key: str,
) -> dict[str, Any]:
    """Append an audited paper-session note. Requires a stable idempotency key."""
    return add_operator_note_control(
        paper_session_id,
        note=note,
        idempotency_key=idempotency_key,
    )


if __name__ == "__main__":
    mcp.run(transport="stdio")
