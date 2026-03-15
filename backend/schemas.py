#Pydantic schemas for my Trading Lab API
from enum import Enum
from typing import Any, List, Optional
from pydantic import BaseModel, Field

# Health 
class HealthResponse(BaseModel):
    status: str
    
# Enums
class OrderSide(str, Enum):
    BUY = "buy"
    SELL = "sell"

class TradeStatus(str, Enum):
    OPEN = "open"
    CLOSED = "closed"
class StrategyType(str, Enum):
    MA_CROSSOVER = "ma_crossover"
    EMA_CROSSOVER = "ema_crossover"
    RSI_OVERBOUGHT = "rsi_overbought"
    BOLLINGER_BANDS = "bollinger_bands"

class DrawdownType(str, Enum):
    INTRADAY = "intraday" 
    EOD = "eod"

# Strategy
class Strategy(BaseModel):
    type: StrategyType
    params: dict[str, Any] = Field(default_factory=dict)

#Prop-firm rules 
class PropFirmRules(BaseModel):
    name: str
    account_size: float = Field(default=100_000, gt=0)
    daily_loss_limit: float = Field(default=0.04, gt=0, le=1)
    max_drawdown: float = Field(default=0.08, gt=0, le=1)
    profit_target: float = Field(default=0.10, gt=0, le=1)
    consistency_rule: bool = Field(default=True)
    consistency_threshold: float = Field(default=0.30, gt=0, le=1)
    drawdown_type: DrawdownType = Field(default=DrawdownType.EOD)
    min_trading_days: Optional[int] = Field(default=None, ge=1)

#Trade
class Trade (BaseModel):
    trade_id: int
    entry_time: str
    exit_time: Optional[str]
    side: OrderSide
    entry_price: float
    exit_price: Optional[float]
    pnl: float
    status: TradeStatus
    commission: float

#Metrics
class PerformanceMetrics(BaseModel):
    total_trades: int
    winning_trades: int
    losing_trades: int
    win_rate: float
    total_pnl: float
    average_pnl: float
    profit_factor: float
    max_drawdown: float
    sharpe_ratio: float
    avg_trade_duration: float
    best_trade: float
    worst_trade: float

#Data / Upload 
class DatasetInfo(BaseModel):
    dataset_id: str
    name: str
    rows: int
    columns: List[str]
    start_date: str
    end_date: str
    uploaded_at: str