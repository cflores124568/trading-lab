# Phase 4 Roadmap: Alpha Lab

Phase 4 turns Trading Lab's existing experiment runner into a durable,
validation-first alpha research system. The objective is to produce explainable
research candidates from historical data without confusing backtest winners
with proven profitability.

This file is the canonical Phase 4 boundary for future contributors and coding
agents. Later phases are context, not authorization: implement only the phase
or slice explicitly requested by the user.

## Permanent safety boundary

Phase 4 is research and paper qualification only.

- No live brokerage connectivity or real-money order execution
- No automatic candidate promotion
- No automatic paper-session creation or advancement
- No MCP runner, approval, order-execution, candidate-mutation, or kill-switch
  control tools
- No changes to the frozen Phase 3C policy, risk, approval, or execution
  semantics
- No Databento MBP-1 dependency for bar-based Alpha Lab work
- No destructive changes to `backend/data/`, PostgreSQL state, Docker volumes,
  or existing paper sessions
- Existing paper sessions must remain paused unless the user explicitly places
  a particular session in scope
- Research output must use terms such as `research finalist`, `validated
  candidate`, or `rejected`; it must not claim guaranteed profitability

MBP-1 can later support separate microstructure research involving order-book
imbalance, microprice, queue behavior, and liquidity. It is not required for
the Phase 4 bar-strategy roadmap below.

## Phase 4A: Research foundation

Build the durable contracts and bookkeeping required by every later Alpha Lab
phase.

Status: complete. See [`PHASE_4A.md`](PHASE_4A.md) for the frozen contracts,
partition semantics, persistence boundary, and verification notes.

Scope:

- persisted research campaigns
- persisted successful and failed research trials
- append-only campaign audit events
- typed campaign, trial, and partition schemas
- chronological development, validation, and final-holdout partitions
- exact partition timestamps and bar counts
- deterministic trial fingerprints
- idempotent duplicate-trial handling
- bounded backend create/list/get APIs
- persistence, partition, and protocol tests

Not in 4A:

- strategy searching
- walk-forward evaluation
- robustness ranking
- background workers
- Alpha Lab frontend screens
- agent-generated hypotheses
- candidate promotion

## Phase 4B: Robust evaluation

Add the validation engine that distinguishes a parameter-grid winner from a
research finalist.

Status: complete. See [`PHASE_4B.md`](PHASE_4B.md) for the frozen evidence,
scoring, rejection, finalist-freeze, and sealed-holdout contracts.

Scope:

- leakage-resistant rolling or expanding walk-forward folds
- sealed final holdout excluded from discovery and ranking
- finalist freezing before one-time holdout evaluation
- base, 1.5x, and 2x transaction-cost stress
- minimum-trade and fold-coverage gates
- median and worst-fold evaluation
- drawdown and regime stability
- neighboring-parameter sensitivity and parameter-cliff detection
- symbol and interval concentration diagnostics
- trial-count-aware multiple-testing warnings
- explainable robustness score components and rejection reasons

Any statistically named measure, including Deflated Sharpe Ratio or Probability
of Backtest Overfitting, must be implemented from a cited primary source with
tested assumptions. Do not attach a recognized name to an improvised metric.

## Phase 4C: Durable unattended search worker

Make bounded bar-strategy campaigns safe to leave running without an operator
at the keyboard.

Status: complete. See [`PHASE_4C.md`](PHASE_4C.md) for deterministic search,
budget, lease, recovery, pause, and worker-runtime contracts.

Scope:

- deterministic search across the existing strategy families
- explicit trial and wall-clock budgets
- PostgreSQL campaign leases with opaque owner tokens
- atomic single-owner acquisition
- heartbeat renewal and bounded expiry
- stale-worker takeover with token rotation
- pause-aware, restart-safe progress
- cooperative scheduling across campaigns
- bounded work per loop
- worker healthcheck and Docker Compose service
- restart, duplicate-delivery, lease, and budget tests

Completing 4C is the first point at which unattended Alpha Lab searches should
be treated as a supported runtime workflow.

## Phase 4D: Alpha Lab frontend

Expose the durable research workflow to an operator without requiring direct
API or terminal use.

Status: complete. See [`PHASE_4D.md`](PHASE_4D.md) for the operator workflow,
frontend routes, manual promotion contract, and frozen safety boundary.

Scope:

- campaign creation and configuration review
- estimated trial count and explicit budgets before launch
- campaign list, status, progress, start, and pause
- partition and walk-forward visualization
- complete trial ledger and failed-trial visibility
- cost-stress and fragility results
- explainable finalist ranking
- sealed-holdout state and results
- prominent research-not-guarantee disclosure
- manual candidate promotion only after validation gates pass

Promotion must not automatically create or start a paper session.

## Phase 4E: Agentic hypothesis generation

Allow a research agent to propose new, bounded strategy hypotheses after the
deterministic research and validation infrastructure is trustworthy.

Status: complete. See [`PHASE_4E.md`](PHASE_4E.md) for typed proposal,
allowlist, static validation, durable accounting, deterministic compilation,
budget, deduplication, and explicit research-execution contracts.

Scope:

- typed hypothesis proposals with rationale and expected market behavior
- allowlisted strategy primitives and parameter bounds
- static validation before execution
- deterministic compilation into the normal trial contract
- complete accounting for every attempted hypothesis
- duplicate and near-duplicate detection
- hypothesis and trial budgets
- rejection of unsupported, unsafe, or untestable proposals
- human review of resulting finalists

The research agent may propose hypotheses. It may not promote candidates,
modify risk limits, start paper sessions, or trade.

## Phase 4F: Forward paper qualification

Connect manually approved research finalists to the frozen paper runtime and
collect forward evidence before any separate future live-trading discussion.

Scope:

- explicit human handoff from research finalist to candidate
- shadow-first paper-session requirement
- minimum forward-observation and decision counts
- comparison of expected versus observed behavior
- execution-cost and risk-block diagnostics
- approval-required paper qualification where appropriate
- durable qualification or rejection outcome

Phase 4F remains paper-only. Live trading, broker integration, production
capital allocation, and self-modifying execution agents require a separately
scoped future roadmap and explicit user authorization.

## Required sequence

Implement the phases in order:

```text
4A foundation
  -> 4B robust evaluation
  -> 4C unattended worker
  -> 4D operator frontend
  -> 4E agentic hypotheses
  -> 4F forward paper qualification
```

Do not collapse later phases into an earlier request. Each phase must update
this roadmap, its own phase document, the operator guide, tests, and the README
when its boundary is actually complete.
