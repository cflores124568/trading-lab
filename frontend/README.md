# Trading Lab - Frontend

This is the high-performance UI for the Trading Lab, built with **SolidJS** to ensure the lowest possible overhead during high-frequency data updates.

## Technical Decisions
- **SolidJS over React:** Used to eliminate Virtual DOM overhead. In a trading environment with constant price ticks, Solid's "createSignal" provides direct DOM updates, preventing UI "jank."
- **Vite + Tailwind v4:** Optimized build pipeline for fast refresh and CSS processing.
- **Lightweight Charts (v5.1):** High-performance Canvas-based charting that handles 50,000+ data points with ease.

## Setup
```bash
npm install
npm run dev