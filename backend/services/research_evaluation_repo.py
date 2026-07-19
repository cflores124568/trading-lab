import json

from psycopg2.extras import RealDictCursor

from services.research_repo import _ensure_research_schema, _insert_event, _maybe_json


def save_validation_evaluation(evaluation: dict, event: dict) -> tuple[dict, bool]:
    from services.db import _conn

    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                INSERT INTO research_trial_evaluations (
                    evaluation_id, campaign_id, trial_id, evidence_fingerprint, outcome,
                    robustness_score, score_components, gates, rejection_reasons,
                    warnings, diagnostics, evidence, created_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb,
                          %s::jsonb, %s::jsonb, %s::jsonb, %s)
                ON CONFLICT (trial_id) DO NOTHING
                RETURNING *
                """,
                [
                    evaluation["evaluation_id"], evaluation["campaign_id"], evaluation["trial_id"],
                    evaluation["evidence_fingerprint"], evaluation["outcome"],
                    evaluation["robustness_score"], _json(evaluation["score_components"]),
                    _json(evaluation["gates"]), _json(evaluation["rejection_reasons"]),
                    _json(evaluation["warnings"]), _json(evaluation["diagnostics"]),
                    _json(evaluation["evidence"]), evaluation["created_at"],
                ],
            )
            row = cur.fetchone()
            created = row is not None
            if created:
                _insert_event(cur, event)
            else:
                cur.execute("SELECT * FROM research_trial_evaluations WHERE trial_id = %s", [evaluation["trial_id"]])
                row = cur.fetchone()
        conn.commit()
    return _evaluation_row(row), created


def get_validation_evaluation(campaign_id: str, trial_id: str) -> dict | None:
    from services.db import _conn

    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM research_trial_evaluations WHERE campaign_id = %s AND trial_id = %s",
                [campaign_id, trial_id],
            )
            row = cur.fetchone()
            return _evaluation_row(row) if row else None


def freeze_finalist(finalist: dict, event: dict) -> tuple[dict, bool]:
    from services.db import _conn

    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                INSERT INTO research_campaign_finalists (
                    campaign_id, trial_id, evaluation_id, frozen_validation_score,
                    holdout_status, frozen_by, frozen_at
                ) VALUES (%s, %s, %s, %s, 'sealed', %s, %s)
                ON CONFLICT (campaign_id, trial_id) DO NOTHING
                RETURNING *
                """,
                [
                    finalist["campaign_id"], finalist["trial_id"], finalist["evaluation_id"],
                    finalist["frozen_validation_score"], finalist["frozen_by"], finalist["frozen_at"],
                ],
            )
            row = cur.fetchone()
            created = row is not None
            if created:
                _insert_event(cur, event)
            else:
                cur.execute(
                    "SELECT * FROM research_campaign_finalists WHERE campaign_id = %s AND trial_id = %s",
                    [finalist["campaign_id"], finalist["trial_id"]],
                )
                row = cur.fetchone()
        conn.commit()
    return _finalist_row(row), created


def record_holdout_once(campaign_id: str, trial_id: str, result: dict, evaluated_at, event: dict) -> dict | None:
    from services.db import _conn

    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                UPDATE research_campaign_finalists
                SET holdout_status = 'evaluated', holdout_result = %s::jsonb, holdout_evaluated_at = %s
                WHERE campaign_id = %s AND trial_id = %s AND holdout_status = 'sealed'
                RETURNING *
                """,
                [_json(result), evaluated_at, campaign_id, trial_id],
            )
            row = cur.fetchone()
            if row is not None:
                _insert_event(cur, event)
        conn.commit()
    return _finalist_row(row) if row else None


def get_finalist(campaign_id: str, trial_id: str) -> dict | None:
    from services.db import _conn

    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM research_campaign_finalists WHERE campaign_id = %s AND trial_id = %s",
                [campaign_id, trial_id],
            )
            row = cur.fetchone()
            return _finalist_row(row) if row else None


def list_finalists(campaign_id: str, *, limit: int, offset: int) -> list[dict]:
    from services.db import _conn

    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT * FROM research_campaign_finalists
                WHERE campaign_id = %s
                ORDER BY frozen_validation_score DESC, frozen_at, trial_id
                LIMIT %s OFFSET %s
                """,
                [campaign_id, limit, offset],
            )
            return [_finalist_row(row) for row in cur.fetchall()]


def promote_research_candidate(promotion: dict, event: dict) -> tuple[dict, bool]:
    from services.db import _conn

    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                INSERT INTO research_candidate_promotions (
                    research_candidate_id, campaign_id, trial_id, evaluation_id,
                    validation_score, promotion_reason, promoted_by, promoted_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (campaign_id, trial_id) DO NOTHING
                RETURNING *
                """,
                [
                    promotion["research_candidate_id"], promotion["campaign_id"],
                    promotion["trial_id"], promotion["evaluation_id"],
                    promotion["validation_score"], promotion["promotion_reason"],
                    promotion["promoted_by"], promotion["promoted_at"],
                ],
            )
            row = cur.fetchone()
            created = row is not None
            if created:
                _insert_event(cur, event)
            else:
                cur.execute(
                    """
                    SELECT * FROM research_candidate_promotions
                    WHERE campaign_id = %s AND trial_id = %s
                    """,
                    [promotion["campaign_id"], promotion["trial_id"]],
                )
                row = cur.fetchone()
        conn.commit()
    return _promotion_row(row), created


def list_research_candidate_promotions(campaign_id: str, *, limit: int, offset: int) -> list[dict]:
    from services.db import _conn

    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT * FROM research_candidate_promotions
                WHERE campaign_id = %s
                ORDER BY validation_score DESC, promoted_at, research_candidate_id
                LIMIT %s OFFSET %s
                """,
                [campaign_id, limit, offset],
            )
            return [_promotion_row(row) for row in cur.fetchall()]


def get_research_candidate_promotion(campaign_id: str, research_candidate_id: str) -> dict | None:
    from services.db import _conn

    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT * FROM research_candidate_promotions
                WHERE campaign_id = %s AND research_candidate_id = %s
                """,
                [campaign_id, research_candidate_id],
            )
            row = cur.fetchone()
    return _promotion_row(row) if row is not None else None


def _evaluation_row(row: dict) -> dict:
    result = dict(row)
    for key in ("score_components", "gates", "rejection_reasons", "warnings", "diagnostics", "evidence"):
        result[key] = _maybe_json(result[key])
    result["robustness_score"] = float(result["robustness_score"])
    result.pop("evidence_fingerprint", None)
    return result


def _finalist_row(row: dict) -> dict:
    result = dict(row)
    result["frozen_validation_score"] = float(result["frozen_validation_score"])
    result["holdout_result"] = _maybe_json(result.get("holdout_result"))
    return result


def _promotion_row(row: dict) -> dict:
    result = dict(row)
    result["validation_score"] = float(result["validation_score"])
    return result


def _json(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
