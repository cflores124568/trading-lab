# Paper Runner 3B Checklist

This is the working checklist for closing `3B`.

The handoff note in `PAPER_RUNNER_PHASE_3B.md` says what the gate is. This file
is the thing we can actually mark up while we do the work.

## Freeze First

Do not treat parity noise as a bug until these are frozen:

- [x] End-of-window rule is explicit
- [x] Commission and equity rule is explicit
- [x] Guardrail breach behavior is explicit
- [x] Failure behavior is explicit for DB/data/signal errors

## Parity Matrix

Fill this in for every supported strategy:

| Strategy | Warmup bars | No signal, flat | No signal, open | Bullish flip | Bearish flip | Window end, flat | Window end, open | Status |
|---|---|---|---|---|---|---|---|---|
| `ma_crossover` | pass | pass | pass | pass | pass | pass | pass | pass |
| `ema_crossover` | pass | pass | pass | pass | pass | pass | pass | pass |
| `rsi_overbought` | pass | pass | pass | pass | pass | pass | pass | pass |
| `bollinger_bands` | pass | pass | pass | pass | pass | pass | pass | pass |

## Reliability Matrix

| Check | Expected result | Status | Notes |
|---|---|---|---|
| Pause keeps cursor | Resume starts on the next unseen bar | pass | Covered in `PaperRunnerPhase3BTests.test_reliability_matrix_covers_pause_resume_restart_and_cleanup`. |
| Resume keeps action order | No duplicate or skipped action | pass | Cursor stays at the last seen bar, then resume keeps `bars_processed` and `last_bar_time` intact. |
| Restart rebuilds state cleanly | Reloaded session takes the same next action | pass | `reset_cursor=True` clears cursor, parity state, and signal history on purpose. |
| Signal history rebuild matches hot state | Next signal/action matches pre-restart path | pass | The restart path reuses the same session state shape after reset. |
| Completion clears stale handle | No live runner handle after completion | pass | `_clear_runner_handle` drops the handle when a run finishes. |
| Failure clears stale handle | No live runner handle after failure | pass | `stop_all_historical_runners()` clears remaining handles and stops them. |
| Long run stays stable | No obvious drift in memory or action trail | pass | Covered in `PaperRunnerPhase3BTests.test_long_run_soak_stays_deterministic`. |

## Pass / Fail Thresholds

Use these unless we explicitly change them:

- trade count delta `== 0`
- total PnL delta `<= 0.01`
- max drawdown delta `<= 0.0001`
- win rate delta `<= 0.0001`
- repeated runs of the same fixed window must produce the same action trail

Parity matrix coverage is pinned by
`backend/test_paper_runner_phase_3b.py::PaperRunnerPhase3BTests.test_parity_matrix_covers_supported_strategies`
and the existing final-bar force-close test.

Reliability coverage is pinned by
`backend/test_paper_runner_phase_3b.py::PaperRunnerPhase3BTests.test_reliability_matrix_covers_pause_resume_restart_and_cleanup`.

Long-run soak coverage is pinned by
`backend/test_paper_runner_phase_3b.py::PaperRunnerPhase3BTests.test_long_run_soak_stays_deterministic`.

## Blockers

`3B` is closed. Keep these around as the historical gate, not active blockers:

- [ ] parity only passes with hand-wavy explanations
- [ ] one strategy still has uncovered edge cases
- [ ] restart or resume changes the next action
- [ ] end-of-window behavior is still ambiguous
- [ ] guardrail breach handling is still ambiguous
- [ ] session-list health still requires opening the detail page to understand runner health

## Gate Note

`3B` closed.
