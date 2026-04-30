# Prop-Firm Rules

This is the "what the evaluator really does today" doc, not the fantasy version.

The rule presets live in `backend/routers/prop_firms.py`. The actual scoring
logic lives in `backend/services/prop_firm_eval.py`. If those two ever disagree,
the evaluator code wins because that's what the app is actually enforcing.

## Rule Shape

Every rule set uses the same basic fields:

- `account_size`
- `daily_loss_limit`
- `max_drawdown`
- `profit_target`
- `consistency_rule`
- `consistency_threshold`
- `drawdown_type`
- `min_trading_days`

These are stored as percentages or flags, except `account_size` and
`min_trading_days`.

## What Gets Checked

### Daily Loss Limit

For timestamped backtests, the evaluator watches the equity curve bar by bar.
Each trading day starts from that day's first equity point, then the rule checks
whether intraday equity ever drops more than `account_size * daily_loss_limit`.

Closed-trade daily PnL is still kept for consistency and calendar summaries,
but the actual daily-loss breach now comes from the path the account took, not
just where trades happened to close.

Older callers that don't pass equity timestamps still fall back to the old
closed-trade-by-exit-date check so replay/session code doesn't randomly break.

### Max Drawdown

The evaluator also checks drawdown bar by bar and records the first breach time.
There are two modes right now:

- `intraday`: drawdown is measured off the running peak of the equity curve
- `eod`: drawdown is measured against `account_size` directly

That `eod` version is intentionally simple right now. It uses the account size
as the reference point instead of a full session-close trailing rule engine, so
don't oversell it in a demo.

### Profit Target

The evaluator compares the final equity value against `account_size`.

If final profit percent is greater than or equal to `profit_target`, the target
is considered hit.

### Consistency Rule

If `consistency_rule` is on and the run made money overall, the evaluator checks
how much of total profit came from the best day.

Right now:

`best_day_profit / total_profit <= consistency_threshold`

If that passes, consistency passes.

### Minimum Trading Days

If `min_trading_days` is set, the evaluator counts distinct closed-trade dates
and requires the run to meet or beat that number before it can pass.

Important gotcha: this is based on days with closed trades, not just days where
you opened something and left it hanging.

## What Is In The Presets

Preset families currently include:

- Topstep
- My Funded Futures
- My Funded Futures Rapid
- My Funded Futures Flex
- Lucid Trading `LucidPro` and `LucidFlex`

They are exposed through `/api/prop-firms` and used by both backtests and the
standalone replay flow.

## Important Gaps Right Now

One honest note still matters here:

- the daily loss and drawdown checks are useful, but still simplified compared to
  the weird firm-specific trailing rules some challenges use in real life

So the app already does real scoring, but it is still "clean internal rule
model" territory, not a perfect clone of every prop-firm edge case.

## Pass/Fail Summary

A run only passes if all of these are true:

- daily loss was not breached
- drawdown was not breached
- profit target was hit
- consistency passed when enabled
- minimum trading days were met when the preset requires them

That result comes back as:

- `passed`
- individual breach/pass booleans
- a `details` object with computed percentages, breach timestamps, per-day PnL,
  and daily equity loss summaries when a timestamped equity path was available

## Why This Doc Exists

This project is built around prop-firm-style evaluation, so I don't want the
rules to live only inside Python code and half-remembered notes.

When I tighten the evaluator later, this file should change with it instead of
pretending the current implementation is already more complete than it is.
