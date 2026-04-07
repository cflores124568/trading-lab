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
class Trade(BaseModel):
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
    sortino_ratio: float
    avg_trade_duration: float
    best_trade: float
    worst_trade: float

#Prop firm evals/challenges/combines
class PropFirmEvaluation(BaseModel):
    passed: bool
    daily_loss_breached: bool
    drawdown_breached: bool
    profit_target_hit: bool
    consistency_passed: bool
    min_trading_days_passed: bool = True
    details: dict[str, Any]


class ReplayContext(BaseModel):
    source: str
    symbol: Optional[str] = None
    interval: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None


class ReplayAction(BaseModel):
    id: str
    bar_index: int = Field(ge=0)
    type: str
    created_at: int = Field(ge=0)


class ReplaySessionBase(BaseModel):
    name: str
    symbol: str
    interval: str
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    prop_firm_rules: PropFirmRules
    commission: float = Field(default=5.0, ge=0)
    tick_value: float = Field(default=1.0, gt=0)
    current_bar_index: int = Field(default=0, ge=0)
    status: str = Field(default="active")
    actions: List[ReplayAction] = Field(default_factory=list)
    trades: List[Trade] = Field(default_factory=list)
    metrics: PerformanceMetrics
    prop_firm_eval: PropFirmEvaluation
    equity_curve: List[float] = Field(default_factory=list)


class ReplaySessionCreate(ReplaySessionBase):
    pass


class ReplaySessionUpdate(ReplaySessionBase):
    pass


class ReplaySessionResult(ReplaySessionBase):
    replay_session_id: str
    created_at: str
    updated_at: str


class ReplaySessionSummary(BaseModel):
    replay_session_id: str
    name: str
    symbol: str
    interval: str
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    status: str
    current_bar_index: int
    total_pnl: float
    total_trades: int
    created_at: str
    updated_at: str

#Backtest request/response
class BacktestRequest(BaseModel):
    dataset_id:      str
    strategy:        Strategy
    prop_firm_rules: PropFirmRules
    start_date:      Optional[str]  = None
    end_date:        Optional[str]  = None
    initial_balance: float          = Field(default=100_000, gt=0)
    position_size:   float          = Field(default=1.0, gt=0)
    commission:      float          = Field(default=5.0, ge=0)

class BacktestResult(BaseModel):
    backtest_id:    str
    dataset_id:     str
    symbol:         Optional[str]   = None   # e.g. "NQ", "ES" — set for Databento backtests
    replay_context: Optional[ReplayContext] = None
    strategy:       Strategy
    prop_firm_rules: PropFirmRules
    status:         str
    created_at:     str
    trades:         List[Trade]
    metrics:        PerformanceMetrics
    prop_firm_eval: PropFirmEvaluation
    equity_curve:   List[float]

class BacktestSummary(BaseModel):
    backtest_id:    str
    dataset_id:     str
    symbol:         Optional[str]   = None   # e.g. "NQ", "ES" — set for Databento backtests
    strategy_type:  StrategyType
    status:         str
    total_pnl:      float
    win_rate:       float
    created_at:     str

class BacktestCompare(BaseModel):
    backtest_a: BacktestResult
    backtest_b: BacktestResult
    comparison: dict[str, Any]

#Parquet load request
class ParquetLoadRequest(BaseModel):
    symbol: str
    interval: str = "1min"
    start_date: Optional[str] = None
    end_date: Optional[str] = None

#Data / Upload 
class DatasetInfo(BaseModel):
    dataset_id: str
    name: str
    rows: int
    columns: List[str]
    start_date: str
    end_date: str
    uploaded_at: str
    source: Optional[str] = None
    symbol: Optional[str] = None
    interval: Optional[str] = None

# DB Symbol lookup
class LoadSymbolRequest(BaseModel):
    symbol: str
    interval: str = "15min"
    start_date: Optional[str] = None
    end_date: Optional[str] = None

class SymbolInfo(BaseModel):
    symbol: str
    full_name: str
    exchange: str
    tick_size: float
    tick_value: float
    rows: int
    start_date: str
    end_date: str
