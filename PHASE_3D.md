# Phase 3D: MCP Research and Control Plane

Phase 3D exposes the frozen Phase 3C paper-policy boundary to agents through
Model Context Protocol. MCP is an adapter over the existing services, not a
parallel execution engine.

## Safety boundary

The first slice was deliberately read-only. The first control slice adds only
audited paper-session operator notes. It cannot start or step a runner,
change policy mode, resolve an approval, engage or reset a kill switch, mutate
a candidate, or submit a paper order. Any later trading control tool must call the same
Phase 3C services as FastAPI and must not bypass durable approvals or pre-trade
risk assessments.

## Current slice

- [x] Official stable MCP Python SDK on the v1 line
- [x] Local stdio transport
- [x] Compact structured candidate discovery
- [x] Compact structured paper-session discovery
- [x] Bounded paper runtime, policy, risk, and scorecard inspection
- [x] Recent policy proposal, risk-block, and resolution trace
- [x] Stable JSON resources for candidate and paper-session context
- [x] Project-scoped Codex stdio configuration
- [x] Operator connection and safety guide
- [x] Initial read-only MCP slice completed and frozen
- [x] Audited, idempotent, paper-only `add_operator_note` control
- [x] MCP-specific audit actor and protocol coverage

## Tool contract

| Tool | Purpose |
| --- | --- |
| `list_candidates` | Discover candidate summaries with optional lifecycle filtering |
| `get_candidate` | Inspect one candidate and its paper handoff |
| `list_paper_sessions` | Discover paper sessions and runner health |
| `get_paper_session` | Inspect bounded execution, policy, risk, and scorecard state |
| `list_policy_decisions` | Inspect recent policy proposals, blocks, and resolutions |
| `add_operator_note` | Append an audited note to a paper session with a required idempotency key |

The server uses stdio so it stays local and does not add an unauthenticated HTTP
control surface. Run it from `backend/` with:

```bash
./venv/bin/python mcp_server.py
```

See [`docs/MCP.md`](docs/MCP.md) for the checked-in Codex configuration,
resource URIs, restart flow, and safety boundary.

## Deferred controls

Runner, approval, order-execution, policy-mode, and kill-switch mutations remain
deferred until each operation has an explicit authorization class, confirmation
behavior, audit actor, and test proving it cannot route around Phase 3C.
