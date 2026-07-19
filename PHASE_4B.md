# Phase 4B: Robust Alpha Evaluation

Phase 4B adds a durable validation protocol between a completed Alpha Lab trial
and the label `research_finalist`. It evaluates supplied evidence; it does not
search parameter grids, schedule work, promote candidates, or touch paper
sessions.

## Safety boundary

- The final holdout is excluded from validation evidence and robustness ranking.
- A trial must pass validation and be frozen before holdout evidence is accepted.
- Holdout evidence can be recorded exactly once.
- A research finalist is not a promoted candidate and is not a profitability guarantee.
- No worker, frontend, MCP mutation, candidate promotion, paper execution, MBP-1,
  broker connection, or live-trading path is added.

## Validation evidence

Validation accepts two to twelve rolling or expanding walk-forward folds. Every
fold must provide timezone-aware train and test boundaries plus base, 1.5x, and
2x transaction-cost results. The service rejects evidence unless:

- fold indexes are consecutive;
- every training window starts inside development and ends before its test;
- every test window stays inside validation;
- test windows are chronological and non-overlapping;
- expanding windows retain one fixed training start; and
- no validation test reaches the holdout boundary.

Validation evidence remains explicit caller input. Phase 4C generates durable
development-partition discovery trials, but it does not silently evaluate or
freeze finalists.

## Gates and diagnostics

The evaluator fails closed on six configured or derived gates:

- enough folds meet the minimum-trade threshold;
- median base-cost fold PnL is positive;
- worst-fold drawdown stays within the configured limit;
- median fold PnL remains positive at 2x costs;
- at least two unique neighboring parameter results avoid a parameter cliff;
- at least half of represented regimes have positive median PnL.

The result retains median and worst-fold PnL, fold coverage, worst drawdown,
cost-level medians and profitable rates, regime summaries, neighboring-parameter
sensitivity, parameter-cliff status, and absolute-PnL concentration by symbol
and interval.

Campaign trial counts of 20 and 100 produce progressively stronger
multiple-testing warnings. These are plain selection-risk warnings, not a
Deflated Sharpe Ratio, Probability of Backtest Overfitting, or another named
statistical measure.

## Explainable score

The robustness score is a transparent 0–100 engineering score:

| Component | Points |
| --- | ---: |
| Fold consistency, coverage, and regime stability | 30 |
| Base/1.5x/2x cost resilience | 25 |
| Worst-fold drawdown stability | 20 |
| Neighboring-parameter stability | 15 |
| Symbol/interval concentration | 10 |

Every component and gate is persisted. A high total cannot override a failed
gate; any failed gate produces `rejected` with explicit reasons.

## Persistence and holdout protocol

`research_trial_evaluations` stores one immutable validation result per trial,
including the typed evidence, evidence fingerprint, components, gates,
diagnostics, warnings, and reasons. Replaying identical evidence is idempotent;
different evidence cannot replace an existing evaluation.

`research_campaign_finalists` freezes the passing validation evaluation and
score with `holdout_status=sealed`. The one-time holdout operation changes that
state to `evaluated` and stores base, 1.5x, and 2x results. Holdout results are
reported separately and never recompute validation ranking.

## Backend API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/research-campaigns/{campaign_id}/trials/{trial_id}/validation` | Validate and persist walk-forward evidence. |
| `GET` | `/api/research-campaigns/{campaign_id}/trials/{trial_id}/validation` | Read the immutable validation result. |
| `POST` | `/api/research-campaigns/{campaign_id}/trials/{trial_id}/freeze-finalist` | Freeze a passing trial before holdout access. |
| `GET` | `/api/research-campaigns/{campaign_id}/finalists` | List at most 100 frozen finalists by validation score. |
| `POST` | `/api/research-campaigns/{campaign_id}/trials/{trial_id}/holdout` | Record the finalist's one-time holdout evidence. |

## Deferred

Phase 4C owns deterministic discovery-trial generation, budgets, campaign
leases, heartbeats, restart-safe progress, and the unattended worker. Frontend
screens, agent-generated hypotheses, candidate promotion, and forward paper
qualification remain in later phases.
