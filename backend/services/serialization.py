from __future__ import annotations

from datetime import date, datetime
from typing import Any

import numpy as np


def to_plain_data(value: Any) -> Any:
    """Turn nested app data into plain Python types.

    NumPy likes sneaking in scalar types like `bool_` and `int64`, which look
    harmless until `json.dumps` or FastAPI tries to serialize them and blows up.
    I normalize those here so the rest of the app can keep returning normal
    dict/list payloads without random save-time nonsense.
    """
    if isinstance(value, dict):
        return {key: to_plain_data(item) for key, item in value.items()}

    if isinstance(value, list):
        return [to_plain_data(item) for item in value]

    if isinstance(value, tuple):
        return [to_plain_data(item) for item in value]

    if isinstance(value, np.ndarray):
        return [to_plain_data(item) for item in value.tolist()]

    if isinstance(value, np.generic):
        return to_plain_data(value.item())

    if isinstance(value, (datetime, date)):
        return value.isoformat()

    return value
