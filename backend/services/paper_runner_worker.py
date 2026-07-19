"""Single-process scheduler for lease-owned historical paper sessions."""

from __future__ import annotations

import logging
import os
import socket
import time
import uuid
from dataclasses import dataclass
from typing import Callable

from services.paper_runner_lease_repo import (
    DEFAULT_RUNNER_LEASE_TTL_SECONDS,
    acquire_runner_lease,
    heartbeat_runner_lease,
    list_runnable_paper_session_ids,
    release_runner_lease,
)
from services.paper_runner_service import (
    DEFAULT_RUNNER_POLL_INTERVAL_MS,
    advance_historical_runner_worker_once,
)

DEFAULT_WORKER_IDLE_POLL_SECONDS = 0.25
logger = logging.getLogger(__name__)


@dataclass
class _OwnedRunnerLease:
    lease_token: str
    next_advance_at: float
    next_heartbeat_at: float


class DurablePaperRunnerWorker:
    """Cooperatively schedules sessions without creating per-session threads."""

    def __init__(
        self,
        *,
        owner_id: str | None = None,
        lease_ttl_seconds: int = DEFAULT_RUNNER_LEASE_TTL_SECONDS,
        idle_poll_seconds: float = DEFAULT_WORKER_IDLE_POLL_SECONDS,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.owner_id = owner_id or _default_owner_id()
        self.lease_ttl_seconds = int(lease_ttl_seconds)
        self.idle_poll_seconds = max(0.01, float(idle_poll_seconds))
        self._monotonic = monotonic
        self._owned: dict[str, _OwnedRunnerLease] = {}

    def run_once(self) -> int:
        """Discover work, renew ownership, and advance each due session once."""
        runnable_ids = list_runnable_paper_session_ids(limit=1000)
        runnable = set(runnable_ids)
        self._release_sessions_not_in(runnable)
        advanced = 0

        for paper_session_id in runnable_ids:
            owned = self._owned.get(paper_session_id)
            if owned is None:
                lease = acquire_runner_lease(
                    paper_session_id,
                    owner_id=self.owner_id,
                    ttl_seconds=self.lease_ttl_seconds,
                )
                if lease is None:
                    continue
                owned = _OwnedRunnerLease(
                    lease_token=lease["lease_token"],
                    next_advance_at=self._monotonic(),
                    next_heartbeat_at=self._monotonic(),
                )
                self._owned[paper_session_id] = owned

            now = self._monotonic()
            if now >= owned.next_heartbeat_at:
                renewed = heartbeat_runner_lease(
                    paper_session_id,
                    owner_id=self.owner_id,
                    lease_token=owned.lease_token,
                    ttl_seconds=self.lease_ttl_seconds,
                )
                if renewed is None:
                    self._owned.pop(paper_session_id, None)
                    continue
                owned.next_heartbeat_at = now + self.lease_ttl_seconds / 3

            if now < owned.next_advance_at:
                continue

            try:
                session, outcome = advance_historical_runner_worker_once(
                    paper_session_id,
                    owner_id=self.owner_id,
                    lease_token=owned.lease_token,
                )
            except Exception:
                logger.exception("Paper runner worker lost session %s.", paper_session_id)
                self._release_owned(paper_session_id, owned)
                continue
            if outcome != "stepped":
                self._release_owned(paper_session_id, owned)
                continue

            poll_ms = int(
                (session.get("runner_state") or {}).get("poll_interval_ms")
                or DEFAULT_RUNNER_POLL_INTERVAL_MS
            )
            owned.next_advance_at = now + max(1, poll_ms) / 1000
            advanced += 1

        return advanced

    def run_forever(self) -> None:
        try:
            while True:
                self.run_once()
                time.sleep(self.idle_poll_seconds)
        finally:
            self.close()

    def close(self) -> None:
        for paper_session_id, owned in list(self._owned.items()):
            self._release_owned(paper_session_id, owned)

    def _release_sessions_not_in(self, runnable: set[str]) -> None:
        for paper_session_id, owned in list(self._owned.items()):
            if paper_session_id not in runnable:
                self._release_owned(paper_session_id, owned)

    def _release_owned(self, paper_session_id: str, owned: _OwnedRunnerLease) -> None:
        release_runner_lease(
            paper_session_id,
            owner_id=self.owner_id,
            lease_token=owned.lease_token,
        )
        self._owned.pop(paper_session_id, None)


def _default_owner_id() -> str:
    configured = os.environ.get("PAPER_RUNNER_OWNER_ID", "").strip()
    if configured:
        return configured
    return f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4()}"
