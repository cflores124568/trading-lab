# Phase 3E: Durable Paper Runner Ownership

Phase 3E removes paper-session advancement from FastAPI's process-local runner
threads. Starting a session now persists runnable intent, and a separate worker
must acquire an expiring PostgreSQL lease before it can advance the frozen Phase
3C execution loop.

## Safety boundary

This phase changes ownership and recovery, not trading semantics. Observation,
policy, approval, pre-trade risk, execution, kill-switch, and scorecard behavior
remain the frozen Phase 3C contracts. The worker cannot advance a paused session
even if it previously held a lease.

## Current slice

- [x] Dedicated `paper_runner_worker.py` process
- [x] No new per-session runner threads on API start
- [x] PostgreSQL lease with opaque owner token
- [x] Atomic single-owner acquisition
- [x] Heartbeat renewal and bounded expiry
- [x] Stale-owner takeover with token rotation
- [x] Owner-and-token checked release
- [x] Pause and kill-switch lease revocation
- [x] Worker recheck of durable session mode before advancing
- [x] Cooperative scheduling for multiple runnable sessions
- [x] Docker Compose worker service
- [x] Unit and real Docker-backed lease verification

## Runtime

For local development, run the API and worker in separate terminals:

```bash
cd backend
./venv/bin/uvicorn main:app --reload
./venv/bin/python paper_runner_worker.py
```

In Docker Compose, `api` and `paper_runner` use the same image but different
commands. Both point at the same database. Multiple worker replicas are safe:
only one active lease can exist for a paper session.

## Worker commit fencing

Each durable worker bar uses one database transaction for execution state,
cursor updates, paper events, and any candidate projection/audit writes. A
private `paper_sessions.state_version` counter rejects writes from stale
snapshots. Before commit, the worker locks the session and lease rows and
checks the expected session version, owner, opaque token, and lease expiry.
Expiry uses PostgreSQL `clock_timestamp()` so a lease that expired during
processing cannot pass using the transaction's start time.

Ownership loss or a concurrent session change rolls back the whole tentative
bar. Memory mirrors publish only after commit; session mirrors also reject
older versions delivered late, and aborted signal history is discarded. An
execution error first rolls back the bar, then attempts to record failure
under the same ownership/version guard. It cannot overwrite a
newer pause, kill switch, or owner through the failure handler.

Concurrent API session writes return HTTP 409 with a retry message when their
loaded snapshot is stale. Refresh the session and retry the intended action.
The additive version column is initialized to zero for existing sessions by
the schema helper. Deploy/restart the API and worker together so every writer
maintains the version counter. No public payload fields or trading rules
change, and this does not make manual approval resolution transactional.

Validation includes the existing runner, policy, risk, execution-event, and
forward-qualification tests plus isolated PostgreSQL race tests:

```bash
cd backend
./venv/bin/python -m unittest test_db_transactions test_paper_runner_fencing test_paper_runner_worker test_paper_session_repo
PAPER_FENCING_TEST_DSN='<isolated PostgreSQL DSN>' ./venv/bin/python -m unittest test_paper_runner_fencing
```

The PostgreSQL cases are opt-in and never fall back to `DATABASE_URL`. They
create a unique test schema, require no Timescale extension or market data,
and cover pause/kill races, version conflicts, expiry during processing,
revocation/takeover, rollback after a taker fill, and completion/failure paths.

## Completed next slice

[`PHASE_3F.md`](PHASE_3F.md) now freezes the typed event-driven market input
contract with synthetic BBO, trade, duplicate, stale, sequence-gap, and
locked/crossed-market fixtures. The remaining market-data step is the Databento
MBP-1 adapter itself.
