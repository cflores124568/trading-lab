"""Conservative bar evidence for MFFU research; never invent an execution."""
from bisect import bisect_left, bisect_right
from datetime import datetime, time, timedelta, timezone
import math
import re
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")


def _timestamp(value):
    if hasattr(value, "to_pydatetime"):
        value = value.to_pydatetime()
    if not isinstance(value, datetime):
        value = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return (value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value).astimezone(timezone.utc)


def _interval_seconds(value):
    match = re.fullmatch(r"(\d+)(min|m|h)", str(value or "").lower())
    if not match:
        return None
    seconds = int(match.group(1)) * (3600 if match.group(2) == "h" else 60)
    return seconds if 0 < seconds < 86400 else None


def _session_date(timestamp):
    local = timestamp.astimezone(NY)
    return local.date() + timedelta(days=local.hour >= 18)


def assess_mffu_evidence(*, bars, trades, equity, initial_balance, rules, interval, tick_size, tick_value):
    """Report uncertain session coverage and possible intrabar risk crossings.

    Bar timestamps denote bar starts. The whole candle is an adverse envelope;
    a stop or limit may have filled before its extreme, so a crossing is not
    asserted as a confirmed breach and no hypothetical liquidation is created.
    """
    reasons = []
    seconds = _interval_seconds(interval)
    if not seconds:
        reasons.append("unsupported_or_missing_intraday_interval")
    if len(bars) != len(equity) or not bars:
        reasons.append("missing_bar_or_equity_evidence")
    try:
        times = [_timestamp(bar["time"]) for bar in bars]
        if any(b <= a for a, b in zip(times, times[1:])):
            reasons.append("unordered_or_duplicate_timestamps")
    except (KeyError, TypeError, ValueError, OverflowError):
        times = []
        reasons.append("invalid_bar_timestamp")
    try:
        if any(not all(math.isfinite(float(bar.get(key, float("nan")))) for key in ("open", "high", "low", "close")) or float(bar["low"]) > float(bar["high"]) or not float(bar["low"]) <= float(bar["close"]) <= float(bar["high"]) or not float(bar["low"]) <= float(bar["open"]) <= float(bar["high"]) for bar in bars):
            reasons.append("missing_or_invalid_ohlc")
    except (TypeError, ValueError, KeyError):
        reasons.append("missing_or_invalid_ohlc")
    if not tick_size or not math.isfinite(tick_size) or tick_size <= 0 or not tick_value or not math.isfinite(tick_value) or tick_value <= 0:
        reasons.append("invalid_contract_value")
    try:
        if not math.isfinite(initial_balance) or any(not math.isfinite(float(value)) for value in equity):
            reasons.append("invalid_equity_evidence")
    except (TypeError, ValueError):
        reasons.append("invalid_equity_evidence")
    if reasons:
        return {"incomplete": True, "reasons": sorted(set(reasons)), "partial_first_session": False, "partial_final_session": False, "possible_intrabar_limit": False, "first_intrabar_time": None, "first_intrabar_rule": None, "worst_equity": None}

    sessions = [_session_date(t) for t in times]
    floors = []
    starts = []
    floor = rules["account_size"] * (1 - rules["max_drawdown"])
    high_close = rules["account_size"]
    session_start = initial_balance
    last_session_index = {}
    last_before_cutoff = {}
    session_cutoffs = {}
    for i, session in enumerate(sessions):
        if i and session != sessions[i - 1]:
            previous = equity[i - 1]
            if rules.get("evaluation_model") == "mffu_eod":
                high_close = max(high_close, previous)
                floor = min(rules["account_size"] + 100, max(floor, high_close - rules["account_size"] * rules["max_drawdown"]))
            session_start = previous
        floors.append(floor)
        starts.append(session_start)
        last_session_index[session] = i
        if session not in session_cutoffs:
            session_cutoffs[session] = datetime.combine(session, time(16, 10), tzinfo=NY).astimezone(timezone.utc)
        cutoff = session_cutoffs[session]
        if times[i] < cutoff:
            last_before_cutoff[session] = i

    # Once another session appears, a prior close must be observable at 16:10.
    # Holidays/early closes are not inferred from absent bars.
    ordered_sessions = list(last_session_index)
    first_start = datetime.combine(ordered_sessions[0] - timedelta(days=1), time(18, 0), tzinfo=NY).astimezone(timezone.utc)
    partial_first_session = times[0] > first_start
    partial_final_session = False
    for session in ordered_sessions:
        cutoff = session_cutoffs[session]
        final = session == ordered_sessions[-1]
        if final and times[last_session_index[session]] + timedelta(seconds=seconds) < cutoff:
            partial_final_session = True
            continue
        last = last_before_cutoff.get(session)
        if last is None or times[last] + timedelta(seconds=seconds) != cutoff:
            reasons.append("missing_or_unaligned_session_close")
    for i in range(1, len(times)):
        if sessions[i] == sessions[i - 1]:
            close = session_cutoffs[sessions[i]]
            if times[i] < close and times[i] - times[i - 1] > timedelta(seconds=seconds):
                reasons.append("missing_bars_within_session")

    first_index = None
    first_rule = None
    worst_equity = None
    prior_balance = float(initial_balance)
    cutoffs = [session_cutoffs[day] for day in ordered_sessions]
    last_exit = None
    for trade in trades:
        try:
            entry, exit_time = _timestamp(trade["entry_time"]), _timestamp(trade["exit_time"])
            quantity, price = float(trade["quantity"]), float(trade["entry_price"])
            commission, pnl = float(trade.get("commission") or 0), float(trade["pnl"])
            side = trade["side"]
            if not all(math.isfinite(v) for v in (quantity, price, commission, pnl)) or quantity <= 0 or side not in ("buy", "sell") or exit_time < entry:
                raise ValueError("invalid trade")
        except (KeyError, ValueError, TypeError, OverflowError):
            reasons.append("incomplete_trade_evidence")
            continue
        if last_exit is not None and entry < last_exit:
            reasons.append("overlapping_or_unordered_trades")
        last_exit = exit_time
        if entry < times[0] or exit_time > times[-1]:
            reasons.append("trade_outside_evidence_window")
        local_entry = entry.astimezone(NY)
        if (local_entry.hour, local_entry.minute) >= (16, 10) and local_entry.hour < 18:
            reasons.append("entry_outside_regular_trading_hours")
        next_cutoff = bisect_right(cutoffs, entry)
        if next_cutoff < len(cutoffs) and cutoffs[next_cutoff] <= exit_time:
            reasons.append("position_over_regular_session_close")
        start = bisect_left(times, entry)
        end = bisect_right(times, exit_time)
        for i in range(start, end):
            bar = bars[i]
            adverse_price = float(bar["low"] if side == "buy" else bar["high"])
            points = adverse_price - price if side == "buy" else price - adverse_price
            adverse_equity = prior_balance + points * quantity * tick_value / tick_size - commission
            touched_rule = None
            if adverse_equity < floors[i]:
                touched_rule = "maximum_loss"
            elif rules.get("daily_loss_mode") == "soft_pause" and rules.get("daily_loss_limit") is not None and adverse_equity <= starts[i] - rules["account_size"] * rules["daily_loss_limit"]:
                touched_rule = "daily_soft_pause"
            if touched_rule and (first_index is None or i < first_index):
                first_index, first_rule, worst_equity = i, touched_rule, round(adverse_equity, 2)
        prior_balance += pnl

    return {
        "incomplete": bool(reasons), "reasons": sorted(set(reasons)), "partial_first_session": partial_first_session, "partial_final_session": partial_final_session,
        "possible_intrabar_limit": first_index is not None,
        "first_intrabar_time": times[first_index].isoformat() if first_index is not None else None,
        "first_intrabar_rule": first_rule, "worst_equity": worst_equity,
    }
