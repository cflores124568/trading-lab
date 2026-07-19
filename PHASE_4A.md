# Phase 4A: Alpha Lab Research Foundation

Phase 4A adds the durable research ledger that later Alpha Lab phases can use.
It records campaign intent, immutable chronological partitions, and every
terminal trial attempt without running a search or treating a backtest result
as proven profitability.

## Scope

- PostgreSQL-backed `research_campaigns`
- PostgreSQL-backed `research_campaign_partitions`
- PostgreSQL-backed `research_trials`
- append-only `research_campaign_events`
- typed campaign, partition, audit-event, and trial API contracts
- campaign states: `draft`, `queued`, `running`, `paused`, `completed`, and
  `failed`
- configurable development, validation, and holdout percentages
- deterministic trial fingerprints and idempotent duplicate submission
- bounded create, list, and detail routes

This phase is bookkeeping only. A newly created campaign remains `draft`.
Nothing in Phase 4A queues work, runs a strategy, evaluates a finalist, ranks a
trial, promotes a candidate, creates a paper session, or advances an existing
paper session.

## Safety boundary

Phase 4A does not change the Phase 3C paper policy, approvals, risk gate,
execution model, runner ownership, or source-neutral market-event contracts.
It adds no worker, frontend screen, MCP mutation, broker integration, MBP-1
adapter, paper execution, or live execution path.

The database change is additive. It does not rewrite existing experiment,
candidate, paper-session, market-data, or replay tables. Research campaign audit
events have a database trigger that rejects `UPDATE` and `DELETE`; corrections
must be represented by a later event rather than history rewriting.

## Partition contract

Campaign creation reads the requested symbol and interval from PostgreSQL over
an explicit, timezone-aware inclusive window. The timestamp spine is strictly
ordered and capped at 2,000,000 bars for Phase 4A.

The split algorithm:

1. validates that every percentage is positive and the three values total
   exactly 100;
2. allocates whole bars with deterministic largest-remainder rounding;
3. assigns development first, validation second, and holdout last;
4. records each partition's exact first timestamp, last timestamp, and bar
   count; and
5. fails closed if a partition would be empty or timestamps are duplicate or
   out of order.

Partition ends are inclusive. The next partition starts at the following bar,
so no bar belongs to two partitions and development can never follow validation
or holdout chronologically.

## Trial identity and retention

A trial fingerprint is SHA-256 over canonical JSON containing:

- campaign ID
- strategy type
- strategy parameters
- execution configuration
- random seed

Outcome fields are not part of identity. PostgreSQL enforces one row per
campaign and fingerprint. Repeating the same submission returns the original
row with `was_duplicate=true`; it does not overwrite the stored success or
failure and does not append a second audit event. A genuinely separate attempt
must differ in its declared inputs, such as its seed or execution configuration.

Both `completed` and `failed` attempts are terminal, durable records. Failed
attempts require an error message and remain available through list and detail
routes.

## Backend API

| Method | Endpoint | Contract |
| --- | --- | --- |
| `POST` | `/api/research-campaigns/` | Create one draft campaign and its exact partitions. |
| `GET` | `/api/research-campaigns/?limit=&offset=&status=` | List at most 100 campaign summaries. |
| `GET` | `/api/research-campaigns/{campaign_id}` | Read campaign partitions and at most 100 recent audit events. |
| `POST` | `/api/research-campaigns/{campaign_id}/trials` | Record one completed or failed attempt idempotently. |
| `GET` | `/api/research-campaigns/{campaign_id}/trials?limit=&offset=&status=` | List at most 100 attempts, including failures. |
| `GET` | `/api/research-campaigns/{campaign_id}/trials/{trial_id}` | Read one exact attempt. |

List offsets are capped at 10,000. Trial identity payloads are capped at 64 KiB.
Campaign creation rejects naive timestamps, invalid ranges, unknown intervals,
empty source windows, oversized source windows, and split configurations that
cannot produce three non-empty partitions.

## Deferred to later phases

- Phase 4B: walk-forward evaluation, sealed-holdout evaluation, stress tests,
  robustness gates, and explainable ranking
- Phase 4C: search expansion, budgets, leases, and a background worker
- Phase 4D: Alpha Lab frontend screens
- Phase 4E: agent-generated hypotheses
- Phase 4F: manual candidate handoff and forward paper qualification

Do not add any of those capabilities under the Phase 4A contract.
