"""PostgreSQL ownership leases for the durable paper-runner worker."""

from __future__ import annotations

import uuid
from typing import Any

from services.db import _conn, _read_sql
from services.paper_session_repo import _ensure_paper_sessions_schema

DEFAULT_RUNNER_LEASE_TTL_SECONDS = 30
MIN_RUNNER_LEASE_TTL_SECONDS = 5
MAX_RUNNER_LEASE_TTL_SECONDS = 300


def acquire_runner_lease(
    paper_session_id: str,
    *,
    owner_id: str,
    ttl_seconds: int = DEFAULT_RUNNER_LEASE_TTL_SECONDS,
) -> dict[str, Any] | None:
    """Claim an unowned or expired session and return its opaque lease token."""
    session_id = _required_text(paper_session_id, "Paper session id")
    owner = _required_text(owner_id, "Runner owner id")
    ttl = _validate_ttl(ttl_seconds)
    token = str(uuid.uuid4())
    sql = """
        INSERT INTO paper_runner_leases (
            paper_session_id, owner_id, lease_token,
            acquired_at, heartbeat_at, expires_at
        )
        VALUES (%s, %s, %s, NOW(), NOW(), NOW() + (%s * INTERVAL '1 second'))
        ON CONFLICT (paper_session_id) DO UPDATE SET
            owner_id = EXCLUDED.owner_id,
            lease_token = EXCLUDED.lease_token,
            acquired_at = EXCLUDED.acquired_at,
            heartbeat_at = EXCLUDED.heartbeat_at,
            expires_at = EXCLUDED.expires_at
        WHERE paper_runner_leases.expires_at <= NOW()
        RETURNING paper_session_id, owner_id, lease_token,
                  acquired_at, heartbeat_at, expires_at
    """
    with _conn() as conn:
        _ensure_paper_sessions_schema(conn)
        with conn.cursor() as cur:
            cur.execute(sql, [session_id, owner, token, ttl])
            row = cur.fetchone()
            columns = [description.name for description in cur.description] if row else []
        conn.commit()
    return _lease_from_row(columns, row) if row else None


def heartbeat_runner_lease(
    paper_session_id: str,
    *,
    owner_id: str,
    lease_token: str,
    ttl_seconds: int = DEFAULT_RUNNER_LEASE_TTL_SECONDS,
) -> dict[str, Any] | None:
    """Renew a live lease only while its owner and token still match."""
    ttl = _validate_ttl(ttl_seconds)
    sql = """
        UPDATE paper_runner_leases
        SET heartbeat_at = NOW(),
            expires_at = NOW() + (%s * INTERVAL '1 second')
        WHERE paper_session_id = %s
          AND owner_id = %s
          AND lease_token = %s
          AND expires_at > NOW()
        RETURNING paper_session_id, owner_id, lease_token,
                  acquired_at, heartbeat_at, expires_at
    """
    with _conn() as conn:
        _ensure_paper_sessions_schema(conn)
        with conn.cursor() as cur:
            cur.execute(
                sql,
                [
                    ttl,
                    _required_text(paper_session_id, "Paper session id"),
                    _required_text(owner_id, "Runner owner id"),
                    _required_text(lease_token, "Runner lease token"),
                ],
            )
            row = cur.fetchone()
            columns = [description.name for description in cur.description] if row else []
        conn.commit()
    return _lease_from_row(columns, row) if row else None


def release_runner_lease(
    paper_session_id: str,
    *,
    owner_id: str,
    lease_token: str,
) -> bool:
    """Release a lease only when the caller still owns the exact token."""
    sql = """
        DELETE FROM paper_runner_leases
        WHERE paper_session_id = %s AND owner_id = %s AND lease_token = %s
    """
    with _conn() as conn:
        _ensure_paper_sessions_schema(conn)
        with conn.cursor() as cur:
            cur.execute(
                sql,
                [
                    _required_text(paper_session_id, "Paper session id"),
                    _required_text(owner_id, "Runner owner id"),
                    _required_text(lease_token, "Runner lease token"),
                ],
            )
            released = cur.rowcount == 1
        conn.commit()
    return released


def revoke_runner_lease(paper_session_id: str) -> bool:
    """Administrative pause/kill-switch revocation for any current owner."""
    with _conn() as conn:
        _ensure_paper_sessions_schema(conn)
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM paper_runner_leases WHERE paper_session_id = %s",
                [_required_text(paper_session_id, "Paper session id")],
            )
            revoked = cur.rowcount == 1
        conn.commit()
    return revoked


def get_runner_lease(paper_session_id: str) -> dict[str, Any] | None:
    sql = """
        SELECT paper_session_id, owner_id, lease_token,
               acquired_at, heartbeat_at, expires_at,
               expires_at > NOW() AS active
        FROM paper_runner_leases
        WHERE paper_session_id = %s
    """
    with _conn() as conn:
        _ensure_paper_sessions_schema(conn)
    df = _read_sql(sql, params=[_required_text(paper_session_id, "Paper session id")])
    if df.empty:
        return None
    return _lease_from_mapping(df.iloc[0].to_dict())


def list_runnable_paper_session_ids(*, limit: int = 100) -> list[str]:
    bounded_limit = max(1, min(int(limit), 1000))
    sql = """
        SELECT paper_session_id
        FROM paper_sessions
        WHERE status = 'running'
          AND runner_state->>'mode' = 'running'
        ORDER BY updated_at ASC, paper_session_id ASC
        LIMIT %s
    """
    with _conn() as conn:
        _ensure_paper_sessions_schema(conn)
    df = _read_sql(sql, params=[bounded_limit])
    return [str(value) for value in df["paper_session_id"].tolist()]


def _validate_ttl(value: int) -> int:
    ttl = int(value)
    if ttl < MIN_RUNNER_LEASE_TTL_SECONDS or ttl > MAX_RUNNER_LEASE_TTL_SECONDS:
        raise ValueError(
            f"Runner lease TTL must stay between {MIN_RUNNER_LEASE_TTL_SECONDS} "
            f"and {MAX_RUNNER_LEASE_TTL_SECONDS} seconds."
        )
    return ttl


def _required_text(value: str, label: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{label} can't be empty.")
    return text


def _lease_from_row(columns: list[str], row: tuple[Any, ...]) -> dict[str, Any]:
    return _lease_from_mapping(dict(zip(columns, row)))


def _lease_from_mapping(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "paper_session_id": str(row["paper_session_id"]),
        "owner_id": str(row["owner_id"]),
        "lease_token": str(row["lease_token"]),
        "acquired_at": _iso(row["acquired_at"]),
        "heartbeat_at": _iso(row["heartbeat_at"]),
        "expires_at": _iso(row["expires_at"]),
        "active": bool(row.get("active", True)),
    }


def _iso(value: Any) -> str:
    return value.isoformat() if hasattr(value, "isoformat") else str(value)
