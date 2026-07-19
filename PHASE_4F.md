# Phase 4F: Forward Paper Qualification

Phase 4F connects one manually promoted, holdout-qualified Alpha Lab finalist
to the frozen paper runtime. The connection is an explicit operator action. It
does not happen during promotion, does not start a runner, and does not grant
an agent or worker authority to approve, advance, or trade a candidate.

## Explicit handoff

The operator starts forward qualification from the Alpha Lab campaign detail
screen and supplies a rationale, paper risk rules, observation and decision
minimums, and expected behavior bounds. The backend requires the finalist's
one-time sealed holdout outcome to be `holdout_qualified`.

The handoff creates exactly one ordinary candidate, paper-bot draft, draft
paper session, and `research_forward_qualifications` record. Retries are
idempotent by research candidate. Research provenance remains frozen in the
candidate snapshot rather than being represented as an experiment run.

## Shadow-first runtime

Forward sessions begin in `shadow` policy mode and remain stopped until the
operator completes the normal candidate and paper-bot review steps. While the
qualification is collecting evidence:

- autonomous-paper mode is rejected;
- approval-required mode is rejected until the configured minimum shadow
  observation and actionable-decision counts pass;
- a rejected qualification cannot restart its runner;
- existing Phase 3C policy, approval, risk, and execution semantics are not
  changed.

No existing paper session is modified or started by Phase 4F.

## Evidence and decision

An evidence refresh records the shadow observation count, actionable decisions
and rate, bars processed, paper trades and PnL, modeled commission, policy-event
count, and risk-block count. Gates compare the observed actionable rate and
risk-block rate with the operator's frozen expectations.

Qualification is a durable, one-way outcome:

- `qualified` requires every evidence gate, a paused session, a written
  rationale, and explicit approval when configured;
- `rejected` requires a paused session and a written rationale;
- terminal evidence and the decision cannot be overwritten.

The outcome means forward paper evidence passed or failed the configured
protocol. It is not a profitability guarantee and it does not authorize live
trading.

## Backend API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/research-campaigns/{id}/candidate-promotions/{candidate_id}/forward-qualification` | Explicitly create the candidate and draft shadow-first paper handoff. |
| `GET` | `/api/research-campaigns/{id}/candidate-promotions/{candidate_id}/forward-qualification` | Inspect the durable qualification state. |
| `POST` | `/api/research-campaigns/{id}/forward-qualifications/{qualification_id}/refresh` | Snapshot current paper evidence and gates. |
| `POST` | `/api/research-campaigns/{id}/forward-qualifications/{qualification_id}/decision` | Record one qualified or rejected outcome. |

## Verification

Focused tests cover the holdout requirement, explicit handoff, evidence and
diagnostic calculations, shadow-first mode gate, and approval-required terminal
decision. The frontend production build verifies the Alpha Lab handoff and
qualification controls.

## Frozen boundary

- Paper-only; no broker, live order, or production-capital integration
- No MBP-1 dependency for bar-strategy qualification
- No automatic promotion, handoff, session start, or session advancement
- No automatic qualification or candidate mutation by an agent
- No changes to existing paper sessions or the Phase 3C execution semantics

