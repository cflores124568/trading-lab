import json
import uuid
from typing import Any

from psycopg2.extras import RealDictCursor

from services.research_repo import _campaign_row, _ensure_research_schema, _insert_event

DEFAULT_LEASE_TTL_SECONDS = 30


def configure_and_queue(campaign_id: str, *, search_config: dict, trial_budget: int, wall_seconds: int, progress: dict, event: dict) -> dict | None:
    from services.db import _conn
    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """UPDATE research_campaigns SET search_config=%s::jsonb, trial_budget=%s,
                wall_clock_budget_seconds=%s, search_progress=%s::jsonb, status='queued',
                queued_at=NOW(), started_at=NULL, deadline_at=NULL, updated_at=NOW()
                WHERE campaign_id=%s AND status IN ('draft','paused') RETURNING *""",
                [json.dumps(search_config), trial_budget, wall_seconds, json.dumps(progress), campaign_id],
            )
            row = cur.fetchone()
            if row: _insert_event(cur, event)
        conn.commit()
    return _campaign_row(row) if row else None


def pause_campaign(campaign_id: str, event: dict) -> dict | None:
    from services.db import _conn
    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("UPDATE research_campaigns SET status='paused', updated_at=NOW() WHERE campaign_id=%s AND status IN ('queued','running') RETURNING *", [campaign_id])
            row = cur.fetchone()
            if row:
                cur.execute("DELETE FROM research_campaign_leases WHERE campaign_id=%s", [campaign_id])
                _insert_event(cur, event)
        conn.commit()
    return _campaign_row(row) if row else None


def resume_campaign(campaign_id: str, event: dict) -> dict | None:
    from services.db import _conn
    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("UPDATE research_campaigns SET status='queued', queued_at=NOW(), updated_at=NOW() WHERE campaign_id=%s AND status='paused' AND search_config IS NOT NULL RETURNING *", [campaign_id])
            row = cur.fetchone()
            if row: _insert_event(cur, event)
        conn.commit()
    return _campaign_row(row) if row else None


def list_runnable_campaign_ids(*, limit: int = 100) -> list[str]:
    from services.db import _conn
    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor() as cur:
            cur.execute("SELECT campaign_id FROM research_campaigns WHERE status IN ('queued','running') AND search_config IS NOT NULL ORDER BY updated_at, campaign_id LIMIT %s", [max(1, min(limit, 1000))])
            return [row[0] for row in cur.fetchall()]


def acquire_lease(campaign_id: str, *, owner_id: str, ttl_seconds: int = DEFAULT_LEASE_TTL_SECONDS) -> dict | None:
    from services.db import _conn
    ttl = _ttl(ttl_seconds); token = str(uuid.uuid4())
    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""INSERT INTO research_campaign_leases (campaign_id,owner_id,lease_token,acquired_at,heartbeat_at,expires_at)
            VALUES (%s,%s,%s,NOW(),NOW(),NOW()+(%s*INTERVAL '1 second'))
            ON CONFLICT (campaign_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,lease_token=EXCLUDED.lease_token,
            acquired_at=EXCLUDED.acquired_at,heartbeat_at=EXCLUDED.heartbeat_at,expires_at=EXCLUDED.expires_at
            WHERE research_campaign_leases.expires_at<=NOW() RETURNING *""", [campaign_id, owner_id, token, ttl])
            row = cur.fetchone()
        conn.commit()
    return dict(row) if row else None


def heartbeat_lease(campaign_id: str, *, owner_id: str, lease_token: str, ttl_seconds: int = DEFAULT_LEASE_TTL_SECONDS) -> dict | None:
    from services.db import _conn
    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""UPDATE research_campaign_leases SET heartbeat_at=NOW(),expires_at=NOW()+(%s*INTERVAL '1 second')
            WHERE campaign_id=%s AND owner_id=%s AND lease_token=%s AND expires_at>NOW() RETURNING *""",
            [_ttl(ttl_seconds), campaign_id, owner_id, lease_token])
            row=cur.fetchone()
        conn.commit()
    return dict(row) if row else None


def release_lease(campaign_id: str, *, owner_id: str, lease_token: str) -> bool:
    from services.db import _conn
    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor() as cur:
            cur.execute("DELETE FROM research_campaign_leases WHERE campaign_id=%s AND owner_id=%s AND lease_token=%s", [campaign_id, owner_id, lease_token]); ok=cur.rowcount==1
        conn.commit()
    return ok


def start_or_get_owned_campaign(campaign_id: str, *, owner_id: str, lease_token: str) -> dict | None:
    from services.db import _conn
    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""UPDATE research_campaigns c SET status='running',started_at=COALESCE(started_at,NOW()),
            deadline_at=COALESCE(deadline_at,NOW()+(wall_clock_budget_seconds*INTERVAL '1 second')),updated_at=NOW()
            WHERE c.campaign_id=%s AND c.status IN ('queued','running') AND EXISTS
            (SELECT 1 FROM research_campaign_leases l WHERE l.campaign_id=c.campaign_id AND l.owner_id=%s AND l.lease_token=%s AND l.expires_at>NOW()) RETURNING c.*""",
            [campaign_id, owner_id, lease_token]); row=cur.fetchone()
        conn.commit()
    return _campaign_row(row) if row else None


def persist_progress(campaign_id: str, *, owner_id: str, lease_token: str, expected_index: int, progress: dict, status: str) -> bool:
    from services.db import _conn
    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor() as cur:
            cur.execute("""UPDATE research_campaigns c SET search_progress=%s::jsonb,status=%s,updated_at=NOW()
            WHERE c.campaign_id=%s AND c.status='running' AND COALESCE((c.search_progress->>'next_plan_index')::int,0)=%s
            AND EXISTS (SELECT 1 FROM research_campaign_leases l WHERE l.campaign_id=c.campaign_id AND l.owner_id=%s AND l.lease_token=%s AND l.expires_at>NOW())""",
            [json.dumps(progress), status, campaign_id, expected_index, owner_id, lease_token]); ok=cur.rowcount==1
        conn.commit()
    return ok


def _ttl(value: int) -> int:
    value=int(value)
    if value < 5 or value > 300: raise ValueError("Campaign lease TTL must stay between 5 and 300 seconds.")
    return value
