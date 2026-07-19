import json
from threading import Lock
from typing import Any

from psycopg2.extras import RealDictCursor


_schema_lock = Lock()
_schema_ready = False


def configure_budget(campaign_id: str, *, hypothesis_budget: int, trial_budget: int, event: dict) -> dict | None:
    from services.db import _conn

    with _conn() as conn:
        _ensure_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                UPDATE research_campaigns
                SET hypothesis_budget = %s, hypothesis_trial_budget = %s, updated_at = %s
                WHERE campaign_id = %s
                  AND status NOT IN ('queued', 'running')
                  AND NOT EXISTS (
                      SELECT 1 FROM research_hypothesis_attempts WHERE campaign_id = %s
                  )
                RETURNING campaign_id, hypothesis_budget, hypothesis_trial_budget
                """,
                [hypothesis_budget, trial_budget, event["created_at"], campaign_id, campaign_id],
            )
            row = cur.fetchone()
            if row is not None:
                _insert_event(cur, event)
        conn.commit()
    return _budget_row(row) if row is not None else None


def get_budget(campaign_id: str) -> dict | None:
    from services.db import _conn

    with _conn() as conn:
        _ensure_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT c.campaign_id, c.hypothesis_budget, c.hypothesis_trial_budget,
                       COUNT(a.hypothesis_attempt_id) AS attempted_hypotheses,
                       COUNT(a.hypothesis_attempt_id) FILTER (WHERE a.status = 'accepted') AS accepted_hypotheses,
                       COUNT(x.hypothesis_attempt_id) AS executed_trials
                FROM research_campaigns c
                LEFT JOIN research_hypothesis_attempts a ON a.campaign_id = c.campaign_id
                LEFT JOIN research_hypothesis_trial_links x
                  ON x.hypothesis_attempt_id = a.hypothesis_attempt_id
                WHERE c.campaign_id = %s
                GROUP BY c.campaign_id
                """,
                [campaign_id],
            )
            row = cur.fetchone()
    return _budget_row(row) if row is not None else None


def list_comparable_attempts(campaign_id: str, strategy_primitive: str, *, limit: int = 1_000) -> list[dict]:
    from services.db import _conn

    with _conn() as conn:
        _ensure_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT hypothesis_attempt_id, fingerprint, proposal
                FROM research_hypothesis_attempts
                WHERE campaign_id = %s AND status = 'accepted'
                  AND lower(proposal->>'strategy_primitive') = %s
                ORDER BY created_at, hypothesis_attempt_id
                LIMIT %s
                """,
                [campaign_id, strategy_primitive, limit],
            )
            return [_attempt_row(row) for row in cur.fetchall()]


def create_attempt(attempt: dict, event: dict) -> dict:
    from services.db import _conn

    with _conn() as conn:
        _ensure_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", [attempt["campaign_id"]])
            _enforce_concurrent_decision(cur, attempt)
            event["summary"] = (
                f"Recorded {attempt['status']} research hypothesis attempt "
                f"{attempt['hypothesis_attempt_id']}."
            )
            event["payload"].update({
                "status": attempt["status"],
                "duplicate_of_attempt_id": attempt.get("duplicate_of_attempt_id"),
                "rejection_reasons": attempt.get("rejection_reasons") or [],
            })
            cur.execute(
                """
                INSERT INTO research_hypothesis_attempts (
                    hypothesis_attempt_id, campaign_id, fingerprint, near_duplicate_key,
                    status, proposal, compiled_trial, rejection_reasons,
                    duplicate_of_attempt_id, created_at
                ) VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s, %s)
                RETURNING *
                """,
                [
                    attempt["hypothesis_attempt_id"], attempt["campaign_id"], attempt["fingerprint"],
                    attempt.get("near_duplicate_key"), attempt["status"],
                    json.dumps(attempt["proposal"], sort_keys=True),
                    json.dumps(attempt.get("compiled_trial"), sort_keys=True),
                    json.dumps(attempt.get("rejection_reasons") or []),
                    attempt.get("duplicate_of_attempt_id"), attempt["created_at"],
                ],
            )
            row = cur.fetchone()
            _insert_event(cur, event)
        conn.commit()
    return _attempt_row(row)


def _enforce_concurrent_decision(cur, attempt: dict) -> None:
    """Recheck duplicate and budget gates while holding the campaign lock."""
    if attempt["status"] != "accepted":
        return
    contract = attempt["compiled_trial"]
    cur.execute(
        """
        SELECT hypothesis_attempt_id, fingerprint, compiled_trial
        FROM research_hypothesis_attempts
        WHERE campaign_id = %s AND status = 'accepted'
          AND compiled_trial->>'strategy_type' = %s
        ORDER BY created_at, hypothesis_attempt_id
        """,
        [attempt["campaign_id"], contract["strategy_type"]],
    )
    comparable = [dict(row) for row in cur.fetchall()]
    exact = next((row for row in comparable if row["fingerprint"] == attempt["fingerprint"]), None)
    if exact is not None:
        _reject_attempt(
            attempt, "duplicate", exact["hypothesis_attempt_id"],
            "an accepted hypothesis already compiles to the same trial specification",
        )
        return

    ranges = attempt.get("near_duplicate_ranges") or {}
    params = contract["strategy_params"]
    for row in comparable:
        other_contract = row["compiled_trial"]
        if isinstance(other_contract, str):
            other_contract = json.loads(other_contract)
        other = other_contract.get("strategy_params") or {}
        if set(other) != set(params):
            continue
        distance = max(
            abs(float(params[key]) - float(other[key])) / max(float(ranges.get(key, 1.0)), 1.0)
            for key in params
        )
        if 0 < distance <= 0.10:
            _reject_attempt(
                attempt, "near_duplicate", row["hypothesis_attempt_id"],
                "proposal is within 0.10 normalized parameter distance of an accepted hypothesis",
            )
            attempt["near_duplicate_key"] = row["fingerprint"]
            return


    cur.execute(
        """
        SELECT c.hypothesis_budget, c.hypothesis_trial_budget,
               COUNT(a.hypothesis_attempt_id) AS attempts,
               COUNT(a.hypothesis_attempt_id) FILTER (WHERE a.status = 'accepted') AS accepted
        FROM research_campaigns c
        LEFT JOIN research_hypothesis_attempts a ON a.campaign_id = c.campaign_id
        WHERE c.campaign_id = %s
        GROUP BY c.campaign_id
        """,
        [attempt["campaign_id"]],
    )
    budget = cur.fetchone()
    if int(budget["attempts"] or 0) >= int(budget["hypothesis_budget"]):
        _reject_attempt(attempt, "budget_rejected", None, "campaign hypothesis-attempt budget is exhausted")
    elif int(budget["accepted"] or 0) >= int(budget["hypothesis_trial_budget"]):
        _reject_attempt(attempt, "budget_rejected", None, "campaign compiled-trial budget is exhausted")


def _reject_attempt(attempt: dict, status: str, duplicate_of: str | None, reason: str) -> None:
    attempt["status"] = status
    attempt["compiled_trial"] = None
    attempt["duplicate_of_attempt_id"] = duplicate_of
    attempt["rejection_reasons"] = [reason]


def get_attempt(campaign_id: str, attempt_id: str) -> dict | None:
    from services.db import _conn

    with _conn() as conn:
        _ensure_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT a.*, x.trial_id
                FROM research_hypothesis_attempts a
                LEFT JOIN research_hypothesis_trial_links x
                  ON x.hypothesis_attempt_id = a.hypothesis_attempt_id
                WHERE a.campaign_id = %s AND a.hypothesis_attempt_id = %s
                """,
                [campaign_id, attempt_id],
            )
            row = cur.fetchone()
    return _attempt_row(row) if row is not None else None


def list_attempts(campaign_id: str, *, limit: int, offset: int, status: str | None = None) -> list[dict]:
    from services.db import _conn

    clause = "a.campaign_id = %s"
    params: list[Any] = [campaign_id]
    if status is not None:
        clause += " AND a.status = %s"
        params.append(status)
    params.extend([limit, offset])
    with _conn() as conn:
        _ensure_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                f"""
                SELECT a.*, x.trial_id
                FROM research_hypothesis_attempts a
                LEFT JOIN research_hypothesis_trial_links x
                  ON x.hypothesis_attempt_id = a.hypothesis_attempt_id
                WHERE {clause}
                ORDER BY a.created_at DESC, a.hypothesis_attempt_id DESC
                LIMIT %s OFFSET %s
                """,
                params,
            )
            return [_attempt_row(row) for row in cur.fetchall()]


def link_trial(attempt_id: str, trial_id: str, *, actor: str, executed_at, event: dict) -> str:
    from services.db import _conn

    with _conn() as conn:
        _ensure_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                INSERT INTO research_hypothesis_trial_links (
                    hypothesis_attempt_id, trial_id, executed_by, executed_at
                ) VALUES (%s, %s, %s, %s)
                ON CONFLICT (hypothesis_attempt_id) DO NOTHING
                RETURNING trial_id
                """,
                [attempt_id, trial_id, actor, executed_at],
            )
            row = cur.fetchone()
            if row is not None:
                _insert_event(cur, event)
            else:
                cur.execute(
                    "SELECT trial_id FROM research_hypothesis_trial_links WHERE hypothesis_attempt_id = %s",
                    [attempt_id],
                )
                row = cur.fetchone()
        conn.commit()
    return str(row["trial_id"])


def _budget_row(row: dict) -> dict:
    return {
        "campaign_id": row["campaign_id"],
        "hypothesis_budget": int(row["hypothesis_budget"]) if row.get("hypothesis_budget") is not None else None,
        "trial_budget": int(row["hypothesis_trial_budget"]) if row.get("hypothesis_trial_budget") is not None else None,
        "attempted_hypotheses": int(row.get("attempted_hypotheses") or 0),
        "accepted_hypotheses": int(row.get("accepted_hypotheses") or 0),
        "executed_trials": int(row.get("executed_trials") or 0),
    }


def _attempt_row(row: dict) -> dict:
    result = dict(row)
    for key in ("proposal", "compiled_trial", "rejection_reasons"):
        value = result.get(key)
        result[key] = json.loads(value) if isinstance(value, str) else value
    return result


def _insert_event(cur, event: dict) -> None:
    cur.execute(
        """
        INSERT INTO research_campaign_events (
            research_campaign_event_id, campaign_id, event_type, actor, summary, payload, created_at
        ) VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s)
        """,
        [event["research_campaign_event_id"], event["campaign_id"], event["event_type"], event["actor"],
         event["summary"], json.dumps(event.get("payload") or {}, sort_keys=True), event["created_at"]],
    )


def _ensure_schema(conn) -> None:
    global _schema_ready
    if _schema_ready:
        return
    with _schema_lock:
        if _schema_ready:
            return
        with conn.cursor() as cur:
            cur.execute(_SCHEMA_SQL)
        conn.commit()
        _schema_ready = True


_SCHEMA_SQL = """
ALTER TABLE research_campaigns ADD COLUMN IF NOT EXISTS hypothesis_budget INTEGER;
ALTER TABLE research_campaigns ADD COLUMN IF NOT EXISTS hypothesis_trial_budget INTEGER;

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
"""
