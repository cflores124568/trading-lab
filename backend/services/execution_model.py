from __future__ import annotations

from dataclasses import dataclass
from typing import Any


DEFAULT_TICK_SIZE = 0.25
DEFAULT_SPREAD_TICKS = 1


@dataclass(frozen=True)
class SyntheticQuote:
    bid: float
    ask: float
    reference: float
    spread_ticks: int
    tick_size: float

    def as_dict(self) -> dict[str, float | int]:
        return {
            "bid": self.bid,
            "ask": self.ask,
            "reference": self.reference,
            "spread_ticks": self.spread_ticks,
            "tick_size": self.tick_size,
        }


def normalize_execution_action(action: str) -> str:
    """Map old paper/replay verbs onto the Phase 1 execution verbs.

    This lets older saved sessions and the current paper runner keep working
    while new UI buttons use the clearer `lift_ask`, `hit_bid`, and `flatten`
    names. `mark` stays as its own thing because it doesn't execute.
    """
    action_key = action.strip().lower()
    aliases = {
        "buy": "lift_ask",
        "sell": "hit_bid",
        "exit": "flatten",
    }
    return aliases.get(action_key, action_key)


def round_to_tick(price: float, tick_size: float) -> float:
    safe_tick = tick_size if tick_size > 0 else DEFAULT_TICK_SIZE
    return round(round(float(price) / safe_tick) * safe_tick, 10)


def synthetic_quote_for_bar(
    bar: dict[str, Any],
    *,
    tick_size: float = DEFAULT_TICK_SIZE,
    spread_ticks: int = DEFAULT_SPREAD_TICKS,
) -> SyntheticQuote:
    """Build a fake top-of-book from one OHLCV bar close.

    The close is just the reference anchor, rounded to the symbol tick. A
    one-tick spread gives `bid=reference` and `ask=reference+tick`, which is
    boring on purpose and easy to explain when a fill looks weird.
    """
    safe_tick = tick_size if tick_size > 0 else DEFAULT_TICK_SIZE
    safe_spread = max(1, int(round(spread_ticks or DEFAULT_SPREAD_TICKS)))
    reference = round_to_tick(float(bar["close"]), safe_tick)
    bid = round(reference - (safe_spread // 2) * safe_tick, 10)
    ask = round(bid + safe_spread * safe_tick, 10)
    return SyntheticQuote(
        bid=bid,
        ask=ask,
        reference=reference,
        spread_ticks=safe_spread,
        tick_size=safe_tick,
    )


def resting_order_touched(order: dict[str, Any], bar: dict[str, Any]) -> bool:
    if order.get("status") != "pending":
        return False

    price = float(order["price"])
    if order.get("side") == "buy":
        return float(bar["low"]) <= price
    return float(bar["high"]) >= price


def make_resting_order(
    *,
    order_id: str,
    action: str,
    price: float,
    submitted_at: str,
    submitted_bar_index: int | None = None,
) -> dict[str, Any]:
    side = "buy" if action == "join_bid" else "sell"
    return {
        "id": order_id,
        "side": side,
        "price": round(float(price), 10),
        "submitted_at": submitted_at,
        "submitted_bar_index": submitted_bar_index,
        "type": action,
        "status": "pending",
    }
