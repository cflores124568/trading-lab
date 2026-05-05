# Paper Runner Phase 3B Handoff

This is the line in the sand for `3B`.

The goal here is not "make the runner nicer." The goal is to make runner
behavior deterministic enough that parity and reliability stop being debatable.
If we can't say exactly what should happen on each bar and each failure path,
then `3B` is still open no matter how much UI or plumbing we add.

## Current Read

We are not in `3C` yet.

What is real already:

- the durable paper session shell exists
- the historical runner can `start`, `pause`, and `step`
- cursor state, runner state, and event history persist on the session
- a basic parity check exists at window completion

What is still noisy:

- parity is only checked at the end and does not account for runner windows
- end-of-window behavior is not pinned against backtest behavior
- commission and equity semantics are not obviously aligned with the backtest engine
- guardrail state exists, but runner behavior on breach is not frozen yet
- reliability expectations are implied, not tested as a formal gate
- the UI still reads like `Phase 3A`, which is probably the honest label today

## 3B Exit Criteria

`3B` is closed only if all of these are true:

1. Runner semantics are frozen in writing for every meaningful signal and failure path.
2. Every supported strategy has a parity scorecard entry across the required edge cases.
3. The parity scorecard is quiet enough to trust, using the thresholds below.
4. Resume and restart behavior is consistent across repeated runs of the same window.
5. The session list can show compact runner health without needing the detail page to decode it.
6. Any remaining mismatches are explicitly accepted in writing, not hand-waved as "close enough."

If any one of those is still open, `3B` stays open.

## Required Artifacts

Each `3B` step needs to leave behind one artifact:

1. Exit contract: one short checklist with thresholds, edge cases, and go/no-go rules.
2. Parity scorecard: one matrix by strategy and edge case.
3. Runner semantics table: one source of truth for signal outcomes, guardrail breaches, and failures.
4. Reliability checklist: one test/result sheet for resume, restart, cleanup, and drift.
5. Session-list health view: one compact operator view showing health, cursor, latest action, and parity.
6. Gate note: one short statement saying either "`3B` closed" or exactly why it isn't.

## Recommended Parity Thresholds

These are the thresholds I'd use unless we decide otherwise on purpose:

- trade count delta must be `0`
- total PnL delta must be within `0.01`
- max drawdown delta must be within `0.0001`
- win rate delta must be within `0.0001`
- last closed trade side, entry time, and exit time must match exactly when the run is supposed to be fully comparable
- runner action sequence for the same candle stream must match on repeated runs

A parity result is only valid when the comparison target is honest.

That means one of these has to be true:

- the runner window matches the backtest window exactly
- or we build a sliced reference result for that exact runner window

Comparing a partial runner window against a full backtest and then acting shocked
about a parity miss is fake signal and should not count.

## Required Edge Cases

Every supported strategy needs coverage for:

- warmup bars before indicators are fully meaningful
- no-signal stretches with no open position
- no-signal stretches with an open position that should only be marked
- bullish flip bars
- bearish flip bars
- immediate flip behavior when already in the opposite position
- end-of-window behavior with no open position
- end-of-window behavior with an open position
- manual pause and resume from the same cursor
- restart after persisted state reload
- missing backtest reference
- data fetch failure or malformed next-bar input

## Runner Semantics

These rules are now frozen for `3B`:

1. End of window
   The runner force-closes any open position on the last candle close, then
   marks the window complete. That keeps the saved run comparable to the
   backtest instead of leaving a phantom open trade behind.

2. Commission and equity accounting
   Open-position marks are net of commission, so the visible equity path lines
   up with the backtest engine's mark-to-market math. Close and flatten still
   realize commission on exit like the rest of the execution stack.

3. Flat signal while a position is open
   Flat still means `mark`. The runner does not auto-close or auto-flip just
   because the strategy went neutral.

4. Guardrail breach handling
   Hard daily-loss or drawdown breaches fail the runner immediately, preserve
   the session state for inspection, and stop the loop.

5. Failure semantics
   DB read failures, malformed bar data, and signal-generation failures fail
   fast in the auto-runner. They are not treated as soft pauses.

6. Candidate/session synchronization
   Sync happens on start, pause, force-close, completion, and failure so the
   candidate status stays honest without having to open the detail page.

## Reliability Pass Criteria

The reliability pass should prove all of this:

- pausing does not lose cursor state
- resuming continues from the next expected bar, not a duplicated or skipped bar
- restarting the backend does not corrupt persisted session state
- signal history rebuild after restart produces the same next action as a hot in-memory run
- stale runner handles do not survive after pause, completion, failure, or shutdown
- repeated runs of the same fixed window produce the same runner action trail
- long runs do not show obvious memory growth or action drift

## 3B Fail Conditions

Any of these should block the phase gate:

- parity only passes when judged loosely or manually explained away
- one strategy still behaves differently without an accepted reason
- restart/resume changes the next action for the same session state
- end-of-window behavior is still ambiguous
- guardrail breaches still rely on operator guesswork
- the session list still can't answer "is this runner healthy and what did it just do?"

## 3C Gate

Move to `3C` only if:

- parity is quiet
- restart behavior is consistent
- runner semantics are frozen
- operator-facing health is compact and readable

If parity is still noisy or semantics are still moving, stay in `3B`.

## Immediate Next Task

The semantics are frozen now, so the next move is to turn them into the parity
matrix and reliability matrix instead of inventing new runner behavior.

In practice that means:

1. finish the parity scorecard across every supported strategy
2. finish the reliability pass for pause, resume, restart, and cleanup
3. keep `3C` blocked until those checks are quiet

## Tight Kickoff Prompt For The Next Thread

Use this as the next-thread opener:

> Close `Phase 3B` before touching `3C`. Start by freezing runner semantics:
> end-of-window behavior, commission/equity accounting, and guardrail breach
> behavior. Then build a parity checklist and reliability checklist that cover
> every supported strategy plus warmup, no-signal, flip-bar, open-position-flat,
> and restart/resume edge cases. Do not add more runner features until the
> semantics and scorecard are explicit.
