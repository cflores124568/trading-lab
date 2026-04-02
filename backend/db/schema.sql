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
