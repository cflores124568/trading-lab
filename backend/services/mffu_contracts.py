"""Resolve explicit MFFU single-instrument contract limits for research."""
import re


_MICROS = {"MES", "MNQ", "MYM", "M2K", "MGC", "SIL", "MCL"}
_MINIS = {"ES", "NQ", "YM", "RTY", "GC", "SI", "CL"}
_ROOT = re.compile(r"^(M2K|MES|MNQ|MYM|MGC|SIL|MCL|RTY|ES|NQ|YM|GC|SI|CL)(?=$|[.=_-]|[FGHJKMNQUVXZ]\d{1,4}$)")


def contract_limit(symbol: str, rules) -> int | None:
    mini = rules.max_mini_contracts
    micro = rules.max_micro_contracts
    if mini is None and micro is None:
        return None
    match = _ROOT.match(str(symbol or "").strip().upper())
    if not match:
        raise ValueError("Cannot verify the MFFU contract limit for this symbol; use a supported mini or micro futures symbol.")
    root = match.group(1)
    limit = micro if root in _MICROS else mini if root in _MINIS else None
    if limit is None or limit < 1:
        raise ValueError(f"{root} is not permitted by this account's contract limits.")
    return limit


def effective_max_contracts(symbol: str, request) -> int | None:
    limit = contract_limit(symbol, request.prop_firm_rules)
    if limit is None:
        return request.max_position_size
    if request.sizing_mode == "fixed":
        if request.position_size > limit:
            raise ValueError(f"Requested {request.position_size} contracts exceeds the account limit of {limit} for {symbol}.")
        return None
    return min(limit, request.max_position_size) if request.max_position_size is not None else limit
