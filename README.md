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

Current replay scope:

- replay is supported today for saved backtests
- manual trade actions are simulated during replay
- standalone historical paper-trading sessions on arbitrary date ranges are the next major planned feature

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
- scrub, seek, step, and jump between trade markers
- place manual `long`, `short`, and `exit` actions during replay
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
- interactive replay for saved backtests
- shared app shell and replay-first UX

Not built yet:

- standalone historical paper-trading sessions independent of backtests
- authentication and multi-user accounts
- hosted production deployment

## Roadmap

Near-term roadmap:

1. Add standalone historical replay sessions
2. Support manual paper trading on arbitrary historical date ranges
3. Evaluate standalone manual sessions against prop-firm rules
4. Persist replay sessions separately from strategy backtests
5. Deploy a recruiter-friendly hosted demo

The next major milestone is turning replay into a true standalone historical paper-trading simulator, not just a saved-backtest analysis feature.

## Resume-Friendly Summary

Trading Lab is a full-stack futures backtesting and replay platform built with SolidJS, FastAPI, C++, and PostgreSQL/TimescaleDB. It supports historical market-data ingestion, bar-by-bar strategy backtesting, prop-firm rule evaluation, saved run persistence, side-by-side comparison, and interactive replay on historical futures data.
