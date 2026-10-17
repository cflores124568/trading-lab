# Opening Range Breakout and VWAP Mean Reversion

These are completed-bar entry strategies available in Experiments and New
Backtest. They share the existing Python signal pipeline and single/batch
execution engine. Deterministic Alpha Lab searches use the same strategy
catalog; the agentic hypothesis allowlist is unchanged.

## Session contract

- Default entry session: 09:30–16:00 in `America/New_York`, with daylight saving
  handled by timezone conversion. Times are editable numeric HHMM values:
  `930` means 09:30 and `1600` means 16:00.
- Aware input timestamps are converted to New York. Naive input timestamps
  are interpreted as UTC, matching the Databento historical datasets. CSV
  imports should use UTC or explicit timezone offsets.
- Timestamps label bar starts. These strategies accept whole-minute intraday
  bars of at most one hour, aligned with the configured session start.
  Daily/weekly bars are unsupported.
- New entries are restricted to bars fully inside the session whose close
  precedes the entry cutoff. No new signal is sent on the final session bar.
  Each completed-bar signal fills at the next available bar's open using the
  existing execution/slippage model.
- Entry cutoff does **not** close an existing position. Both strategies use
  the existing bracket exits, opposite entry signals, and dataset-end close.
  Without brackets, positions can remain open overnight. VWAP is **not** an
  automatic take-profit exit. No additional exit mode was added to the kernel.

## ORB (`orb`)

Parameters:

| Key | Default | Meaning |
| --- | --- | --- |
| `opening_range_minutes` | 15 | Duration from the session start |
| `breakout_buffer_percent` | 0 | Percentage buffer outside the range |
| `session_start` | 930 | New York session start, HHMM |
| `session_end` | 1600 | New York entry cutoff, HHMM |

The range is the highest high and lowest low of the **complete** opening
window. Its duration must be a multiple of the source bar interval: a
15-minute window supports 1-, 5-, and 15-minute bars. Bars crossing the opening
boundary are rejected rather than incorporating post-window prices.

After the opening window closes, a close crossing above
`range_high * (1 + buffer / 100)` generates a long entry. Crossing below
`range_low * (1 - buffer / 100)` generates a short entry. Staying outside the
range does not repeat the signal; returning inside and breaking out again can
generate another entry. There is no one-trade-per-day limit.

Missing opening bars, including a dataset slice beginning after session open,
disable ORB entries for that day. Levels reset for each New York day and are
not exposed before the opening window finishes.

## VWAP mean reversion (`vwap_mean_reversion`)

Parameters:

| Key | Default | Meaning |
| --- | --- | --- |
| `entry_deviation_percent` | 0.1 | Percentage distance from session VWAP |
| `warmup_minutes` | 15 | Minimum elapsed session time before entries |
| `session_start` | 930 | New York VWAP reset/entry session start, HHMM |
| `session_end` | 1600 | New York entry cutoff, HHMM |

VWAP uses cumulative `(high + low + close) / 3 * volume` divided by cumulative
volume, using only bars inside the configured session. Overnight volume and
previous sessions do not contribute. A session beginning after the configured
open is skipped because its earlier volume cannot be reconstructed; zero
cumulative volume produces no entry.

Once warmup completes, entering the lower distance band generates a long;
entering the upper band generates a short. If price is already stretched on
the first eligible bar, it may generate an entry there. Staying in the same
band does not repeat entries. This is a fade entry model, not a crossover at
VWAP and not an automatic close at VWAP.

Both strategies support the existing trend EMA, minimum ATR percentage, and
cooldown filters. ORB also supports VWAP alignment. That filter is excluded
from the VWAP mean-reversion settings and rejected if enabled through the API,
because requiring a long above VWAP would block the lower-band fade.

Experiment fields still accept comma-separated values, for example
`opening_range_minutes: 15, 30` or `entry_deviation_percent: 0.1, 0.2, 0.3`.
Frontend validation checks all session/range combinations before a run.

## Focused verification

From `backend/`:

```sh
./venv/bin/python -m unittest test_session_strategies test_strategy_filters test_strategy_rsi test_backtest_service test_experiment_batch -q
```

The session tests cover opening-range completion, missing bars, both entry
directions, buffers, custom hours, daylight saving, per-session VWAP resets,
volume weighting, zero volume, warmup, future-bar invariance, invalid settings,
and parity between single backtests and batched experiments.
