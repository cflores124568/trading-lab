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

## Phase status

Phase 3C is complete and frozen. Unit coverage and a real backend restart verify
that pending approvals survive process recovery, block runner restart until
resolved, and cannot be resolved twice. The next slice is Phase 3D: expose this
paper core through a narrow MCP research and control plane without giving MCP
tools a path around policy modes, risk assessments, approvals, or the kill
switch.
