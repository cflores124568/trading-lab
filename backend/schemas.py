#Pydantic schemas for Trading Lab API.
from pydantic import BaseModel
from typing import List
from enum import Enum

class HealthResponse(BaseModel):
    status: str

class DatasetInfo(BaseModel):
    dataset_id: str
    name: str
    rows: int
    columns: List[str]
    start_date: str
    end_date: str
    uploaded_at: str

class StrategyType(str, Enum):
    MA_CROSSOVER    = "ma_crossover"
    EMA_CROSSOVER   = "ema_crossover"
    RSI_OVERBOUGHT  = "rsi_overbought"
    BOLLINGER_BANDS = "bollinger_bands"