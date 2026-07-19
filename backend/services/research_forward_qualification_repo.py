import json
from threading import Lock

from psycopg2.extras import RealDictCursor

from services.research_repo import _ensure_research_schema, _insert_event, _maybe_json


_schema_lock = Lock()
_schema_ready = False


def _ensure_forward_qualification_schema(conn) -> None:
    global _schema_ready
    if _schema_ready:
        return
    with _schema_lock:
        if _schema_ready:
            return
        from services.candidate_repo import _ensure_candidates_schema
        from services.paper_session_repo import _ensure_paper_sessions_schema

        _ensure_research_schema(conn)
        _ensure_candidates_schema(conn)
        _ensure_paper_sessions_schema(conn)
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS research_forward_qualifications (
                    qualification_id TEXT PRIMARY KEY,
                    research_candidate_id TEXT NOT NULL UNIQUE
                        REFERENCES research_candidate_promotions(research_candidate_id),
                    campaign_id TEXT NOT NULL REFERENCES research_campaigns(campaign_id),
                    trial_id TEXT NOT NULL REFERENCES research_trials(trial_id),
                    candidate_id TEXT NOT NULL UNIQUE REFERENCES candidates(candidate_id),
                    paper_session_id TEXT NOT NULL UNIQUE REFERENCES paper_sessions(paper_session_id),
                    status TEXT NOT NULL DEFAULT 'collecting',
                    min_forward_observations INTEGER NOT NULL,
                    min_forward_decisions INTEGER NOT NULL,
                    expected_behavior JSONB NOT NULL,
                    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
                    diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
                    gates JSONB NOT NULL DEFAULT '{}'::jsonb,
                    approval_required BOOLEAN NOT NULL DEFAULT TRUE,
                    handoff_rationale TEXT NOT NULL,
                    handed_off_by TEXT NOT NULL,
                    handed_off_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    refreshed_at TIMESTAMPTZ,
                    decided_by TEXT,
                    decided_at TIMESTAMPTZ,
                    decision_reason TEXT,
                    CONSTRAINT research_forward_status_check
                        CHECK (status IN ('collecting', 'qualified', 'rejected')),
                    CONSTRAINT research_forward_observation_count_check
                        CHECK (min_forward_observations > 0),
                    CONSTRAINT research_forward_decision_count_check
                        CHECK (min_forward_decisions > 0),
                    CONSTRAINT research_forward_terminal_state_check CHECK (
                        (status = 'collecting' AND decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
                        OR
                        (status IN ('qualified', 'rejected') AND decided_by IS NOT NULL
                         AND decided_at IS NOT NULL AND decision_reason IS NOT NULL)
                    )
                )
                """
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS research_forward_campaign_idx "
                "ON research_forward_qualifications (campaign_id, handed_off_at DESC)"
            )
        conn.commit()
        _schema_ready = True


def create_qualification(qualification: dict, event: dict) -> tuple[dict, bool]:
    from services.db import _conn

    with _conn() as conn:
        _ensure_forward_qualification_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                INSERT INTO research_forward_qualifications (
                    qualification_id, research_candidate_id, campaign_id, trial_id,
                    candidate_id, paper_session_id, status, min_forward_observations,
                    min_forward_decisions, expected_behavior, evidence, diagnostics,
                    gates, approval_required, handoff_rationale, handed_off_by, handed_off_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb,
                          %s::jsonb, %s::jsonb, %s, %s, %s, %s)
                ON CONFLICT (research_candidate_id) DO NOTHING
                RETURNING *
                """,
                [
                    qualification["qualification_id"], qualification["research_candidate_id"],
                    qualification["campaign_id"], qualification["trial_id"],
                    qualification["candidate_id"], qualification["paper_session_id"],
                    qualification["status"], qualification["min_forward_observations"],
                    qualification["min_forward_decisions"], _json(qualification["expected_behavior"]),
                    _json(qualification.get("evidence") or {}), _json(qualification.get("diagnostics") or {}),
                    _json(qualification.get("gates") or {}), qualification["approval_required"],
                    qualification["handoff_rationale"], qualification["handed_off_by"],
                    qualification["handed_off_at"],
                ],
            )
            row = cur.fetchone()
            created = row is not None
            if created:
                _insert_event(cur, event)
            else:
                cur.execute(
                    "SELECT * FROM research_forward_qualifications WHERE research_candidate_id = %s",
                    [qualification["research_candidate_id"]],
                )
                row = cur.fetchone()
        conn.commit()
    return _row(row), created


def get_qualification(qualification_id: str) -> dict | None:
    return _get_one("qualification_id", qualification_id)


def get_by_research_candidate(research_candidate_id: str) -> dict | None:
    return _get_one("research_candidate_id", research_candidate_id)


def get_by_paper_session(paper_session_id: str) -> dict | None:
    return _get_one("paper_session_id", paper_session_id)


def refresh_evidence(
    qualification_id: str,
    *,
    evidence: dict,
    diagnostics: dict,
    gates: dict,
    refreshed_at,
    event: dict,
) -> dict | None:
    from services.db import _conn

    with _conn() as conn:
        _ensure_forward_qualification_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                UPDATE research_forward_qualifications
                SET evidence = %s::jsonb, diagnostics = %s::jsonb, gates = %s::jsonb,
                    refreshed_at = %s
                WHERE qualification_id = %s AND status = 'collecting'
                RETURNING *
                """,
                [_json(evidence), _json(diagnostics), _json(gates), refreshed_at, qualification_id],
            )
            row = cur.fetchone()
            if row is not None:
                _insert_event(cur, event)
        conn.commit()
    return _row(row) if row is not None else None


def decide(
    qualification_id: str,
    *,
    outcome: str,
    actor: str,
    decided_at,
    reason: str,
    event: dict,
) -> dict | None:
    from services.db import _conn

    with _conn() as conn:
        _ensure_forward_qualification_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                UPDATE research_forward_qualifications
                SET status = %s, decided_by = %s, decided_at = %s, decision_reason = %s
                WHERE qualification_id = %s AND status = 'collecting'
                RETURNING *
                """,
                [outcome, actor, decided_at, reason, qualification_id],
            )
            row = cur.fetchone()
            if row is not None:
                _insert_event(cur, event)
        conn.commit()
    return _row(row) if row is not None else None


def _get_one(column: str, value: str) -> dict | None:
    from services.db import _conn

    allowed = {"qualification_id", "research_candidate_id", "paper_session_id"}
    if column not in allowed:
        raise ValueError("Unsupported forward qualification lookup.")
    with _conn() as conn:
        _ensure_forward_qualification_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(f"SELECT * FROM research_forward_qualifications WHERE {column} = %s", [value])
            row = cur.fetchone()
    return _row(row) if row is not None else None


def _row(row: dict) -> dict:
    result = dict(row)
    for key in ("expected_behavior", "evidence", "diagnostics", "gates"):
        result[key] = _maybe_json(result.get(key)) or {}
    result["min_forward_observations"] = int(result["min_forward_observations"])
    result["min_forward_decisions"] = int(result["min_forward_decisions"])
    return result


def _json(value: dict) -> str:
    return json.dumps(value, sort_keys=True)
