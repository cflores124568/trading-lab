from typing import Dict, Optional
import pandas as pd
from threading import Lock
from datetime import datetime

dataset_store: Dict[str, dict] = {}
store_lock = Lock()

def add_dataset(dataset_id: str, info: dict, df: pd.DataFrame) -> None:
    if not isinstance(df, pd.DataFrame):
        raise ValueError("df must be a pandas DataFrame")

    info = info.copy()
    info["uploaded_at"] = datetime.utcnow().isoformat()
    info["rows"] = len(df)
    info["columns"] = list(df.columns)

    if df.memory_usage(deep=True).sum() > 1_500_000_000:  #~1.5 GB hard cap
        raise ValueError("Dataset too large for in-memory storage")

    with store_lock:
        dataset_store[dataset_id] = {"info": info, "df": df.copy()}  #Copy so mutations outside don't bleed in

def get_dataset(dataset_id: str) -> Optional[dict]:
    with store_lock:
        data = dataset_store.get(dataset_id)
        if data is None:
            return None
        return {"info": data["info"].copy(), "df": data["df"].copy()}  #Copies keep the stored data safe

def list_datasets() -> list[dict]:
    with store_lock:
        return [v["info"] | {"id": k} for k, v in dataset_store.items()]

def delete_dataset(dataset_id: str) -> bool:
    with store_lock:
        return dataset_store.pop(dataset_id, None) is not None  #returns False instead of raising on missing key