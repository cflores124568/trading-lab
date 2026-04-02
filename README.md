# Trading Lab

A high-performance futures trading simulator and backtesting engine. Built to simulate
prop firm evaluation rules across multiple firms and account sizes, with a sub-millisecond
C++ backtest kernel and real CME Globex market data.

## Tech Stack

| Layer        | Technology                                                  |
|--------------|-------------------------------------------------------------|
| Frontend     | SolidJS, TypeScript, Tailwind CSS v4, Lightweight Charts v5 |
| Backend      | Python 3.12, FastAPI                                        |
| Calculations | NumPy, pandas, C++17 pybind11 kernel                        |
| Database     | PostgreSQL 16, TimescaleDB                                  |
| Market Data  | Databento (historical), yfinance (live preview)             |
| Infra        | Docker, docker-compose                                      |

## Getting Started

Quick local reference: [docs/local-setup.md](/Users/chrisflores/trading-lab/docs/local-setup.md)

### Prerequisites

- Python 3.12+
- Node.js 18+
- Docker + Docker Compose (for TimescaleDB)

### One-Time Local Bootstrap
```bash
npm run bootstrap
```

What this does:
- creates `backend/.env` from `backend/env.example` if needed
- starts the local TimescaleDB container
- waits for the DB to become healthy
- imports any existing parquet files from `backend/data/futures_1m`

What it does not do:
- it does not auto-fetch from Databento, to avoid surprise data charges
- it does not start the backend or frontend dev servers

### Database Only
```bash
cd backend
docker-compose up -d db
```

### Backend
```bash
cd backend
python -m venv venv
source venv/bin/activate      # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp env.example .env           # fill in DATABASE_URL and API keys
uvicorn main:app --reload
```

Docs available at `http://localhost:8000/docs`.

### Frontend
```bash
cd frontend
npm install
npm run dev
```

### Market Data

Fetch historical futures data from Databento and migrate to TimescaleDB:
```bash
cd backend
python fetch_databento.py --update
python db/migrate_parquet_to_pg.py
```

`python fetch_databento.py --update` now resolves the next start timestamp from
TimescaleDB first, then falls back to local parquet if the DB has no rows yet.
Use `--check-cost` to preview the exact fetch window before spending anything:

```bash
cd backend
python fetch_databento.py --update --check-cost
```

Supported symbols: NQ, MNQ, ES, MES, GC, MGC (CME Globex continuous contracts).

To check cost before fetching:
```bash
python backend/fetch_databento.py --check-cost --start 2024-01-01
```

## API

| Method | Endpoint                          | Description                          |
|--------|-----------------------------------|--------------------------------------|
| GET    | /api/data/db/symbols              | List available symbols in DB         |
| GET    | /api/data/db/{symbol}/candles     | Fetch OHLCV bars via time_bucket()   |
| GET    | /api/data/db/{symbol}/info        | Symbol metadata and date range       |
| POST   | /api/data/upload                  | Upload a CSV dataset                 |
| POST   | /api/data/sample                  | Generate synthetic OHLCV data        |
| POST   | /api/backtests                    | Run a backtest                       |
| GET    | /api/backtests                    | List completed backtests             |
| GET    | /api/backtests/{id}               | Fetch backtest result                |
| GET    | /api/backtests/compare?a={}&b={}  | Compare two backtest results         |
| GET    | /api/prop-firms                   | List all prop firm presets           |
| GET    | /api/prop-firms/{preset_name}     | Fetch a single preset by key         |
| POST   | /api/prop-firms/validate          | Validate a custom rule set           |

## Strategies

| Strategy        | Signal Logic                                           |
|-----------------|--------------------------------------------------------|
| MA Crossover    | Fast SMA crosses above/below slow SMA                  |
| EMA Crossover   | Fast EMA crosses above/below slow EMA                  |
| RSI             | RSI crosses oversold (long) or overbought (short)      |
| Bollinger Bands | Price touches lower band (long) or upper band (short)  |

## Prop Firm Presets

| Firm                    | Account Sizes   | Daily Loss | Max Drawdown | Profit Target | Consistency | Drawdown Type | Min Days |
|-------------------------|-----------------|------------|--------------|---------------|-------------|---------------|----------|
| TopStep                 | 50k, 100k, 150k | 5%         | 8%           | 8%            | 35% cap     | Intraday      | 30       |
| My Funded Futures       | 50k, 100k, 150k | 4%         | 8%           | 8%            | None        | Intraday      | 15       |
| My Funded Futures Rapid | 50k, 100k, 150k | 4%         | 8%           | 8%            | None        | EOD           | 15       |
| My Funded Futures Flex  | 50k, 100k, 150k | 4%         | 8%           | 8%            | None        | Intraday      | 15       |
| FTMO                    | 50k, 100k, 150k | 5%         | 10%          | 10%           | 30% cap     | Intraday      | 30       |
| Apex Trader Funding     | 50k, 100k, 150k | 4%         | 6%           | 6%            | None        | Intraday      | None     |
| Lucid LucidPro          | 50k, 100k, 150k | 2-2.4%     | 3-4%         | 5-6%          | 40% cap     | EOD           | 5        |
| Lucid LucidFlex         | 50k, 100k, 150k | None       | 3-4%         | 5-6%          | 50% cap     | EOD           | 2        |

Preset keys follow the pattern `{firm}_{size}` (e.g. `topstep_100k`, `mff_rapid_50k`,
`lucid_pro_150k`). Pass these to `GET /api/prop-firms/{preset_name}` or use
`GET /api/prop-firms` to list all presets with full rule sets.

Intraday drawdown is measured as a rolling peak-to-trough against the running equity peak.
EOD drawdown is measured from the original account size. The distinction matters — EOD is
generally stricter for accounts that have not grown significantly yet.

## Status

- [x] C++17 pybind11 backtest kernel
- [x] Databento parquet fetcher (NQ, MNQ, ES, MES, GC, MGC)
- [x] TimescaleDB schema and migration
- [x] Database service layer with time_bucket() aggregation
- [x] FastAPI backend with backtest, data, and prop firm routers
- [x] SolidJS dashboard with Lightweight Charts
- [x] Docker + docker-compose infrastructure
- [x] Prop firm presets (TopStep, MFF, FTMO, Apex, Lucid)
- [ ] Backtest configuration UI
- [ ] Manual chart replay with trade entry
- [ ] PostgreSQL persistence for backtest results
- [ ] Authentication
