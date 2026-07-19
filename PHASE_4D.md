# Phase 4D: Alpha Lab Operator Frontend

Phase 4D exposes the durable Alpha Lab workflow in the SolidJS application. It
does not change how trials are searched or evaluated. It gives an operator one
place to review campaign boundaries, launch bounded work, inspect every result,
and record a manual research-candidate decision.

## Operator workflow

Open **Alpha Lab** from the main navigation.

1. Create a draft with one DB-backed symbol, interval, exact time window, and
   development/validation/holdout percentages.
2. Review the backend-calculated partition timestamps and bar counts.
3. Configure one existing strategy family and its finite parameter grid.
4. Review the full Cartesian plan count, explicit trial cap, and wall-clock cap.
5. Launch the campaign or leave it as a draft.
6. Pause or resume queued work from the campaign detail screen.
7. Inspect the complete trial ledger, including retained failures.
8. Select stored validation evidence to review walk-forward folds, cost stress,
   score components, gates, warnings, fragility, and rejection reasons.
9. Review finalist ranking and sealed-holdout state separately.
10. Manually promote a frozen gate-passing finalist with a written rationale.

The interface labels Alpha Lab output as research evidence, not a profitability
guarantee.

## Manual promotion boundary

`research_candidate_promotions` is an additive PostgreSQL table with one
idempotent record per campaign/trial finalist. Promotion fails closed unless:

- the trial has an immutable validation result;
- the validation outcome is `research_finalist`;
- every persisted validation gate passed; and
- the finalist was frozen before holdout access.

This record is deliberately separate from the older experiment candidate and
paper-session contracts. Phase 4D does not fabricate an experiment run or saved
backtest ID, create a paper bot, create a paper session, start a worker, or place
an order. Phase 4F owns the explicit forward-paper handoff.

## Backend API additions

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/research-campaigns/{id}/trials/{trial_id}/promote` | Manually record one validated research candidate. |
| `GET` | `/api/research-campaigns/{id}/candidate-promotions` | List at most 100 promotion records for a campaign. |

The frontend also consumes the Phase 4A through 4C campaign, trial, validation,
finalist, queue, pause, and resume routes. List reads remain bounded at 100.

## Frontend routes

| Route | Purpose |
| --- | --- |
| `/alpha-lab` | Campaign totals, campaign list, and draft creation. |
| `/alpha-lab/{id}` | Partitions, launch review, progress, ledger, evidence, finalists, promotions, and audit events. |

Loading, empty, inline error, terminal failure, sealed holdout, and promoted
states are represented explicitly. The layout collapses to a single-column
operator flow on narrow viewports while keeping wide tables horizontally
scrollable.

## Safety boundary

- No strategy-search changes
- No validation or holdout automation
- No agent-generated hypotheses
- No automatic candidate promotion
- No paper-session creation or advancement
- No MCP mutation tools
- No MBP-1, broker, order, or live-trading integration
- No changes to Phase 3 paper policy, risk, execution, approval, or runner state

Phase 4E remains the next phase. It may add bounded agentic hypothesis proposals
only; it may not broaden this promotion or execution boundary.
