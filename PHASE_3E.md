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
maintains the version counter. Worker fencing preserves existing trading
rules. Manual approval recovery now has its own transaction boundary and
decision-ID contract, documented in [Phase 3C](PHASE_3C.md#atomic-approval-recovery).

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

## Atomic session controls

Runner start, pause, kill-switch changes, and the generic session-status endpoint
share a session-row transaction. Session status, runner intent, lease revocation,
paper event, candidate projection, and candidate audit commit together. A failed
event or audit write leaves the previous state and lease intact. The memory
fallback uses the same command boundary with snapshot rollback.

Setting status to `running` uses the runner-start guards, including the emergency
latch, pending approvals, and forward-qualification restrictions. Generic resume
keeps the saved window, polling interval, and cursor. Inactive statuses clear
runnable intent; pausing a completed or failed runner preserves its diagnostics.
Stopped sessions must reopen to `ready` before starting again. Pause and stop
preserve positions, resting orders, and progress; resetting the kill switch does
not resume work. A newly created session from a running bot handoff starts ready
and idle until explicitly started.

Lease acquisition locks and rechecks the session's runnable status and mode, so
stale worker discovery cannot reclaim a stopped session. Claims wait for any
tentative session write to finish. Workers validate cached signal history against
the durable cursor and rebuild it after another process resets or moves it.

```bash
PAPER_FENCING_TEST_DSN='<isolated PostgreSQL DSN>' ./venv/bin/python -m unittest test_paper_controls test_paper_runner_fencing test_paper_approval_resolution
```

These cases cover control rollback, lease restoration, concurrent start/stop,
publication visibility, shared start guards, and cursor-cache recovery.

## Completed next slice

[`PHASE_3F.md`](PHASE_3F.md) now freezes the typed event-driven market input
contract with synthetic BBO, trade, duplicate, stale, sequence-gap, and
locked/crossed-market fixtures. The remaining market-data step is the Databento
MBP-1 adapter itself.
