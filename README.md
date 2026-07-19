# Trading Lab

Trading Lab is a full-stack futures trading simulator and backtesting platform built around a specific question: what is the difference between passing prop-firm evaluation rules and being consistently net profitable overall?

I started building this after running into that gap in my own trading. I could pass evaluation-style constraints, but that did not automatically translate into a durable edge. I wanted tooling that could do more than report headline PnL, so I built a system for loading historical futures data, running bar-by-bar backtests, evaluating runs against prop-firm rules, comparing saved results, and replaying market history interactively.

Today, Trading Lab is a real product-shaped system with a SolidJS frontend, a FastAPI backend, a C++ backtest kernel, and PostgreSQL plus TimescaleDB for time-series market data and persistence.

## What It Does

Current capabilities:

- load historical futures data from Databento
- query and aggregate OHLCV candles from TimescaleDB with `time_bucket()`
- preview live market data with `yfinance`
- run strategy backtests bar by bar
- calculate performance metrics and prop-firm pass/fail outcomes
- save completed backtests
- browse list/detail views for prior runs
- compare two saved backtests side by side
- replay saved backtests interactively with manual `long`, `short`, and `exit` actions
- launch standalone historical replay sessions on DB-backed symbols and save progress for later

Current replay scope:

- saved backtests can still be replayed with preserved context
- standalone replay sessions can be launched from any supported symbol and date range
- manual trade actions are simulated during replay and can be saved/resumed later

## Why It Exists

Trading Lab is not meant to be a generic chart dashboard. It is built around prop-firm style evaluation.

The key idea is that a strategy can:

- look good on raw returns
- pass an evaluation challenge
- still fail to produce durable profitability

That is why the platform emphasizes:

- daily loss limits
- max drawdown rules
- consistency thresholds
- pass/fail challenge outputs
- replay and comparison workflows for analyzing behavior, not just outcomes

## Product Flow

The current app flow is:

`Dashboard -> Backtests -> New Backtest -> Detail -> Replay -> Compare`

There is also a standalone replay flow now:

`Dashboard -> Replay Lab -> Replay Session -> Replay Sessions`

That flow supports three main jobs:

1. Inspect market data
2. Run and evaluate strategies
3. Revisit saved runs through replay and comparison

## Architecture

| Layer | Technology |
|---|---|
| Frontend | SolidJS, TypeScript, Tailwind CSS v4, Lightweight Charts, `@solidjs/router` |
| Backend | Python 3.12, FastAPI, Uvicorn, Pydantic |
| Calculation Layer | pandas, NumPy, C++17 pybind11 kernel |
| Database | PostgreSQL 16, TimescaleDB |
| Market Data | Databento for historical futures data, `yfinance` for live preview data |
| DB Access | raw SQL + `psycopg2` pooling |
| Infra | Docker, docker-compose |

Important implementation note:

- `sqlalchemy` appears in `backend/requirements.txt`, but the active persistence path today is raw SQL service helpers plus `psycopg2`, not an ORM-centered architecture

## System Design

Frontend:

- chart-heavy UI built with SolidJS
- dashboard for live/historical market inspection
- saved backtest list, detail, compare, and replay flows
- standalone replay lab and replay-session resume flow
- Alpha Lab campaign setup, bounded launch controls, durable progress, trial ledger, and validation evidence review

Backend:

- FastAPI routes orchestrate data access, strategy execution, metrics, and persistence
- Python is used for iteration speed and business logic

Performance path:

- the hot backtest loop is implemented in C++ in [`backend/cpp/backtest_core.cpp`](backend/cpp/backtest_core.cpp)
- Python wraps and orchestrates that engine in [`backend/services/backtest_engine.py`](backend/services/backtest_engine.py)
- a Python fallback path exists if the compiled extension is unavailable

Data layer:

- historical OHLCV futures data lives in PostgreSQL plus TimescaleDB
- interval aggregation happens in the database with `time_bucket()`
- saved backtests are persisted in Postgres-backed tables
- standalone replay sessions are persisted separately from backtests

## Docs

- [`docs/PAPER_TRADING_GUIDE.md`](docs/PAPER_TRADING_GUIDE.md) is the operator guide for startup, candidate handoff, paper-session modes, persistence, shutdown, MCP, and troubleshooting
- [`docs/CPP_KERNEL.md`](docs/CPP_KERNEL.md) explains when to build the pybind11 kernel, where the compiled module needs to land, and how the Python fallback works
- [`docs/PROP_FIRM_RULES.md`](docs/PROP_FIRM_RULES.md) spells out what the evaluator actually checks today, including a couple rules that exist in presets but are not fully enforced yet
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) lays out the clean split between static frontend hosting and a containerized backend + database
- [`PHASE_3C.md`](PHASE_3C.md) records the frozen agent-ready paper core, policy modes, pre-trade risk gate, durable scorecard, and restart-safe approvals
- [`PHASE_3D.md`](PHASE_3D.md) tracks the MCP research plane, audited paper notes, and the safety boundary for future control tools
- [`PHASE_3E.md`](PHASE_3E.md) records durable paper-runner ownership, leases, heartbeats, and stale-worker takeover
- [`PHASE_3F.md`](PHASE_3F.md) freezes the source-neutral BBO/trade event boundary before Databento MBP-1 ingestion
- [`PHASE_4_ROADMAP.md`](PHASE_4_ROADMAP.md) is the canonical Alpha Lab sequence from research persistence through forward paper qualification
- [`PHASE_4A.md`](PHASE_4A.md) records the Alpha Lab research contracts, chronological partition rules, durable trial ledger, and Phase 4A safety boundary
- [`PHASE_4B.md`](PHASE_4B.md) records leakage-resistant validation, robustness gates and scoring, finalist freezing, and sealed-holdout semantics
- [`PHASE_4C.md`](PHASE_4C.md) records deterministic budgeted search, PostgreSQL campaign leases, restart-safe progress, and the Alpha Lab worker runtime
- [`PHASE_4D.md`](PHASE_4D.md) records the Alpha Lab operator screens, bounded launch review, evidence inspection, and manual validated-candidate promotion boundary
- [`PHASE_4E.md`](PHASE_4E.md) records bounded agent hypothesis proposals, static allowlist validation, durable attempt accounting, deterministic trial compilation, and the human execution boundary
- [`PHASE_4F.md`](PHASE_4F.md) records the explicit Alpha Lab paper handoff, shadow-first evidence protocol, diagnostics, and durable qualification or rejection outcome
- [`docs/MCP.md`](docs/MCP.md) explains Codex connection setup, MCP resources, and the narrow control safety boundary

## Core Features

### 1. Historical Futures Data

- ingest CME-style futures data from Databento
- migrate parquet-backed data into TimescaleDB
- query candle ranges by symbol, interval, and date bounds

### 2. Backtesting Engine

- attach indicators
- generate signals
- run bar-by-bar execution
- calculate trades, equity curve, and summary metrics

Execution assumptions contract:

- default mode is `execution_mode="bar"` to preserve the simple legacy fill model
- `execution_mode="synthetic_quotes"` is opt-in and only changes fills when explicitly requested
- each saved backtest persists execution assumptions in `run_config` (`execution_mode`, `spread_ticks`, `volatile_bar_*`, `slippage_ticks`, optional brackets)
- compare and experiment flows are expected to carry those same assumptions so saved-run reproducibility stays intact

### 3. Prop-Firm Evaluation

- evaluate runs against firm-style rule sets
- model daily loss, max drawdown, consistency, profit target, and minimum trading days
- return pass/fail along with metrics

### 4. Saved Analysis Workflows

- persist completed backtests
- review saved runs later
- compare two runs side by side
- preserve replay context so saved backtests survive restarts

### 5. Interactive Replay

- replay saved market history candle by candle
- launch standalone historical replay sessions from DB-backed symbol ranges
- scrub, seek, step, and jump between trade markers
- place manual `long`, `short`, and `exit` actions during replay
- save and resume replay sessions later
- view replay-specific PnL, equity, trades, and prop-eval output

## Local Setup

### Prerequisites

- Python 3.12+
- Node.js 18+
- Docker + Docker Compose

### 1. Bootstrap Local Infrastructure

From the repo root:

```bash
npm run bootstrap
```

This script:

- creates `backend/.env` from `backend/env.example` if needed
- starts the local TimescaleDB container
- waits for the DB to become healthy
- imports existing parquet files from `backend/data/futures_1m` if present

### 2. Run the Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp env.example .env
uvicorn main:app --reload
```

Backend docs:

- `http://localhost:8000/docs`

### 3. Run the Frontend

```bash
cd frontend
npm install
npm run dev
```

## Market Data Workflow

Fetch or update historical futures data:

```bash
cd backend
python fetch_databento.py --update
python db/migrate_parquet_to_pg.py
```

Check the exact fetch window before spending money:

```bash
cd backend
python fetch_databento.py --update --check-cost
```

Supported symbols currently include:

- NQ
- MNQ
- ES
- MES
- GC
- MGC

## API Snapshot

Key routes:

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/data/db/symbols` | List DB-backed symbols |
| GET | `/api/data/db/{symbol}/candles` | Fetch OHLCV bars via TimescaleDB |
| GET | `/api/data/db/{symbol}/info` | Fetch symbol metadata and date range |
| GET | `/api/data/yfinance/candles` | Fetch live preview candles |
| POST | `/api/data/load-symbol` | Register a historical symbol/date-range dataset |
| POST | `/api/backtests` | Run a backtest |
| GET | `/api/backtests` | List saved backtests |
| GET | `/api/backtests/{id}` | Fetch a saved backtest |
| GET | `/api/backtests/{id}/candles` | Rebuild replay candles for a saved backtest |
| GET | `/api/backtests/compare?a={}&b={}` | Compare two saved runs |
| GET | `/api/candidates` | List promoted research candidates |
| GET | `/api/candidates/{id}` | Fetch one candidate detail + audit trail |
| PATCH | `/api/candidates/{id}/status` | Move a candidate through review states |
| POST | `/api/candidates/{id}/notes` | Add a review note |
| POST | `/api/candidates/{id}/paper-bot` | Create the paper bot config stub |
| PATCH | `/api/candidates/{id}/paper-bot/status` | Move the paper bot stub between draft/ready/running/stopped |
| POST | `/api/research-campaigns` | Create a draft Alpha Lab campaign with exact chronological partitions |
| GET | `/api/research-campaigns` | List bounded Alpha Lab campaign summaries |
| GET | `/api/research-campaigns/{id}` | Fetch campaign partitions and bounded audit history |
| POST | `/api/research-campaigns/{id}/trials` | Record a completed or failed research attempt idempotently |
| GET | `/api/research-campaigns/{id}/trials` | List bounded research attempts, including failures |
| POST | `/api/research-campaigns/{id}/trials/{trial_id}/validation` | Persist walk-forward evidence and an explainable robustness decision |
| POST | `/api/research-campaigns/{id}/trials/{trial_id}/freeze-finalist` | Freeze a passing research finalist before holdout evaluation |
| POST | `/api/research-campaigns/{id}/trials/{trial_id}/holdout` | Record one sealed-holdout result exactly once |
| POST | `/api/research-campaigns/{id}/queue` | Configure and queue a budgeted deterministic search |
| POST | `/api/research-campaigns/{id}/pause` | Pause search intent and revoke its worker lease |
| POST | `/api/research-campaigns/{id}/resume` | Resume search from its durable cursor |
| POST | `/api/research-campaigns/{id}/trials/{trial_id}/promote` | Manually record a frozen, gate-passing finalist as a validated research candidate |
| GET | `/api/research-campaigns/{id}/candidate-promotions` | List bounded Alpha Lab promotion records |
| POST | `/api/research-campaigns/{id}/candidate-promotions/{candidate_id}/forward-qualification` | Explicitly create a draft shadow-first paper qualification handoff |
| POST | `/api/research-campaigns/{id}/forward-qualifications/{qualification_id}/refresh` | Persist current forward observations, decisions, behavior, cost, and risk-block evidence |
| POST | `/api/research-campaigns/{id}/forward-qualifications/{qualification_id}/decision` | Record one approved qualification or rejection outcome |
| PUT | `/api/research-campaigns/{id}/hypothesis-budget` | Configure the bounded Phase 4E proposal and compiled-trial envelope |
| POST | `/api/research-campaigns/{id}/hypotheses` | Persist and statically validate one typed agent hypothesis |
| POST | `/api/research-campaigns/{id}/hypotheses/{attempt_id}/execute` | Explicitly execute one human-reviewed accepted hypothesis as a research trial |
| POST | `/api/paper-sessions/{id}/runner/start` | Start a historical runner in shadow, approval, or autonomous-paper mode |
| POST | `/api/paper-sessions/{id}/runner/decision/resolve` | Approve or reject a durable pending policy decision |
| POST | `/api/paper-sessions/{id}/runner/kill-switch` | Engage or reset the durable emergency runner stop |
| POST | `/api/replay-sessions` | Create a standalone replay session |
| PUT | `/api/replay-sessions/{id}` | Update an existing replay session |
| GET | `/api/replay-sessions` | List saved replay sessions |
| GET | `/api/replay-sessions/{id}` | Fetch a saved replay session |
| GET | `/api/prop-firms` | List prop-firm presets |

## Current Status

Implemented:

- C++ backtest kernel with Python fallback
- Databento ingestion flow
- TimescaleDB schema and DB service layer
- DB-backed candle aggregation and querying
- FastAPI data, backtest, and prop-firm routes
- SolidJS dashboard and charting UI
- saved backtest persistence
- backtest list/detail/compare flows
- candidate registry, review detail, and paper-bot handoff
- durable Alpha Lab campaigns from bounded research through explicit shadow-first forward-paper qualification
- deterministic historical paper runner with shadow, approval-required, and autonomous-paper policy modes
- append-only policy decisions with durable pending-approval state
- typed autonomous pre-trade risk assessments, explicit blocked-action events, and a durable kill switch
- durable shadow-policy scorecards and restart-safe, single-resolution approvals
- a local MCP server for read-only candidate, paper-session, risk, scorecard, and decision-trace inspection plus audited paper-session notes
- a dedicated paper-runner worker with PostgreSQL leases, heartbeats, and stale-owner recovery
- a source-neutral paper market-event sequencer with durable duplicate, stale, gap, and locked/crossed-market handling
- interactive replay for saved backtests
- standalone replay session launch, save, and resume flow
- shared app shell and replay-first UX

Not built yet:

- authentication and multi-user accounts
- hosted production deployment

## Roadmap

Near-term roadmap:

1. Add the Databento MBP-1 adapter when data access is available
2. Run longer worker/database restart and duplicate-delivery soak tests
3. Deploy a recruiter-friendly hosted demo, then add authentication

The next operational milestone is longer paper-worker and database soak testing; live brokerage execution remains outside the current roadmap.

## Resume-Friendly Summary

Trading Lab is a full-stack futures backtesting and replay platform built with SolidJS, FastAPI, C++, and PostgreSQL/TimescaleDB. It supports historical market-data ingestion, bar-by-bar strategy backtesting, prop-firm rule evaluation, saved run persistence, side-by-side comparison, and interactive replay on historical futures data.
