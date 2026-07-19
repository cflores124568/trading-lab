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

## Completed next slice

[`PHASE_3F.md`](PHASE_3F.md) now freezes the typed event-driven market input
contract with synthetic BBO, trade, duplicate, stale, sequence-gap, and
locked/crossed-market fixtures. The remaining market-data step is the Databento
MBP-1 adapter itself.
