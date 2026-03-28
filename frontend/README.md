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

- The chart fetches candles directly from TimescaleDB via `GET /api/data/db/{symbol}/candles`.
  No dataset loading step or client-side cache — aggregation happens in SQL via `time_bucket()`.
- `interval().resampleRule === null` marks timeframes that are not yet wired up. Those
  options render as disabled in the selector.