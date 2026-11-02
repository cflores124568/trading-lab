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

One important cleanup landed after I compared the presets against the current
official firm docs: the preset rule fields are now evaluation-stage only.
Funded-account payout rules are separate metadata and should not be read as the
evaluation target/min-day requirements.

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

MFFU Builder presets instead use `daily_loss_mode: soft_pause`. The backtester
and replay close at the observed bar close, block entries for the rest of that
New York futures session, then resume at the next session. This is a bar-level
approximation: intrabar triggering and the firm's exact liquidation mechanics
cannot be reconstructed from OHLC bars. Builder uses the Python backtest path
until the C++ kernel supports this behavior.

### Max Drawdown

The evaluator also checks drawdown bar by bar and records the first breach time.
There are two modes right now:

- `intraday`: drawdown is measured off the running peak of the equity curve
- `eod`: drawdown is measured against `account_size` directly

The default `eod` behavior remains a fixed starting-balance floor for legacy
snapshots. New MFFU trailing presets opt into `evaluation_model: mffu_eod`:
the floor moves after an observed session close and stops at starting balance
plus $100. Sessions roll at 18:00 New York time. MFFU's published regular-day
[auto-liquidation time](https://help.myfundedfutures.com/en/articles/9558251-permitted-times-to-trade)
is 16:10 Eastern; holidays can have different hours. When a subsequent session
is present, evidence is incomplete unless a bar ends exactly at 16:10, and a
position held across that cutoff is flagged. The final partial session is
identified separately and does not by itself imply a breach. Missing bars,
unparseable intervals, invalid OHLC and unordered time evidence are flagged.
Unlisted exceptional closures and full missing trading days are not inferred.

The shared 2019–2025 holiday-date list is checked for open and closed positions
in ES, MES, NQ, MNQ, GC and MGC. A position open on a listed New York calendar
date makes the MFFU result inconclusive pending review of the account's holiday
terms. Trading outside the list's coverage also makes the result inconclusive.
This check does not assert a breach, block an entry, or model a closing time.
The frontend carries a copy of the backend list for offline replay.

MFFU states that automatic liquidation applies on regular trading days, but
does not occur at a holiday early close: traders must close positions before
the market closes, subject to any communicated exception. Holiday hours are
communicated separately. The simulator does not currently model either the
regular automatic liquidation or holiday-specific closing requirements, so a
position crossing a regular cutoff is evidence of uncertainty, not a simulated
liquidation or an automatic rule breach. A holiday schedule must be verified for
the relevant dates and instruments before it can be used to model those days.
As a targeted safeguard, ES, MES, NQ and MNQ evidence covering January 9,
2025 is inconclusive: [CME announced an early equity-market close that day](https://www.cmegroup.com/media-room/press-releases/2025/12/30/cme_group_announcestradinghoursforusnationaldayofmourningtohonor.html).
The same announcement says metals kept normal hours, so GC and MGC are not
flagged by this specific check. Other exceptional market closures are not yet covered.

MFFU evaluation checks each simulated position against the candle's adverse
high or low, not merely its close. If that envelope reaches a hard loss floor or
a Builder soft-pause threshold, the outcome is **inconclusive**. OHLC does not
establish whether the extreme happened before a stop, limit, or other fill, so
the check does not manufacture a breach, pause, execution price or trade. An
inconclusive result cannot be marked as a pass. Backtests, replay, and the
backtest preset comparison use the same conservative interpretation. A confirmed
bar-close breach remains a breach. More granular data and fill evidence are
required to resolve an ambiguous bar.

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

If `min_trading_days` is set, the evaluator counts distinct trading days and
requires the run to meet or beat that number before it can pass.

For MFFU, entry and exit activity is grouped into New York futures sessions;
closed-trade PnL is attributed to the exit session for consistency. Other
legacy rule sets still use closed-trade calendar dates.

## What Is In The Presets

Preset families currently include:

- Topstep
- My Funded Futures Pro
- My Funded Futures Pro One-Day (50k)
- My Funded Futures Builder, including the 50k add-on
- My Funded Futures Rapid
- My Funded Futures Rapid EOD (25k and 50k)
- My Funded Futures Studio #001, #002 and #003
- My Funded Futures Flex (legacy)
- Lucid Trading `LucidPro` and `LucidFlex`

They are exposed through `/api/prop-firms` and used by both backtests and the
standalone replay flow.

The flat rule fields in those presets are for scoring the evaluation/challenge
stage. If a firm has different funded-account payout rules, the UI surfaces that
separately instead of pretending they are the same thing.

## Important Gaps Right Now

One honest note still matters here:

- the daily loss and drawdown checks are useful, but still simplified compared to
  the weird firm-specific trailing rules some challenges use in real life

So the app already does real scoring, but it is still "clean internal rule
model" territory, not a perfect clone of every prop-firm edge case.

## MFFU rule review

Reviewed against MyFundedFutures' published information on November 1, 2026.
Account-specific and legacy terms may differ. These presets are approximations,
not an authoritative pass/fail result for an actual evaluation account.

- [Evaluation parameters](https://help.myfundedfutures.com/en/articles/11802636-traders-evaluation-simplified)
  list Rapid EOD 25k and 50k with a 6% target, 4% EOD maximum loss, no
  daily loss limit, 30% consistency and four minimum trading days. Pro's
  50k one-day add-on has a $4,000 target; its separate
  [add-on guide](https://help.myfundedfutures.com/en/articles/12879226-pro-plan-1day-addon)
  states no consistency rule or daily loss limit and a one-day pass.
- MFFU's
  [EOD drawdown](https://help.myfundedfutures.com/en/articles/8348565-end-of-day-eod-drawdown-explained)
  trails with qualifying session-end results and accounts for open losses;
  new presets use a bar-based trailing approximation and identify incomplete
  session evidence. News and inactivity are not enforced. MFFU's
  [inactivity policy](https://help.myfundedfutures.com/en/articles/16596524-inactivity-rule-one-time-payment-model)
  says an account could be closed after seven calendar days without a trade;
  its applicability depends on account terms. The
  [news policy](https://help.myfundedfutures.com/en/articles/8230009-news-trading-policy)
  distinguishes evaluations from particular funded plans and contains
  restrictions that bar prices alone cannot verify.
- [Builder evaluations](https://help.myfundedfutures.com/en/articles/11802636-traders-evaluation-simplified)
  have daily-loss **soft pauses**. Builder presets apply an approximate bar-close
  pause and next-session resume in backtests, experiment batches, and replay.
- [Studio plans](https://help.myfundedfutures.com/en/articles/17589665-studio-plans-a-comprehensive-guide)
  have separate static-loss and micro-contract-only rules. All three are
  available as approximate presets. Their micro-only restrictions and the
  catalog's single-instrument contract limits are checked for supported mini
  and micro symbols; unknown symbols fail closed. Risk-sized entries are capped.
  [Flex](https://help.myfundedfutures.com/en/articles/13521620-flex-plan-the-path-forward-legacy)
  is a legacy plan. MFFU also documents its
  [25k legacy variant](https://help.myfundedfutures.com/en/articles/13536146-25k-flex-plan-legacy).
- MFFU's [automated-trading policy](https://help.myfundedfutures.com/en/articles/8444599-fair-play-and-prohibited-trading-practices)
  permits certain customized automated strategies subject to its restrictions,
  including no high-frequency trading or exploitation of simulated fills.
  That policy is not evaluated by these presets.

The read-only `/api/prop-firms/mffu-catalog` endpoint and the comparison in
backtest and replay setup list the reviewed evaluation variants and the published
Flex legacy plans. The catalog includes source links, contract limits, and a
review date. It does not encode funded-stage payouts or update itself when MFFU
changes its terms.

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
