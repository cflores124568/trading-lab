import json
from datetime import datetime
from threading import Lock
from typing import Any

from psycopg2.extras import RealDictCursor


MAX_PARTITION_SOURCE_BARS = 2_000_000
_schema_lock = Lock()
_schema_ready = False


def _ensure_research_schema(conn) -> None:
    global _schema_ready
    if _schema_ready:
        return

    with _schema_lock:
        if _schema_ready:
            return
        with conn.cursor() as cur:
            cur.execute(_RESEARCH_SCHEMA_SQL)
        conn.commit()
        _schema_ready = True


def list_research_bar_timestamps(
    *,
    symbol: str,
    interval: str,
    start_time: datetime,
    end_time: datetime,
) -> list[datetime]:
    """Read a bounded, ordered timestamp spine for deterministic partitioning."""
    from services.db import _bucket, _conn

    if interval == "1min":
        bars_sql = "SELECT ts FROM ohlcv_1m WHERE symbol = %s AND ts >= %s AND ts <= %s"
    else:
        bucket = _bucket(interval)
        bars_sql = (
            f"SELECT time_bucket('{bucket}', ts) AS ts FROM ohlcv_1m "
            "WHERE symbol = %s AND ts >= %s AND ts <= %s GROUP BY 1"
        )

    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute(f"SELECT COUNT(*) FROM ({bars_sql}) AS research_bars", [symbol, start_time, end_time])
            count = int(cur.fetchone()[0])
            if count > MAX_PARTITION_SOURCE_BARS:
                raise ValueError(
                    f"Campaign window contains {count} bars; the Phase 4A limit is "
                    f"{MAX_PARTITION_SOURCE_BARS}. Use a smaller window or larger interval."
                )
            cur.execute(f"{bars_sql} ORDER BY ts", [symbol, start_time, end_time])
            return [row[0] for row in cur.fetchall()]


def create_research_campaign(campaign: dict, partitions: list[dict], event: dict) -> dict:
    from services.db import _conn

    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO research_campaigns (
                    campaign_id, name, symbol, interval, start_time, end_time,
                    development_pct, validation_pct, holdout_pct, status,
                    total_bar_count, created_by, created_at, updated_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                [
                    campaign["campaign_id"], campaign["name"], campaign["symbol"], campaign["interval"],
                    campaign["start_time"], campaign["end_time"], campaign["development_pct"],
                    campaign["validation_pct"], campaign["holdout_pct"], campaign["status"],
                    campaign["total_bar_count"], campaign["created_by"], campaign["created_at"],
                    campaign["updated_at"],
                ],
            )
            for partition in partitions:
                cur.execute(
                    """
                    INSERT INTO research_campaign_partitions (
                        campaign_id, partition_name, start_time, end_time, bar_count
                    ) VALUES (%s, %s, %s, %s, %s)
                    """,
                    [
                        campaign["campaign_id"], partition["partition_name"], partition["start_time"],
                        partition["end_time"], partition["bar_count"],
                    ],
                )
            _insert_event(cur, event)
        conn.commit()
    return get_research_campaign(campaign["campaign_id"])


def list_research_campaigns(*, limit: int, offset: int, status: str | None = None) -> list[dict]:
    from services.db import _conn

    filters = ""
    params: list[Any] = []
    if status is not None:
        filters = "WHERE status = %s"
        params.append(status)
    params.extend([limit, offset])
    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                f"SELECT * FROM research_campaigns {filters} ORDER BY created_at DESC, campaign_id LIMIT %s OFFSET %s",
                params,
            )
            return [_campaign_row(row) for row in cur.fetchall()]


def get_research_campaign(campaign_id: str, *, event_limit: int = 100) -> dict | None:
    from services.db import _conn

    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT * FROM research_campaigns WHERE campaign_id = %s", [campaign_id])
            row = cur.fetchone()
            if row is None:
                return None
            campaign = _campaign_row(row)
            cur.execute(
                """
                SELECT partition_name, start_time, end_time, bar_count
                FROM research_campaign_partitions
                WHERE campaign_id = %s
                ORDER BY CASE partition_name
                    WHEN 'development' THEN 1 WHEN 'validation' THEN 2 ELSE 3 END
                """,
                [campaign_id],
            )
            campaign["partitions"] = [dict(partition) for partition in cur.fetchall()]
            cur.execute(
                """
                SELECT * FROM research_campaign_events
                WHERE campaign_id = %s
                ORDER BY created_at DESC, research_campaign_event_id DESC
                LIMIT %s
                """,
                [campaign_id, event_limit],
            )
            campaign["audit_events"] = [_event_row(event) for event in cur.fetchall()]
            return campaign


def create_research_trial(trial: dict, event: dict) -> tuple[dict, bool]:
    """Insert one immutable terminal attempt, or return its fingerprint twin."""
    from services.db import _conn

    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                INSERT INTO research_trials (
                    trial_id, campaign_id, fingerprint, strategy_type, strategy_params,
                    execution_config, random_seed, status, result, error, created_by,
                    created_at, completed_at
                ) VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s::jsonb, %s, %s, %s, %s)
                ON CONFLICT (campaign_id, fingerprint) DO NOTHING
                RETURNING *
                """,
                [
                    trial["trial_id"], trial["campaign_id"], trial["fingerprint"], trial["strategy_type"],
                    json.dumps(trial["strategy_params"], sort_keys=True),
                    json.dumps(trial["execution_config"], sort_keys=True), trial["random_seed"],
                    trial["status"], json.dumps(trial.get("result")), trial.get("error"),
                    trial["created_by"], trial["created_at"], trial["completed_at"],
                ],
            )
            row = cur.fetchone()
            created = row is not None
            if created:
                _insert_event(cur, event)
            else:
                cur.execute(
                    "SELECT * FROM research_trials WHERE campaign_id = %s AND fingerprint = %s",
                    [trial["campaign_id"], trial["fingerprint"]],
                )
                row = cur.fetchone()
        conn.commit()
    result = _trial_row(row)
    result["was_duplicate"] = not created
    return result, created


def list_research_trials(
    campaign_id: str,
    *,
    limit: int,
    offset: int,
    status: str | None = None,
) -> list[dict]:
    from services.db import _conn

    filters = "campaign_id = %s"
    params: list[Any] = [campaign_id]
    if status is not None:
        filters += " AND status = %s"
        params.append(status)
    params.extend([limit, offset])
    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                f"SELECT * FROM research_trials WHERE {filters} ORDER BY created_at DESC, trial_id LIMIT %s OFFSET %s",
                params,
            )
            return [_trial_row(row) for row in cur.fetchall()]


def get_research_trial(campaign_id: str, trial_id: str) -> dict | None:
    from services.db import _conn

    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM research_trials WHERE campaign_id = %s AND trial_id = %s",
                [campaign_id, trial_id],
            )
            row = cur.fetchone()
            return _trial_row(row) if row is not None else None


def _insert_event(cur, event: dict) -> None:
    cur.execute(
        """
        INSERT INTO research_campaign_events (
            research_campaign_event_id, campaign_id, event_type, actor, summary, payload, created_at
        ) VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s)
        """,
        [
            event["research_campaign_event_id"], event["campaign_id"], event["event_type"],
            event["actor"], event["summary"], json.dumps(event.get("payload") or {}, sort_keys=True),
            event["created_at"],
        ],
    )


def _campaign_row(row: dict) -> dict:
    result = dict(row)
    for key in ("development_pct", "validation_pct", "holdout_pct"):
        result[key] = float(result[key])
    result["total_bar_count"] = int(result["total_bar_count"])
    result["search_config"] = _maybe_json(result.get("search_config"))
    result["search_progress"] = _maybe_json(result.get("search_progress")) or {}
    result["trial_budget"] = int(result["trial_budget"]) if result.get("trial_budget") is not None else None
    result["wall_clock_budget_seconds"] = (
        int(result["wall_clock_budget_seconds"])
        if result.get("wall_clock_budget_seconds") is not None else None
    )
    return result


def _trial_row(row: dict) -> dict:
    result = dict(row)
    result["strategy_params"] = _maybe_json(result["strategy_params"])
    result["execution_config"] = _maybe_json(result["execution_config"])
    result["result"] = _maybe_json(result.get("result"))
    result["random_seed"] = int(result["random_seed"])
    result["was_duplicate"] = False
    return result


def _event_row(row: dict) -> dict:
    result = dict(row)
    result["payload"] = _maybe_json(result["payload"]) or {}
    return result


def _maybe_json(value: Any) -> Any:
    if isinstance(value, str):
        return json.loads(value)
    return value


_RESEARCH_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS research_campaigns (
    campaign_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    development_pct NUMERIC(7,4) NOT NULL,
    validation_pct NUMERIC(7,4) NOT NULL,
    holdout_pct NUMERIC(7,4) NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    total_bar_count INTEGER NOT NULL,
    created_by TEXT NOT NULL DEFAULT 'local-user',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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

CREATE TABLE IF NOT EXISTS research_campaign_partitions (
    campaign_id TEXT NOT NULL REFERENCES research_campaigns(campaign_id),
    partition_name TEXT NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    bar_count INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, partition_name),
    CONSTRAINT research_partition_name_check CHECK (partition_name IN ('development', 'validation', 'holdout')),
    CONSTRAINT research_partition_time_order CHECK (start_time <= end_time),
    CONSTRAINT research_partition_bar_count CHECK (bar_count > 0)
);

CREATE TABLE IF NOT EXISTS research_trials (
    trial_id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES research_campaigns(campaign_id),
    fingerprint TEXT NOT NULL,
    strategy_type TEXT NOT NULL,
    strategy_params JSONB NOT NULL DEFAULT '{}'::jsonb,
    execution_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    random_seed BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    result JSONB,
    error TEXT,
    created_by TEXT NOT NULL DEFAULT 'local-user',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT research_trial_status_check CHECK (status IN ('completed', 'failed')),
    CONSTRAINT research_trial_outcome_check CHECK (
        (status = 'completed' AND error IS NULL) OR (status = 'failed' AND error IS NOT NULL)
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
    campaign_id TEXT NOT NULL REFERENCES research_campaigns(campaign_id),
    event_type TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT 'local-user',
    summary TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS research_campaigns_created_idx ON research_campaigns (created_at DESC);
CREATE INDEX IF NOT EXISTS research_campaigns_status_idx ON research_campaigns (status, created_at DESC);
CREATE INDEX IF NOT EXISTS research_trials_campaign_created_idx ON research_trials (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS research_trials_campaign_status_idx ON research_trials (campaign_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS research_campaign_events_created_idx ON research_campaign_events (campaign_id, created_at DESC);

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
"""
