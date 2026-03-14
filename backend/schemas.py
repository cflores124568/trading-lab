#Pydantic schemas for Trading Lab API
from enum import Enum
from typing import Any, List
from pydantic import BaseModel, Field


# Health 
class HealthResponse(BaseModel):
    status: str
# Enums
class StrategyType(str, Enum):
    MA_CROSSOVER    = "ma_crossover"
    EMA_CROSSOVER   = "ema_crossover"
    RSI_OVERBOUGHT  = "rsi_overbought"
    BOLLINGER_BANDS = "bollinger_bands"

# Strategy
class Strategy(BaseModel):
    type:   StrategyType
    params: dict[str, Any] = Field(default_factory=dict)


#Data / Upload 
class DatasetInfo(BaseModel):
    dataset_id:  str
    name:        str
    rows:        int
    columns:     List[str]
    start_date:  str
    end_date:    str
    uploaded_at: str