# Phase 3C: Agent-ready Paper Core

Phase 3B froze the historical runner's execution semantics. Phase 3C adds a
policy boundary around those semantics without changing what the existing
deterministic strategy does in autonomous paper mode.

## Scope

- typed market observations and policy decisions
- a versioned deterministic policy that preserves the Phase 3B action table
- `shadow`, `approval_required`, and `autonomous_paper` runner modes
- append-only policy decision events
- one durable pending decision per paper session
- explicit approve/reject resolution before an approval-mode runner continues
- an independent pre-trade risk gate and durable emergency kill switch
- a durable shadow-policy scorecard for proposals that were not executed

MCP, broker adapters, and live order routing remain out of scope. The paper
policy and risk boundary is now frozen for Phase 3D MCP tools to consume.

## Current slice

- [x] Observation and decision contracts
- [x] Deterministic policy seam
- [x] Policy modes persisted in `runner_state`
- [x] Decision records persisted through `paper_events`
- [x] Approval-mode pause and decision resolution endpoint
- [x] Independent pre-trade risk decision contract
- [x] Position, order-count, stale-data, session-hours, and kill-switch rules
- [x] Decision Trace and approval controls in the paper-session UI
- [x] Historical shadow-mode scorecard
- [x] Restart/recovery coverage for pending approvals

## Semantics

`autonomous_paper` is the compatibility default. Existing sessions therefore
keep their Phase 3B behavior unless an operator selects another mode.

`shadow` advances observations and records proposed decisions but does not
execute policy actions.

`approval_required` automatically applies non-order state updates such as
marks, but pauses on `buy`, `sell`, or `exit`. The proposal is stored in the
session's durable `runner_state.pending_decision` field. The runner cannot
restart until that decision is approved or rejected.

## Atomic approval recovery

Resolution requests now require the displayed `decision_id` alongside
`approved`. The frontend and committed OpenAPI contract carry that identity;
deploy the frontend and API together. Requests without it fail validation,
and a stale identity cannot resolve a newer proposal.

The API locks the session row and uses one PostgreSQL transaction for every
execution action, pending-decision removal, resolution receipt, lease
revocation, candidate projection, and audit write. A process exit or failure
before commit rolls back the whole operation. Execution events and the
resolution receipt have deterministic IDs scoped to session, decision, and
action index. Memory mirrors publish after commit. The in-memory development
store uses locks and snapshot rollback for the same operation boundary.

Repeating the same decision/outcome returns current session state without
executing again, appending another receipt, or disturbing a newer proposal.
The first resolver's identity and rationale remain in the audit. An opposite
outcome returns HTTP 409. Older receipts with random event IDs are also
recognized by their decision identity. Execution evidence without a receipt
is treated as an incomplete older resolution requiring inspection; it is not
automatically executed again.

Tests cover both storage paths, concurrent API contexts, response retries,
stale IDs, rollback after either flip action/receipt/candidate audit, lease
rollback, and forced API-process exits between actions. PostgreSQL tests use
an explicit isolated `PAPER_FENCING_TEST_DSN`, never the application database:

```bash
cd backend
./venv/bin/python -m unittest test_paper_approval_resolution test_paper_policy
PAPER_FENCING_TEST_DSN='<isolated PostgreSQL DSN>' ./venv/bin/python -m unittest test_paper_approval_resolution
```

## Phase status

Phase 3C is complete and frozen. Unit coverage and a real backend restart verify
that pending approvals survive process recovery, block runner restart until
resolved, and cannot be resolved twice. The next slice is Phase 3D: expose this
paper core through a narrow MCP research and control plane without giving MCP
tools a path around policy modes, risk assessments, approvals, or the kill
switch.
