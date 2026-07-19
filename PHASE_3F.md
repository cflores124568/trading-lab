# Phase 3F: Source-Neutral Market Events

Phase 3F freezes the final boundary before a real Databento MBP-1 feed is
connected. Paper sessions can now accept a typed, source-neutral stream of BBO
and trade events, sequence it deterministically, and project accepted market
state without changing the frozen Phase 3C trading loop.

## Safety boundary

This layer is paper-only market input. Applying an event does not run the
strategy policy, resolve an approval, pass a risk gate, create or fill an order,
advance the historical runner, or mutate the kill switch. Only an accepted BBO
can replace `last_quote`; an accepted trade is retained as
`runner_state.last_market_trade`.

No Databento SDK or schema-specific type is imported here. A future MBP-1
adapter must translate provider records into these contracts and must not move
sequencing or safety behavior into provider code.

## Frozen contract

- [x] Typed BBO and trade event envelopes
- [x] Canonical symbol, source, and timezone-aware UTC timestamps
- [x] Stable stream identity from source, publisher, and instrument
- [x] Durable per-session sequence cursor
- [x] Idempotent duplicate-event handling
- [x] Stale sequence and event-time rejection
- [x] Explicit sequence-gap accounting and degraded data quality
- [x] Locked and crossed BBO quarantine without quote replacement
- [x] Tick-normalized BBO and trade prices
- [x] Bounded recent-event-id history
- [x] Read-only MCP visibility for the cursor and last market trade
- [x] Synthetic protocol tests for all boundary cases

## What MBP-1 work remains

The next market-data change is intentionally narrow: implement a Databento
MBP-1 adapter that maps provider records into `PaperBBOEvent` and
`PaperTradeEvent`, then run recorded-fixture and live paper soak tests. The
adapter should call `apply_paper_market_event` and inherit this phase's duplicate,
ordering, gap, and market-quality rules unchanged.
