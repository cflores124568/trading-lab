from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any


DEFAULT_TICK_SIZE = 0.25
DEFAULT_SPREAD_TICKS = 1
DEFAULT_VOLATILE_BAR_THRESHOLD_TICKS = 0
DEFAULT_VOLATILE_BAR_EXTRA_TICKS = 0
DEFAULT_RESTING_FILL_MODE = "touch"
SYMBOL_EXECUTION_DEFAULTS: dict[str, dict[str, int]] = {
    "ES": {
        "spread_ticks": 1,
        "volatile_bar_threshold_ticks": 8,
        "volatile_bar_extra_ticks": 1,
    },
    "MES": {
        "spread_ticks": 1,
        "volatile_bar_threshold_ticks": 8,
        "volatile_bar_extra_ticks": 1,
    },
    "NQ": {
        "spread_ticks": 2,
        "volatile_bar_threshold_ticks": 12,
        "volatile_bar_extra_ticks": 1,
    },
    "MNQ": {
        "spread_ticks": 2,
        "volatile_bar_threshold_ticks": 12,
        "volatile_bar_extra_ticks": 1,
    },
    "GC": {
        "spread_ticks": 2,
        "volatile_bar_threshold_ticks": 10,
        "volatile_bar_extra_ticks": 1,
    },
    "MGC": {
        "spread_ticks": 2,
        "volatile_bar_threshold_ticks": 10,
        "volatile_bar_extra_ticks": 1,
    },
}


@dataclass(frozen=True)
class SyntheticQuote:
    bid: float
    ask: float
    reference: float
    spread_ticks: int
    base_spread_ticks: int
    volatility_spread_ticks: int
    bar_range_ticks: int
    is_volatile: bool
    tick_size: float

    def as_dict(self) -> dict[str, float | int]:
        return {
            "bid": self.bid,
            "ask": self.ask,
            "reference": self.reference,
            "spread_ticks": self.spread_ticks,
            "base_spread_ticks": self.base_spread_ticks,
            "volatility_spread_ticks": self.volatility_spread_ticks,
            "bar_range_ticks": self.bar_range_ticks,
            "is_volatile": self.is_volatile,
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


def normalize_symbol_root(symbol: str | None) -> str:
    """Pull the root ticker out of the saved symbol slug.

    I only care about the tradable root here so `ES`, `ES_c_0`, and
    `es-2026` all land on the same execution defaults instead of each needing
    their own entry.
    """
    if not symbol:
        return ""

    match = re.match(r"[A-Za-z]+", str(symbol).strip().upper())
    return match.group(0) if match else ""


def default_execution_config_for_symbol(symbol: str | None) -> dict[str, int]:
    """Return the default synthetic spread knobs for one symbol root.

    The numbers are still intentionally simple. I just want new sessions to
    stop pretending every futures product is a permanent one-tick market.
    """
    root = normalize_symbol_root(symbol)
    defaults = SYMBOL_EXECUTION_DEFAULTS.get(root)
    if defaults:
        return dict(defaults)

    return {
        "spread_ticks": DEFAULT_SPREAD_TICKS,
        "volatile_bar_threshold_ticks": DEFAULT_VOLATILE_BAR_THRESHOLD_TICKS,
        "volatile_bar_extra_ticks": DEFAULT_VOLATILE_BAR_EXTRA_TICKS,
    }


def normalize_resting_fill_mode(mode: str | None) -> str:
    """Keep the resting-order realism knob on known values.

    I only support a tiny set of modes for now. If an old session or busted
    payload sends nonsense, I quietly fall back to the boring touch model.
    """
    candidate = str(mode or "").strip().lower()
    if candidate in {"touch", "penetrate", "touch_plus_1_bar"}:
        return candidate
    return DEFAULT_RESTING_FILL_MODE


def synthetic_quote_for_bar(
    bar: dict[str, Any],
    *,
    tick_size: float = DEFAULT_TICK_SIZE,
    spread_ticks: int = DEFAULT_SPREAD_TICKS,
    volatile_bar_threshold_ticks: int = DEFAULT_VOLATILE_BAR_THRESHOLD_TICKS,
    volatile_bar_extra_ticks: int = DEFAULT_VOLATILE_BAR_EXTRA_TICKS,
) -> SyntheticQuote:
    """Build a fake top-of-book from one OHLCV bar close.

    The close is just the reference anchor, rounded to the symbol tick. A
    one-tick spread gives `bid=reference` and `ask=reference+tick`, which is
    boring on purpose and easy to explain when a fill looks weird.
    """
    safe_tick = tick_size if tick_size > 0 else DEFAULT_TICK_SIZE
    base_spread = max(1, int(round(spread_ticks or DEFAULT_SPREAD_TICKS)))
    volatility_threshold = max(0, int(round(volatile_bar_threshold_ticks or 0)))
    volatility_extra = max(0, int(round(volatile_bar_extra_ticks or 0)))
    bar_high = float(bar.get("high", bar["close"]))
    bar_low = float(bar.get("low", bar["close"]))
    bar_range_ticks = max(0, int(round((bar_high - bar_low) / safe_tick)))
    is_volatile = volatility_threshold > 0 and volatility_extra > 0 and bar_range_ticks >= volatility_threshold
    safe_spread = base_spread + (volatility_extra if is_volatile else 0)
    reference = round_to_tick(float(bar["close"]), safe_tick)
    bid = round(reference - (safe_spread // 2) * safe_tick, 10)
    ask = round(bid + safe_spread * safe_tick, 10)
    return SyntheticQuote(
        bid=bid,
        ask=ask,
        reference=reference,
        spread_ticks=safe_spread,
        base_spread_ticks=base_spread,
        volatility_spread_ticks=volatility_extra if is_volatile else 0,
        bar_range_ticks=bar_range_ticks,
        is_volatile=is_volatile,
        tick_size=safe_tick,
    )


def resting_order_touched(order: dict[str, Any], bar: dict[str, Any]) -> bool:
    if order.get("status") != "pending":
        return False

    price = float(order["price"])
    role = str(order.get("bracket_role") or "").strip().lower()
    if role == "target":
        if order.get("side") == "buy":
            return float(bar["low"]) <= price
        return float(bar["high"]) >= price
    if role == "stop":
        if order.get("side") == "buy":
            return float(bar["high"]) >= price
        return float(bar["low"]) <= price
    if order.get("side") == "buy":
        return float(bar["low"]) <= price
    return float(bar["high"]) >= price


def resting_order_penetrated(
    order: dict[str, Any],
    bar: dict[str, Any],
) -> bool:
    if order.get("status") != "pending":
        return False

    price = float(order["price"])
    role = str(order.get("bracket_role") or "").strip().lower()
    if role == "target":
        if order.get("side") == "buy":
            return float(bar["low"]) < price
        return float(bar["high"]) > price
    if role == "stop":
        if order.get("side") == "buy":
            return float(bar["high"]) > price
        return float(bar["low"]) < price
    if order.get("side") == "buy":
        return float(bar["low"]) < price
    return float(bar["high"]) > price


def resting_order_fill_update(
    order: dict[str, Any],
    bar: dict[str, Any],
    *,
    fill_mode: str = DEFAULT_RESTING_FILL_MODE,
    bar_index: int | None = None,
    timestamp: str | None = None,
) -> tuple[bool, dict[str, Any]]:
    """Apply the resting fill rule for one later bar and return updated state.

    `touch` fills on the first later touch, `penetrate` requires trading
    through the price, and `touch_plus_1_bar` arms on first touch then waits
    for any later touched bar before it actually fills.
    """
    next_order = dict(order)
    mode = normalize_resting_fill_mode(fill_mode)

    if mode == "penetrate":
        return resting_order_penetrated(next_order, bar), next_order

    touched = resting_order_touched(next_order, bar)
    if mode == "touch":
        return touched, next_order

    if not touched:
        return False, next_order

    first_touch_bar_index = next_order.get("first_touch_bar_index")
    if first_touch_bar_index is None:
        if bar_index is not None:
            next_order["first_touch_bar_index"] = int(bar_index)
        if timestamp:
            next_order["first_touch_at"] = timestamp
        return False, next_order

    if bar_index is not None and int(bar_index) <= int(first_touch_bar_index):
        return False, next_order

    return True, next_order


def make_resting_order(
    *,
    order_id: str,
    action: str,
    price: float,
    submitted_at: str,
    submitted_bar_index: int | None = None,
    intent: str = "entry",
    side: str | None = None,
) -> dict[str, Any]:
    resolved_side = side
    if resolved_side not in {"buy", "sell"}:
        resolved_side = "buy" if action == "join_bid" else "sell"

    return {
        "id": order_id,
        "intent": "exit" if intent == "exit" else "entry",
        "side": resolved_side,
        "price": round(float(price), 10),
        "submitted_at": submitted_at,
        "submitted_bar_index": submitted_bar_index,
        "type": action,
        "status": "pending",
    }


def replace_resting_order(
    order: dict[str, Any],
    *,
    new_order_id: str,
    price: float,
    submitted_at: str,
    submitted_bar_index: int | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Replace one working order with a new child order.

    I don't mutate the old order in place because that hides the lifecycle and
    makes later UI/event trails fuzzy. This marks the old order as `replaced`,
    stamps lineage both ways, and returns the fresh child order that should be
    treated as the new live intent.
    """
    original = dict(order)
    parent_order_id = str(original.get("parent_order_id") or original.get("id") or new_order_id)
    replace_count = int(original.get("replace_count") or 0) + 1

    replaced_order = {
        **original,
        "status": "replaced",
        "replaced_at": submitted_at,
        "replaced_bar_index": submitted_bar_index,
        "replaced_by_order_id": new_order_id,
        "parent_order_id": parent_order_id,
        "replace_count": replace_count,
    }
    replaced_order.pop("filled_at", None)
    replaced_order.pop("filled_bar_index", None)
    replaced_order.pop("canceled_at", None)
    replaced_order.pop("canceled_bar_index", None)

    next_order = {
        **original,
        "id": new_order_id,
        "price": round(float(price), 10),
        "submitted_at": submitted_at,
        "submitted_bar_index": submitted_bar_index,
        "status": "pending",
        "parent_order_id": parent_order_id,
        "replaces_order_id": str(original.get("id") or ""),
        "replace_count": replace_count,
    }
    next_order.pop("filled_at", None)
    next_order.pop("filled_bar_index", None)
    next_order.pop("canceled_at", None)
    next_order.pop("canceled_bar_index", None)
    next_order.pop("replaced_at", None)
    next_order.pop("replaced_bar_index", None)
    next_order.pop("replaced_by_order_id", None)
    next_order.pop("first_touch_at", None)
    next_order.pop("first_touch_bar_index", None)

    return replaced_order, next_order
