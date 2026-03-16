from typing import Dict, Optional
from threading import Lock
from datetime import datetime

backtest_store: Dict[str, dict] = {}
store_lock = Lock()

def add_backtest(backtest_id: str, result: dict) -> None:
    result = result.copy()  #Snapshot so mutations dont carry over
    result["stored_at"] = datetime.utcnow().isoformat()
    with store_lock:
        backtest_store[backtest_id] = result

def get_backtest(backtest_id: str) -> Optional[dict]:
    with store_lock:
        data = backtest_store.get(backtest_id)
        if data is None:
            return None
        return data.copy()  

def list_backtests() -> list[dict]:
    result = []
    with store_lock:
        for k, v in backtest_store.items():
            entry = v.copy()
            entry["id"] = k
            result.append(entry)
    return result

def delete_backtest(backtest_id: str) -> bool:
    with store_lock:
        if backtest_id not in backtest_store:
            return False
        del backtest_store[backtest_id]
        return True