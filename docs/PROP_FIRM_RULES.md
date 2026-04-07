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

The evaluator groups realized trade PnL by each trade's `exit_time` date.

If any single day drops below `-(account_size * daily_loss_limit)`, that rule
is marked as breached.

Important gotcha: this is based on closed-trade PnL by exit date. It is not a
full intraday unrealized drawdown monitor.

### Max Drawdown

There are two modes right now:

- `intraday`: drawdown is measured off the running peak of the equity curve
- `eod`: drawdown is measured against `account_size` directly

That `eod` version is intentionally simple right now. It is not a full
session-close trailing rule engine yet, so don't oversell it in a demo.

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

## What Is In The Presets

Preset families currently include:

- Topstep
- My Funded Futures
- My Funded Futures Rapid
- My Funded Futures Flex
- FTMO
- Apex Trader Funding
- Lucid Trading `LucidPro` and `LucidFlex`

They are exposed through `/api/prop-firms` and used by both backtests and the
standalone replay flow.

## Important Gaps Right Now

Two honest notes matter here:

- `min_trading_days` exists in the schema and presets, but `evaluate_prop_firm()`
  does not currently enforce it
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

That result comes back as:

- `passed`
- individual breach/pass booleans
- a `details` object with the computed percentages and per-day PnL

## Why This Doc Exists

This project is built around prop-firm-style evaluation, so I don't want the
rules to live only inside Python code and half-remembered notes.

When I tighten the evaluator later, this file should change with it instead of
pretending the current implementation is already more complete than it is.
