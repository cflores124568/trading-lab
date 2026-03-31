from copy import deepcopy
from datetime import datetime
from threading import Lock
from typing import Optional

_backtest_store: dict[str, dict] = {}
_store_lock = Lock()

def add_backtest(backtest_id: str, result: dict) -> None:
    """Store a backtest result in memory for fast local reads.

    This keeps a deep snapshot instead of the original object, so later tweaks
    to nested trades, metrics, or equity data don't quietly leak back into the
    store and mess up older results.
    """
    entry = deepcopy(result)
    entry["stored_at"] = datetime.utcnow().isoformat()
    with _store_lock:
        _backtest_store[backtest_id] = entry

def get_backtest(backtest_id: str) -> Optional[dict]:
    """Load one in-memory backtest and hand back a safe copy.

    Returning a deep copy keeps callers from mutating the shared store by
    accident, which gets more important now that memory is acting as the
    fallback path when Postgres isn't available.
    """
    with _store_lock:
        data = _backtest_store.get(backtest_id)
        if data is None:
            return None
        return deepcopy(data)

def list_backtests() -> list[dict]:
    """List all in-memory backtests as safe copies.

    Each entry already has its own `backtest_id`, so this just returns the
    stored payloads without inventing an extra `id` field that the rest of the
    app doesn't actually use.
    """
    with _store_lock:
        return [deepcopy(entry) for entry in _backtest_store.values()]

def delete_backtest(backtest_id: str) -> bool:
    """Delete one in-memory backtest if it exists."""
    with _store_lock:
        if backtest_id not in _backtest_store:
            return False
        del _backtest_store[backtest_id]
        return True
