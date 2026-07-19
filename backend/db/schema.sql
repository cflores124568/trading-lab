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
    run_config       JSONB,
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

ALTER TABLE backtests
    ADD COLUMN IF NOT EXISTS run_config JSONB;

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
    slippage_ticks   DOUBLE PRECISION NOT NULL DEFAULT 1,
    execution_mode   TEXT NOT NULL DEFAULT 'bar',
    spread_ticks     INTEGER NOT NULL DEFAULT 1,
    volatile_bar_threshold_ticks INTEGER NOT NULL DEFAULT 0,
    volatile_bar_extra_ticks     INTEGER NOT NULL DEFAULT 0,
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

ALTER TABLE experiments
    ADD COLUMN IF NOT EXISTS slippage_ticks DOUBLE PRECISION NOT NULL DEFAULT 1;

ALTER TABLE experiments
    ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'bar';

ALTER TABLE experiments
    ADD COLUMN IF NOT EXISTS spread_ticks INTEGER NOT NULL DEFAULT 1;

ALTER TABLE experiments
    ADD COLUMN IF NOT EXISTS volatile_bar_threshold_ticks INTEGER NOT NULL DEFAULT 0;

ALTER TABLE experiments
    ADD COLUMN IF NOT EXISTS volatile_bar_extra_ticks INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS experiment_runs (
    experiment_run_id TEXT PRIMARY KEY,
    experiment_id     TEXT NOT NULL,
    candidate_id      TEXT,
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
    ADD COLUMN IF NOT EXISTS candidate_id TEXT;

ALTER TABLE experiment_runs
    ADD COLUMN IF NOT EXISTS is_candidate BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE experiment_runs
    ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS experiment_runs_experiment_id_idx
    ON experiment_runs (experiment_id);

CREATE INDEX IF NOT EXISTS experiment_runs_score_idx
    ON experiment_runs (experiment_id, score DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS experiment_runs_candidate_id_idx
    ON experiment_runs (candidate_id);

-- Phase 2 research candidates
CREATE TABLE IF NOT EXISTS candidates (
    candidate_id        TEXT PRIMARY KEY,
    experiment_id       TEXT NOT NULL,
    experiment_name     TEXT NOT NULL,
    experiment_run_id   TEXT NOT NULL UNIQUE,
    backtest_id         TEXT NOT NULL,
    symbol              TEXT NOT NULL,
    interval            TEXT NOT NULL,
    strategy_type       TEXT NOT NULL,
    strategy_params     JSONB NOT NULL,
    prop_firm_rules     JSONB NOT NULL,
    experiment_snapshot JSONB NOT NULL,
    score               DOUBLE PRECISION,
    rank                INTEGER,
    total_pnl           DOUBLE PRECISION,
    win_rate            DOUBLE PRECISION,
    max_drawdown        DOUBLE PRECISION,
    profit_factor       DOUBLE PRECISION,
    passed              BOOLEAN,
    metrics             JSONB,
    prop_firm_eval      JSONB,
    lifecycle_status    TEXT NOT NULL DEFAULT 'candidate',
    promotion_reason    TEXT NOT NULL,
    promoted_by         TEXT NOT NULL DEFAULT 'local-user',
    promoted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    approved_by         TEXT,
    approved_at         TIMESTAMPTZ,
    paper_bot           JSONB,
    notes               JSONB NOT NULL DEFAULT '[]'::jsonb,
    audit_log           JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS candidates_updated_at_idx
    ON candidates (updated_at DESC);

CREATE INDEX IF NOT EXISTS candidates_status_idx
    ON candidates (lifecycle_status);

CREATE INDEX IF NOT EXISTS candidates_experiment_id_idx
    ON candidates (experiment_id);

CREATE INDEX IF NOT EXISTS candidates_backtest_id_idx
    ON candidates (backtest_id);

-- Phase 3 durable paper runtime shell
CREATE TABLE IF NOT EXISTS paper_sessions (
    paper_session_id TEXT PRIMARY KEY,
    candidate_id     TEXT NOT NULL UNIQUE,
    paper_bot_id     TEXT,
    name             TEXT NOT NULL,
    symbol           TEXT NOT NULL,
    interval         TEXT NOT NULL,
    strategy_type    TEXT NOT NULL,
    strategy_params  JSONB NOT NULL,
    prop_firm_rules  JSONB NOT NULL,
    guardrails       JSONB NOT NULL DEFAULT '{}'::jsonb,
    status           TEXT NOT NULL DEFAULT 'draft',
    commission       DOUBLE PRECISION NOT NULL DEFAULT 5,
    tick_value       DOUBLE PRECISION NOT NULL DEFAULT 1,
    current_position JSONB NOT NULL DEFAULT '{}'::jsonb,
    trade_log        JSONB NOT NULL DEFAULT '[]'::jsonb,
    equity_curve     JSONB NOT NULL DEFAULT '[]'::jsonb,
    metrics_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    guardrail_state  JSONB NOT NULL DEFAULT '{}'::jsonb,
    runner_state     JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_bar_time    TIMESTAMPTZ,
    last_event_at    TIMESTAMPTZ,
    created_by       TEXT NOT NULL DEFAULT 'local-user',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS paper_sessions_updated_at_idx
    ON paper_sessions (updated_at DESC);

CREATE INDEX IF NOT EXISTS paper_sessions_status_idx
    ON paper_sessions (status);

CREATE TABLE IF NOT EXISTS paper_events (
    paper_event_id   TEXT PRIMARY KEY,
    paper_session_id TEXT NOT NULL,
    candidate_id     TEXT NOT NULL,
    event_type       TEXT NOT NULL,
    actor            TEXT NOT NULL DEFAULT 'local-user',
    summary          TEXT NOT NULL,
    payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS paper_events_session_created_idx
    ON paper_events (paper_session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS paper_runner_leases (
    paper_session_id TEXT PRIMARY KEY,
    owner_id          TEXT NOT NULL,
    lease_token       TEXT NOT NULL UNIQUE,
    acquired_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    heartbeat_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at        TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS paper_runner_leases_expires_idx
    ON paper_runner_leases (expires_at);

CREATE INDEX IF NOT EXISTS paper_events_candidate_created_idx
    ON paper_events (candidate_id, created_at DESC);

ALTER TABLE paper_sessions
    ADD COLUMN IF NOT EXISTS commission DOUBLE PRECISION NOT NULL DEFAULT 5;

ALTER TABLE paper_sessions
    ADD COLUMN IF NOT EXISTS tick_value DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE paper_sessions
    ADD COLUMN IF NOT EXISTS runner_state JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE paper_sessions
    ADD COLUMN IF NOT EXISTS trade_log JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE paper_sessions
    ADD COLUMN IF NOT EXISTS equity_curve JSONB NOT NULL DEFAULT '[]'::jsonb;

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

-- Phase 4A Alpha Lab research foundation
CREATE TABLE IF NOT EXISTS research_campaigns (
    campaign_id       TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    symbol            TEXT NOT NULL,
    interval          TEXT NOT NULL,
    start_time        TIMESTAMPTZ NOT NULL,
    end_time          TIMESTAMPTZ NOT NULL,
    development_pct   NUMERIC(7,4) NOT NULL,
    validation_pct    NUMERIC(7,4) NOT NULL,
    holdout_pct       NUMERIC(7,4) NOT NULL,
    status            TEXT NOT NULL DEFAULT 'draft',
    total_bar_count   INTEGER NOT NULL,
    created_by        TEXT NOT NULL DEFAULT 'local-user',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT research_campaign_time_order CHECK (start_time <= end_time),
    CONSTRAINT research_campaign_split_total CHECK (
        development_pct > 0 AND validation_pct > 0 AND holdout_pct > 0
        AND development_pct + validation_pct + holdout_pct = 100
    ),
    CONSTRAINT research_campaign_status_check CHECK (
        status IN ('draft', 'queued', 'running', 'paused', 'completed', 'failed')
    ),
    CONSTRAINT research_campaign_bar_count CHECK (total_bar_count >= 3)
);

ALTER TABLE research_campaigns ADD COLUMN IF NOT EXISTS search_config JSONB;
ALTER TABLE research_campaigns ADD COLUMN IF NOT EXISTS trial_budget INTEGER;
ALTER TABLE research_campaigns ADD COLUMN IF NOT EXISTS wall_clock_budget_seconds INTEGER;
ALTER TABLE research_campaigns ADD COLUMN IF NOT EXISTS search_progress JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE research_campaigns ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ;
ALTER TABLE research_campaigns ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE research_campaigns ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ;
ALTER TABLE research_campaigns ADD COLUMN IF NOT EXISTS hypothesis_budget INTEGER;
ALTER TABLE research_campaigns ADD COLUMN IF NOT EXISTS hypothesis_trial_budget INTEGER;

CREATE TABLE IF NOT EXISTS research_campaign_partitions (
    campaign_id       TEXT NOT NULL REFERENCES research_campaigns(campaign_id),
    partition_name    TEXT NOT NULL,
    start_time        TIMESTAMPTZ NOT NULL,
    end_time          TIMESTAMPTZ NOT NULL,
    bar_count         INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, partition_name),
    CONSTRAINT research_partition_name_check CHECK (
        partition_name IN ('development', 'validation', 'holdout')
    ),
    CONSTRAINT research_partition_time_order CHECK (start_time <= end_time),
    CONSTRAINT research_partition_bar_count CHECK (bar_count > 0)
);

CREATE TABLE IF NOT EXISTS research_trials (
    trial_id          TEXT PRIMARY KEY,
    campaign_id       TEXT NOT NULL REFERENCES research_campaigns(campaign_id),
    fingerprint       TEXT NOT NULL,
    strategy_type     TEXT NOT NULL,
    strategy_params   JSONB NOT NULL DEFAULT '{}'::jsonb,
    execution_config  JSONB NOT NULL DEFAULT '{}'::jsonb,
    random_seed       BIGINT NOT NULL DEFAULT 0,
    status            TEXT NOT NULL,
    result            JSONB,
    error             TEXT,
    created_by        TEXT NOT NULL DEFAULT 'local-user',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at      TIMESTAMPTZ NOT NULL,
    CONSTRAINT research_trial_status_check CHECK (status IN ('completed', 'failed')),
    CONSTRAINT research_trial_outcome_check CHECK (
        (status = 'completed' AND error IS NULL) OR
        (status = 'failed' AND error IS NOT NULL)
    ),
    UNIQUE (campaign_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS research_campaign_leases (
    campaign_id TEXT PRIMARY KEY REFERENCES research_campaigns(campaign_id),
    owner_id TEXT NOT NULL,
    lease_token TEXT NOT NULL UNIQUE,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS research_campaign_leases_expires_idx ON research_campaign_leases (expires_at);

CREATE TABLE IF NOT EXISTS research_trial_evaluations (
    evaluation_id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES research_campaigns(campaign_id),
    trial_id TEXT NOT NULL REFERENCES research_trials(trial_id),
    evidence_fingerprint TEXT NOT NULL,
    outcome TEXT NOT NULL,
    robustness_score DOUBLE PRECISION NOT NULL,
    score_components JSONB NOT NULL,
    gates JSONB NOT NULL,
    rejection_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    diagnostics JSONB NOT NULL,
    evidence JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT research_evaluation_outcome_check CHECK (outcome IN ('research_finalist', 'rejected')),
    CONSTRAINT research_evaluation_score_check CHECK (robustness_score >= 0 AND robustness_score <= 100),
    UNIQUE (trial_id),
    UNIQUE (trial_id, evidence_fingerprint)
);

CREATE TABLE IF NOT EXISTS research_campaign_finalists (
    campaign_id TEXT NOT NULL REFERENCES research_campaigns(campaign_id),
    trial_id TEXT NOT NULL REFERENCES research_trials(trial_id),
    evaluation_id TEXT NOT NULL REFERENCES research_trial_evaluations(evaluation_id),
    frozen_validation_score DOUBLE PRECISION NOT NULL,
    holdout_status TEXT NOT NULL DEFAULT 'sealed',
    holdout_result JSONB,
    frozen_by TEXT NOT NULL,
    frozen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    holdout_evaluated_at TIMESTAMPTZ,
    PRIMARY KEY (campaign_id, trial_id),
    CONSTRAINT research_finalist_holdout_status_check CHECK (holdout_status IN ('sealed', 'evaluated')),
    CONSTRAINT research_finalist_score_check CHECK (
        frozen_validation_score >= 0 AND frozen_validation_score <= 100
    ),
    CONSTRAINT research_finalist_holdout_state_check CHECK (
        (holdout_status = 'sealed' AND holdout_result IS NULL AND holdout_evaluated_at IS NULL)
        OR (holdout_status = 'evaluated' AND holdout_result IS NOT NULL AND holdout_evaluated_at IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS research_candidate_promotions (
    research_candidate_id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES research_campaigns(campaign_id),
    trial_id TEXT NOT NULL REFERENCES research_trials(trial_id),
    evaluation_id TEXT NOT NULL REFERENCES research_trial_evaluations(evaluation_id),
    validation_score DOUBLE PRECISION NOT NULL,
    promotion_reason TEXT NOT NULL,
    promoted_by TEXT NOT NULL,
    promoted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT research_candidate_validation_score_check CHECK (
        validation_score >= 0 AND validation_score <= 100
    ),
    UNIQUE (campaign_id, trial_id)
);

CREATE INDEX IF NOT EXISTS research_evaluations_campaign_score_idx
    ON research_trial_evaluations (campaign_id, robustness_score DESC);
CREATE INDEX IF NOT EXISTS research_finalists_campaign_frozen_idx
    ON research_campaign_finalists (campaign_id, frozen_at DESC);
CREATE INDEX IF NOT EXISTS research_candidate_promotions_campaign_idx
    ON research_candidate_promotions (campaign_id, promoted_at DESC);

CREATE TABLE IF NOT EXISTS research_campaign_events (
    research_campaign_event_id TEXT PRIMARY KEY,
    campaign_id       TEXT NOT NULL REFERENCES research_campaigns(campaign_id),
    event_type        TEXT NOT NULL,
    actor             TEXT NOT NULL DEFAULT 'local-user',
    summary           TEXT NOT NULL,
    payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS research_campaigns_created_idx
    ON research_campaigns (created_at DESC);
CREATE INDEX IF NOT EXISTS research_campaigns_status_idx
    ON research_campaigns (status, created_at DESC);
CREATE INDEX IF NOT EXISTS research_trials_campaign_created_idx
    ON research_trials (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS research_trials_campaign_status_idx
    ON research_trials (campaign_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS research_campaign_events_created_idx
    ON research_campaign_events (campaign_id, created_at DESC);

-- Phase 4E keeps every agent proposal as an immutable attempt. Only accepted
-- attempts contain a compiled trial contract, and execution remains a separate
-- human-triggered research action.
CREATE TABLE IF NOT EXISTS research_hypothesis_attempts (
    hypothesis_attempt_id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES research_campaigns(campaign_id),
    fingerprint TEXT NOT NULL,
    near_duplicate_key TEXT,
    status TEXT NOT NULL,
    proposal JSONB NOT NULL,
    compiled_trial JSONB,
    rejection_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    duplicate_of_attempt_id TEXT REFERENCES research_hypothesis_attempts(hypothesis_attempt_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT research_hypothesis_status_check CHECK (
        status IN ('accepted', 'rejected', 'duplicate', 'near_duplicate', 'budget_rejected')
    ),
    CONSTRAINT research_hypothesis_compilation_check CHECK (
        (status = 'accepted' AND compiled_trial IS NOT NULL AND jsonb_array_length(rejection_reasons) = 0)
        OR (status <> 'accepted' AND compiled_trial IS NULL AND jsonb_array_length(rejection_reasons) > 0)
    )
);

CREATE TABLE IF NOT EXISTS research_hypothesis_trial_links (
    hypothesis_attempt_id TEXT PRIMARY KEY REFERENCES research_hypothesis_attempts(hypothesis_attempt_id),
    trial_id TEXT NOT NULL REFERENCES research_trials(trial_id),
    executed_by TEXT NOT NULL,
    executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS research_hypothesis_attempts_campaign_created_idx
    ON research_hypothesis_attempts (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS research_hypothesis_attempts_fingerprint_idx
    ON research_hypothesis_attempts (campaign_id, fingerprint);

CREATE OR REPLACE FUNCTION reject_research_trial_evaluation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'research trial evaluations are immutable';
END;
$$;

DROP TRIGGER IF EXISTS research_trial_evaluations_immutable ON research_trial_evaluations;
CREATE TRIGGER research_trial_evaluations_immutable
BEFORE UPDATE OR DELETE ON research_trial_evaluations
FOR EACH ROW EXECUTE FUNCTION reject_research_trial_evaluation_mutation();


CREATE OR REPLACE FUNCTION reject_research_campaign_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'research campaign audit events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS research_campaign_events_append_only ON research_campaign_events;
CREATE TRIGGER research_campaign_events_append_only
BEFORE UPDATE OR DELETE ON research_campaign_events
FOR EACH ROW EXECUTE FUNCTION reject_research_campaign_event_mutation();

CREATE OR REPLACE FUNCTION reject_research_hypothesis_attempt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'research hypothesis attempts are immutable';
END;
$$;

DROP TRIGGER IF EXISTS research_hypothesis_attempts_immutable ON research_hypothesis_attempts;
CREATE TRIGGER research_hypothesis_attempts_immutable
BEFORE UPDATE OR DELETE ON research_hypothesis_attempts
FOR EACH ROW EXECUTE FUNCTION reject_research_hypothesis_attempt_mutation();

CREATE OR REPLACE FUNCTION reject_research_hypothesis_trial_link_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'research hypothesis trial links are immutable';
END;
$$;

DROP TRIGGER IF EXISTS research_hypothesis_trial_links_immutable ON research_hypothesis_trial_links;
CREATE TRIGGER research_hypothesis_trial_links_immutable
BEFORE UPDATE OR DELETE ON research_hypothesis_trial_links
FOR EACH ROW EXECUTE FUNCTION reject_research_hypothesis_trial_link_mutation();
