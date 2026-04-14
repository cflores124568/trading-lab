-- TimescaleDB schema
-- Run once against a fresh database.
-- psql $DATABASE_URL -f schema.sql

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- OHLCV hypertable 
-- One row per 1-minute bar per symbol.
-- TimescaleDB partitions by ts automatically (where hunk_time_interval = 1 month
CREATE TABLE IF NOT EXISTS ohlcv_1m (
    ts          TIMESTAMPTZ     NOT NULL,
    symbol      TEXT            NOT NULL,  
    open        DOUBLE PRECISION NOT NULL,
    high        DOUBLE PRECISION NOT NULL,
    low         DOUBLE PRECISION NOT NULL,
    close       DOUBLE PRECISION NOT NULL,
    volume      DOUBLE PRECISION NOT NULL
);

-- Promote to hypertable partitioned on time
SELECT create_hypertable(
    'ohlcv_1m',
    'ts',
    chunk_time_interval => INTERVAL '1 month',
    if_not_exists       => TRUE
);

-- Indexes 
-- Primary lookup pattern: WHERE symbol = $1 AND ts BETWEEN $2 AND $3
-- TimescaleDB already adds a ts index; we add a composite to cover symbol too.
CREATE UNIQUE INDEX IF NOT EXISTS ohlcv_1m_symbol_ts_idx
    ON ohlcv_1m (symbol, ts DESC);

-- ── Continuous aggregate (optional but useful) 
-- Pre-materialised 1-hour bars refreshed automatically.
-- The 5-min and 15-min views are computed on the fly from 1m data via
-- time_bucket() in Python 
CREATE MATERIALIZED VIEW IF NOT EXISTS ohlcv_1h
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', ts) AS bucket,
    symbol,
    first(open,  ts)          AS open,
    max(high)                 AS high,
    min(low)                  AS low,
    last(close,  ts)          AS close,
    sum(volume)               AS volume
FROM ohlcv_1m
GROUP BY bucket, symbol
WITH NO DATA;

-- Refresh policy: keep the last 90 days hot, lag 1h so we don't race live data
SELECT add_continuous_aggregate_policy(
    'ohlcv_1h',
    start_offset => INTERVAL '90 days',
    end_offset   => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists => TRUE
);

--  Symbol metadata 
CREATE TABLE IF NOT EXISTS symbols (
    symbol          TEXT        PRIMARY KEY,
    full_name       TEXT        NOT NULL,
    exchange        TEXT        NOT NULL DEFAULT 'CME',
    tick_size       DOUBLE PRECISION NOT NULL DEFAULT 0.25,
    tick_value      DOUBLE PRECISION NOT NULL DEFAULT 12.50,  -- ES/MES micro = $12.50/pt
    currency        TEXT        NOT NULL DEFAULT 'USD',
    inserted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO symbols (symbol, full_name, exchange, tick_size, tick_value) VALUES
    ('NQ',  'E-mini NASDAQ-100',        'CME', 0.25,  5.00),
    ('MNQ', 'Micro E-mini NASDAQ-100',  'CME', 0.25,  0.50),
    ('ES',  'E-mini S&P 500',           'CME', 0.25, 12.50),
    ('MES', 'Micro E-mini S&P 500',     'CME', 0.25,  1.25),
    ('GC',  'Gold Futures',             'CMX', 0.10, 10.00),
    ('MGC', 'Micro Gold Futures',       'CMX', 0.10,  1.00)
ON CONFLICT (symbol) DO NOTHING;

-- Backtest result persistence
CREATE TABLE IF NOT EXISTS backtests (
    backtest_id      TEXT PRIMARY KEY,
    dataset_id       TEXT NOT NULL,
    symbol           TEXT,
    replay_context   JSONB,
    strategy_type    TEXT NOT NULL,
    strategy         JSONB NOT NULL,
    prop_firm_rules  JSONB NOT NULL,
    status           TEXT NOT NULL DEFAULT 'completed',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    trades           JSONB NOT NULL,
    metrics          JSONB NOT NULL,
    prop_firm_eval   JSONB NOT NULL,
    equity_curve     JSONB NOT NULL
);

ALTER TABLE backtests
    ADD COLUMN IF NOT EXISTS symbol TEXT;

ALTER TABLE backtests
    ADD COLUMN IF NOT EXISTS replay_context JSONB;

CREATE INDEX IF NOT EXISTS backtests_created_at_idx
    ON backtests (created_at DESC);

CREATE INDEX IF NOT EXISTS backtests_strategy_type_idx
    ON backtests (strategy_type);

CREATE INDEX IF NOT EXISTS backtests_dataset_id_idx
    ON backtests (dataset_id);

CREATE INDEX IF NOT EXISTS backtests_symbol_idx
    ON backtests (symbol);

-- Standalone replay session persistence
CREATE TABLE IF NOT EXISTS replay_sessions (
    replay_session_id TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    symbol            TEXT NOT NULL,
    interval          TEXT NOT NULL,
    start_date        TEXT,
    end_date          TEXT,
    source_backtest   JSONB,
    prop_firm_rules   JSONB NOT NULL,
    commission        DOUBLE PRECISION NOT NULL DEFAULT 5,
    tick_value        DOUBLE PRECISION NOT NULL,
    current_bar_index INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'active',
    actions           JSONB NOT NULL,
    trades            JSONB NOT NULL,
    metrics           JSONB NOT NULL,
    prop_firm_eval    JSONB NOT NULL,
    equity_curve      JSONB NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE replay_sessions
    ADD COLUMN IF NOT EXISTS source_backtest JSONB;

CREATE INDEX IF NOT EXISTS replay_sessions_updated_at_idx
    ON replay_sessions (updated_at DESC);

CREATE INDEX IF NOT EXISTS replay_sessions_symbol_idx
    ON replay_sessions (symbol);

-- Experiment runner persistence
CREATE TABLE IF NOT EXISTS experiments (
    experiment_id    TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    symbols          JSONB NOT NULL,
    intervals        JSONB NOT NULL,
    strategy_type    TEXT NOT NULL,
    parameter_space  JSONB NOT NULL,
    start_date       TEXT,
    end_date         TEXT,
    prop_firm_rules  JSONB NOT NULL,
    initial_balance  DOUBLE PRECISION NOT NULL DEFAULT 100000,
    position_size    DOUBLE PRECISION NOT NULL DEFAULT 1,
    commission       DOUBLE PRECISION NOT NULL DEFAULT 5,
    scoring_rule     TEXT NOT NULL DEFAULT 'prop_score_v1',
    status           TEXT NOT NULL DEFAULT 'draft',
    total_runs       INTEGER NOT NULL DEFAULT 0,
    completed_runs   INTEGER NOT NULL DEFAULT 0,
    failed_runs      INTEGER NOT NULL DEFAULT 0,
    best_run_id      TEXT,
    best_backtest_id TEXT,
    last_run_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS experiments_updated_at_idx
    ON experiments (updated_at DESC);

CREATE TABLE IF NOT EXISTS experiment_runs (
    experiment_run_id TEXT PRIMARY KEY,
    experiment_id     TEXT NOT NULL,
    backtest_id       TEXT,
    symbol            TEXT NOT NULL,
    interval          TEXT NOT NULL,
    strategy_type     TEXT NOT NULL,
    strategy_params   JSONB NOT NULL,
    dataset_id        TEXT,
    status            TEXT NOT NULL,
    score             DOUBLE PRECISION,
    rank              INTEGER,
    total_pnl         DOUBLE PRECISION,
    win_rate          DOUBLE PRECISION,
    max_drawdown      DOUBLE PRECISION,
    profit_factor     DOUBLE PRECISION,
    passed            BOOLEAN,
    error             TEXT,
    metrics           JSONB,
    prop_firm_eval    JSONB,
    is_candidate      BOOLEAN NOT NULL DEFAULT FALSE,
    promoted_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE experiment_runs
    ADD COLUMN IF NOT EXISTS is_candidate BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE experiment_runs
    ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS experiment_runs_experiment_id_idx
    ON experiment_runs (experiment_id);

CREATE INDEX IF NOT EXISTS experiment_runs_score_idx
    ON experiment_runs (experiment_id, score DESC NULLS LAST);

-- Durable dataset registry
CREATE TABLE IF NOT EXISTS datasets (
    dataset_id     TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    source_kind    TEXT NOT NULL,
    symbol         TEXT,
    interval       TEXT,
    rows           INTEGER NOT NULL DEFAULT 0,
    columns_json   JSONB NOT NULL DEFAULT '[]'::jsonb,
    start_date     TIMESTAMPTZ,
    end_date       TIMESTAMPTZ,
    locator        JSONB,
    is_rebuildable BOOLEAN NOT NULL DEFAULT FALSE,
    uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS datasets_uploaded_at_idx
    ON datasets (uploaded_at DESC);

CREATE INDEX IF NOT EXISTS datasets_source_kind_idx
    ON datasets (source_kind);

CREATE INDEX IF NOT EXISTS datasets_symbol_idx
    ON datasets (symbol);
