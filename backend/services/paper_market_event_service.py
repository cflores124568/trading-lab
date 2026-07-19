"""Source-neutral market-event contracts for the final pre-MBP boundary."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from pydantic import TypeAdapter

from schemas import (
    PaperBBOEvent,
    PaperMarketEvent,
    PaperMarketEventDisposition,
    PaperMarketSequenceGap,
    PaperTradeEvent,
)
from services.execution_model import round_to_tick
from services.paper_session_service import (
    _ensure_session_defaults,
    _now,
    _require_paper_session,
    _save_paper_session_any,
)

MAX_RECENT_MARKET_EVENT_IDS = 512
_MARKET_EVENT_ADAPTER = TypeAdapter(PaperMarketEvent)


def normalize_market_event(payload: PaperMarketEvent | dict[str, Any]) -> PaperMarketEvent:
    """Validate the source-neutral event and canonicalize timestamps and labels."""
    event = _MARKET_EVENT_ADAPTER.validate_python(payload)
    normalized = event.model_copy(
        update={
            "event_id": event.event_id.strip(),
            "source": event.source.strip().lower(),
            "symbol": event.symbol.strip().upper(),
            "instrument_id": _optional_text(event.instrument_id),
            "publisher_id": _optional_text(event.publisher_id),
            "event_time": _normalized_timestamp(event.event_time, "event_time"),
            "received_time": _normalized_timestamp(event.received_time, "received_time"),
        }
    )
    if _parse_timestamp(normalized.received_time) < _parse_timestamp(normalized.event_time):
        raise ValueError("Market event received_time cannot precede event_time.")
    return normalized


def sequence_market_event(
    event: PaperMarketEvent | dict[str, Any],
    cursor: dict[str, Any] | None,
    *,
    expected_symbol: str,
    tick_size: float,
) -> tuple[PaperMarketEventDisposition, dict[str, Any]]:
    """Apply deterministic duplicate, ordering, gap, and quote-quality rules."""
    if tick_size <= 0:
        raise ValueError("Paper session tick_size must be greater than zero.")
    normalized = normalize_market_event(event)
    symbol = expected_symbol.strip().upper()
    if normalized.symbol != symbol:
        raise ValueError(
            f"Market event symbol '{normalized.symbol}' does not match paper session symbol '{symbol}'."
        )

    current = _ensure_cursor(cursor)
    stream_key = _stream_key(normalized)
    if current.get("stream_key") not in {None, stream_key}:
        raise ValueError("Market event stream identity changed for this paper session.")
    current["stream_key"] = stream_key

    recent_ids = list(current.get("recent_event_ids") or [])
    if normalized.event_id in recent_ids:
        return (
            PaperMarketEventDisposition(
                status="duplicate",
                reason="Event id was already applied.",
                event=normalized,
            ),
            current,
        )

    last_sequence = current.get("last_sequence")
    last_event_time = current.get("last_event_time")
    if last_sequence is not None and normalized.sequence <= int(last_sequence):
        return (
            PaperMarketEventDisposition(
                status="stale",
                reason="Sequence did not advance beyond the durable cursor.",
                event=normalized,
            ),
            current,
        )
    if last_event_time and _parse_timestamp(normalized.event_time) < _parse_timestamp(last_event_time):
        return (
            PaperMarketEventDisposition(
                status="stale",
                reason="Event time moved backward behind the durable cursor.",
                event=normalized,
            ),
            current,
        )

    gap = None
    if last_sequence is not None and normalized.sequence > int(last_sequence) + 1:
        gap = PaperMarketSequenceGap(
            expected_sequence=int(last_sequence) + 1,
            received_sequence=normalized.sequence,
            missing_count=normalized.sequence - int(last_sequence) - 1,
        )

    normalized_quote = None
    normalized_trade = None
    status = "accepted_with_gap" if gap else "accepted"
    reason = "Event advanced the durable market cursor."

    if isinstance(normalized, PaperBBOEvent):
        normalized_quote = _normalized_quote(normalized, tick_size=tick_size)
        if normalized_quote["bid"] == normalized_quote["ask"]:
            status = "rejected_locked"
            reason = "Locked BBO was quarantined and did not replace the executable quote."
            normalized_quote = None
        elif normalized_quote["bid"] > normalized_quote["ask"]:
            status = "rejected_crossed"
            reason = "Crossed BBO was quarantined and did not replace the executable quote."
            normalized_quote = None
    elif isinstance(normalized, PaperTradeEvent):
        normalized_trade = {
            "price": round_to_tick(normalized.price, tick_size),
            "size": float(normalized.size),
            "aggressor_side": normalized.aggressor_side,
            "event_time": normalized.event_time,
            "received_time": normalized.received_time,
            "sequence": normalized.sequence,
            "source": normalized.source,
        }

    next_cursor = dict(current)
    next_cursor["last_sequence"] = normalized.sequence
    next_cursor["last_event_time"] = normalized.event_time
    next_cursor["last_received_time"] = normalized.received_time
    next_cursor["last_event_id"] = normalized.event_id
    next_cursor["recent_event_ids"] = [
        *recent_ids[-(MAX_RECENT_MARKET_EVENT_IDS - 1) :],
        normalized.event_id,
    ]
    next_cursor["accepted_event_count"] = int(current.get("accepted_event_count") or 0) + int(
        status in {"accepted", "accepted_with_gap"}
    )
    next_cursor["quarantined_event_count"] = int(
        current.get("quarantined_event_count") or 0
    ) + int(status in {"rejected_locked", "rejected_crossed"})
    if gap:
        next_cursor["sequence_gap_count"] = int(current.get("sequence_gap_count") or 0) + 1
        next_cursor["missing_sequence_count"] = int(
            current.get("missing_sequence_count") or 0
        ) + gap.missing_count
        next_cursor["data_quality"] = "degraded"
        next_cursor["last_gap"] = gap.model_dump(mode="json")
    next_cursor["updated_at"] = normalized.received_time

    return (
        PaperMarketEventDisposition(
            status=status,
            reason=reason,
            event=normalized,
            gap=gap,
            normalized_quote=normalized_quote,
            normalized_trade=normalized_trade,
        ),
        next_cursor,
    )


def apply_paper_market_event(
    paper_session_id: str,
    payload: PaperMarketEvent | dict[str, Any],
) -> dict[str, Any]:
    """Project one event into paper market state without invoking trading logic."""
    session = _ensure_session_defaults(_require_paper_session(paper_session_id))
    runner_state = dict(session.get("runner_state") or {})
    cursor = dict(runner_state.get("market_event_cursor") or {})
    disposition, next_cursor = sequence_market_event(
        payload,
        cursor,
        expected_symbol=session["symbol"],
        tick_size=float(session.get("tick_size") or 0.25),
    )

    if disposition.status in {"duplicate", "stale"}:
        return _adapter_result(session, disposition, cursor)

    runner_state["market_event_cursor"] = next_cursor
    if disposition.normalized_quote is not None:
        session["last_quote"] = disposition.normalized_quote
    if disposition.normalized_trade is not None:
        runner_state["last_market_trade"] = disposition.normalized_trade

    now = _now()
    session["runner_state"] = runner_state
    session["updated_at"] = now
    _save_paper_session_any(session)
    return _adapter_result(session, disposition, next_cursor)


def _adapter_result(
    session: dict[str, Any],
    disposition: PaperMarketEventDisposition,
    cursor: dict[str, Any],
) -> dict[str, Any]:
    return {
        "paper_session_id": session["paper_session_id"],
        "disposition": disposition.model_dump(mode="json"),
        "market_event_cursor": dict(cursor),
        "last_quote": dict(session.get("last_quote") or {}),
        "last_market_trade": dict((session.get("runner_state") or {}).get("last_market_trade") or {}),
    }


def _normalized_quote(event: PaperBBOEvent, *, tick_size: float) -> dict[str, Any]:
    bid = round_to_tick(event.bid_price, tick_size)
    ask = round_to_tick(event.ask_price, tick_size)
    spread_ticks = int(round((ask - bid) / tick_size)) if tick_size > 0 else 0
    return {
        "bid": bid,
        "ask": ask,
        "reference": round((bid + ask) / 2, 10),
        "bid_size": float(event.bid_size),
        "ask_size": float(event.ask_size),
        "bid_order_count": int(event.bid_order_count),
        "ask_order_count": int(event.ask_order_count),
        "spread_ticks": spread_ticks,
        "tick_size": float(tick_size),
        "event_time": event.event_time,
        "received_time": event.received_time,
        "sequence": event.sequence,
        "source": event.source,
        "synthetic": False,
    }


def _ensure_cursor(cursor: dict[str, Any] | None) -> dict[str, Any]:
    current = dict(cursor or {})
    current.setdefault("stream_key", None)
    current.setdefault("last_sequence", None)
    current.setdefault("last_event_time", None)
    current.setdefault("last_received_time", None)
    current.setdefault("last_event_id", None)
    current.setdefault("recent_event_ids", [])
    current.setdefault("accepted_event_count", 0)
    current.setdefault("quarantined_event_count", 0)
    current.setdefault("sequence_gap_count", 0)
    current.setdefault("missing_sequence_count", 0)
    current.setdefault("data_quality", "good")
    current.setdefault("last_gap", None)
    current.setdefault("updated_at", None)
    return current


def _stream_key(event: PaperMarketEvent) -> str:
    instrument = event.instrument_id or event.symbol
    publisher = event.publisher_id or "default"
    return f"{event.source}:{publisher}:{instrument}"


def _normalized_timestamp(value: str, label: str) -> str:
    return _parse_timestamp(value, label=label).isoformat()


def _parse_timestamp(value: str, *, label: str = "timestamp") -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Market event {label} must be an ISO-8601 timestamp.") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"Market event {label} must include a timezone offset.")
    return parsed.astimezone(timezone.utc)


def _optional_text(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    return text or None
