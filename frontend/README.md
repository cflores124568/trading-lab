# Trading Lab — Frontend

High-performance trading UI built with SolidJS for fine-grained reactivity and
minimal overhead during live chart updates.

## Technical Decisions

- **SolidJS over React:** Eliminates Virtual DOM overhead. Fine-grained reactivity
  via `createSignal` means only the exact DOM nodes that depend on a changed value
  re-render — important when price data is updating continuously.
- **Lightweight Charts v5:** Canvas-based charting that handles 50,000+ bars without
  frame drops. Used for both the live price chart and equity curve display.
- **Tailwind CSS v4:** Rust-based CSS engine with near-instant rebuild times during
  development.
- **Vite:** Fast HMR and a lean production bundle. Proxies `/api` to the FastAPI
  backend on port 8000 during development so no CORS configuration is needed locally.

## Setup
```bash
npm install
npm run dev
```

## Structure
```
src/
├── components/    # PriceChart, EquityCurve
├── routes/        # Dashboard (index), backtest detail
├── services/      # api.ts — typed fetch helpers
└── constants.ts   # Symbols, intervals, defaults
```

## Notes

- Experiments selects its initial symbol once; clearing the last selection keeps
  the grid empty until a symbol is chosen. Strategy settings support Single or
  Sweep input, suggested values, removable sweep values, and explicit filter
  toggles. VWAP alignment can compare Off and On in the same batch. Session
  times use a time picker in Single mode and HHMM values in Sweep mode.

- The chart fetches candles directly from TimescaleDB via `GET /api/data/db/{symbol}/candles`.
  No dataset loading step or client-side cache — aggregation happens in SQL via `time_bucket()`.
- `interval().resampleRule === null` marks timeframes that are not yet wired up. Those
  options render as disabled in the selector.

## Replay risk sizing

Replay supports fixed whole contracts or a percentage of the current realized
account equity. Risk sizing requires an initial tick or ATR stop and optionally
caps the contract count. It uses the selected instrument directly; ES/MES and
NQ/MNQ remain separate symbols.

The replay API's historical `tick_value` field means **dollars per full price
point**, unlike the backtest API's dollars per tick. The backtest launch converts
between these units. Replay sizes with `stop_ticks * tick_size * tick_value +
commission` dollars per contract, including round-trip commission. Contracts are
`max(1, floor(equity * risk_per_trade_pct / 100 / risk_per_contract))`, followed by
the optional cap. An entry above budget is visibly flagged; it never substitutes
a micro contract.

Configured initial stops become resting stop orders and can execute starting on
the bar after the entry. Existing replay resting-fill modes still apply. ATR
uses the previous bar's Wilder ATR; entries wait for a usable value. Resting
entries keep their submitted size and stop basis until filled; replacing the
entry recalculates both. Moving or canceling a protective order does not rewrite
the trade's initial dollar risk or R denominator.

Save/resume retains the sizing mode, risk percentage, cap, stop basis, ATR period,
trade quantities, initial risk, R multiples, and warnings. Replaying saved actions
rebuilds open positions and protective orders. Older sessions default to fixed
sizing with no configured stop. R metrics and aggregate budget-warning counts
cover closed trades; an open over-budget position has its own warning.

Validate replay with `npm run test:replay` and `npm run build` here. From
`backend/`, run the replay schema/persistence/API tests and the OpenAPI drift test:
`./venv/bin/python -m unittest test_replay_sessions test_replay_sessions_api test_openapi_spec`.
API tests use isolated storage doubles; AWS persistence must be checked after
deployment.
