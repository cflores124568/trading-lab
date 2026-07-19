# Phase 4C: Durable Alpha Lab Search Worker

Phase 4C makes deterministic development-partition searches safe to leave
running. It adds a PostgreSQL-leased worker, explicit budgets, and a durable
campaign cursor. It does not promote candidates or access final holdout data.

## Search contract

A draft or paused campaign can be queued with one existing strategy family, a
finite parameter grid, execution assumptions, a trial budget, and a wall-clock
budget. Parameter keys are sorted, duplicate values are removed, and Cartesian
plans are emitted in stable order. The worker executes only the development
partition and stores every completed or failed plan through the Phase 4A trial
fingerprint contract.

The trial budget can intentionally truncate a larger search space. The search
cursor records planned, attempted, completed, and failed counts plus a terminal
reason. A campaign completes on search-space exhaustion, trial-budget
exhaustion, or its persisted wall-clock deadline.

## Ownership and recovery

`research_campaign_leases` stores one opaque owner token per campaign. Claiming
is atomic. A second worker cannot replace an unexpired lease; an expired lease
can be taken over with a new token. Heartbeats extend ownership for 5–300
seconds, and progress writes require the active owner, exact token, and expected
cursor index.

Each worker loop discovers a bounded set of campaigns and advances at most one
plan per campaign. This provides cooperative scheduling rather than allowing a
large campaign to monopolize the process.

If a process saves a trial and dies before its cursor checkpoint, the next
owner reruns the same deterministic plan. Phase 4A fingerprint idempotency
returns the original trial, after which the cursor advances once. Failed trials
remain part of the durable ledger.

Pausing changes durable status and revokes the active lease. The worker checks
status and ownership before execution and again before writing the trial.
Resuming re-queues the same cursor. A deadline remains durable across pauses and
restarts, so downtime cannot silently expand the declared wall-clock budget.

## Runtime

Run the worker separately from FastAPI:

```bash
cd backend
./venv/bin/python research_search_worker.py
```

Healthcheck:

```bash
./venv/bin/python research_search_worker.py --healthcheck
```

Docker Compose includes `research_worker` with the same PostgreSQL database and
read-only market-data mount as the API and paper worker.

## Backend API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/research-campaigns/{id}/queue` | Configure deterministic search and explicit budgets. |
| `POST` | `/api/research-campaigns/{id}/pause` | Pause durable intent and revoke ownership. |
| `POST` | `/api/research-campaigns/{id}/resume` | Resume from the persisted plan cursor. |
| `GET` | `/api/research-campaigns/{id}` | Inspect configuration, budgets, deadline, and progress. |

## Safety boundary

- development partition only for search;
- no validation-finalist or holdout automation;
- no candidate promotion or paper-session creation;
- no frontend, MCP mutation, agent hypothesis generation, MBP-1, broker, or
  live-trading integration;
- no changes to Phase 3 paper policy, risk, execution, or runner semantics.

Phase 4D owns the operator frontend. Later phases own agent hypotheses and
manual forward-paper qualification.
