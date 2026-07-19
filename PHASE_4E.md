# Phase 4E: Bounded Agentic Hypotheses

Phase 4E lets an external research agent propose strategy hypotheses without
giving that agent authority over execution, promotion, paper sessions, risk
limits, or trading. Agent output enters the backend as untrusted typed data and
must pass static validation before the backend emits a normal deterministic
trial contract.

This phase does not add a model provider or autonomous agent loop. Any agent or
operator may use the proposal API, but the backend owns validation, budgets,
deduplication, compilation, persistence, and the execution boundary.

## Proposal contract

Each proposal includes a short name, rationale, expected market behavior, one
strategy primitive, and its parameters. The Phase 4E allowlist is deliberately
limited to the four existing bar strategies:

- `ma_crossover`
- `ema_crossover`
- `rsi_overbought`
- `bollinger_bands`

Each primitive has explicit numeric bounds and required parameters. The shared
trend, ATR, VWAP, and cooldown filters are bounded too. Unknown primitives,
unknown parameters, booleans masquerading as numbers, non-finite values,
fractional integer parameters, out-of-range values, and invalid cross-field
relationships fail closed.

The research agent cannot submit execution assumptions or prop-firm risk
rules. A compiled hypothesis inherits the campaign's operator-configured
execution assumptions. Its random seed is derived from the canonical
hypothesis fingerprint.

## Durable accounting and budgets

`research_hypothesis_attempts` is an immutable PostgreSQL ledger. Every request
that reaches the typed proposal service is stored as exactly one of:

- `accepted`
- `rejected`
- `duplicate`
- `near_duplicate`
- `budget_rejected`

Rejected attempts retain their reasons. Exact duplicates have the same
canonical strategy/parameter fingerprint. Near duplicates use a deterministic
maximum normalized parameter distance of `0.10` within the primitive's
allowlisted ranges. Both link to the earlier accepted attempt and do not emit a
trial contract.

An operator must configure both a hypothesis-attempt budget and a compiled
trial budget before accepting proposals. Budget checks, exact duplicate checks,
and near-duplicate checks are repeated while holding a PostgreSQL campaign
advisory lock so concurrent submissions cannot bypass them. Attempts received
after a budget is exhausted are still retained as `budget_rejected` evidence.

## Compilation and execution

Accepted proposals compile deterministically into the existing trial inputs:

```text
strategy_type + normalized strategy_params + inherited execution_config + random_seed
```

Compilation does not execute the trial. Execution requires a separate explicit
operator call to the hypothesis execution route, and queued or running
campaigns fail closed until paused. The result is registered through the normal
Phase 4A terminal-trial contract, so successful and failed executions remain
visible and duplicate delivery remains idempotent. The immutable
`research_hypothesis_trial_links` table records provenance.

Validation, finalist freezing, sealed holdout evaluation, and human finalist
review continue to use the Phase 4B and 4D contracts. No hypothesis route can
promote a candidate.

## Backend API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `PUT` | `/api/research-campaigns/{id}/hypothesis-budget` | Configure one bounded hypothesis/trial envelope before attempts. |
| `GET` | `/api/research-campaigns/{id}/hypothesis-budget` | Read budget usage. |
| `POST` | `/api/research-campaigns/{id}/hypotheses` | Validate, deduplicate, compile, and retain one proposal attempt. |
| `GET` | `/api/research-campaigns/{id}/hypotheses` | List at most 100 attempts, optionally by status. |
| `GET` | `/api/research-campaigns/{id}/hypotheses/{attempt_id}` | Inspect one attempt and its trial provenance. |
| `POST` | `/api/research-campaigns/{id}/hypotheses/{attempt_id}/execute` | Explicitly execute one accepted hypothesis as a normal research trial. |

## Safety boundary

- No autonomous hypothesis loop or model credential integration
- No arbitrary code, SQL, indicator, strategy, or parameter execution
- No agent-controlled execution assumptions or risk limits
- No automatic trial execution
- No automatic validation, finalist freezing, holdout access, or promotion
- No candidate, paper-bot, or paper-session creation
- No paper policy, approval, runner, MCP-control, or order changes
- No MBP-1, broker, or live-trading integration
- No modification of existing paper sessions

Phase 4F remains separate and is the only roadmap phase that may add an
explicit human handoff from a research finalist into forward paper
qualification.
