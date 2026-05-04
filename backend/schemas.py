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
    tick_size: Optional[float] = None
    tick_value: Optional[float] = None
    slippage_ticks: Optional[float] = None

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


class ReplaySessionSourceBacktest(BaseModel):
    backtest_id: str
    symbol: Optional[str] = None
    interval: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    strategy_type: Optional[str] = None


class ReplaySessionBase(BaseModel):
    name: str
    symbol: str
    interval: str
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    source_backtest: Optional[ReplaySessionSourceBacktest] = None
    prop_firm_rules: PropFirmRules
    commission: float = Field(default=5.0, ge=0)
    tick_value: float = Field(default=1.0, gt=0)
    tick_size: float = Field(default=0.25, gt=0)
    spread_ticks: int = Field(default=1, ge=1)
    volatile_bar_threshold_ticks: int = Field(default=0, ge=0)
    volatile_bar_extra_ticks: int = Field(default=0, ge=0)
    resting_fill_mode: str = Field(default="touch")
    current_bar_index: int = Field(default=0, ge=0)
    status: str = Field(default="active")
    actions: List[ReplayAction] = Field(default_factory=list)
    active_order: Optional[dict[str, Any]] = None
    execution_events: List[dict[str, Any]] = Field(default_factory=list)
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
    source_backtest: Optional[ReplaySessionSourceBacktest] = None
    status: str
    current_bar_index: int
    total_pnl: float
    total_trades: int
    created_at: str
    updated_at: str


class ExperimentScoringRule(str, Enum):
    PROP_SCORE_V1 = "prop_score_v1"
    TOTAL_PNL = "total_pnl"
    SHARPE_RATIO = "sharpe_ratio"
    PROFIT_FACTOR = "profit_factor"


class ExperimentStatus(str, Enum):
    DRAFT = "draft"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class ExperimentRunStatus(str, Enum):
    COMPLETED = "completed"
    FAILED = "failed"


class CandidateLifecycleStatus(str, Enum):
    CANDIDATE = "candidate"
    APPROVED = "approved"
    PAPER_READY = "paper_ready"
    PAPER_RUNNING = "paper_running"
    PAPER_PAUSED = "paper_paused"
    REJECTED = "rejected"


class PaperBotStatus(str, Enum):
    DRAFT = "draft"
    READY = "ready"
    PAPER_RUNNING = "paper_running"
    STOPPED = "stopped"


class PaperSessionStatus(str, Enum):
    DRAFT = "draft"
    READY = "ready"
    RUNNING = "running"
    PAUSED = "paused"
    STOPPED = "stopped"
    FAILED = "failed"


class PaperSessionTradeAction(str, Enum):
    BUY = "buy"
    SELL = "sell"
    MARK = "mark"
    EXIT = "exit"
    LIFT_ASK = "lift_ask"
    HIT_BID = "hit_bid"
    JOIN_BID = "join_bid"
    JOIN_ASK = "join_ask"
    REST_EXIT = "rest_exit"
    REPLACE = "replace"
    CANCEL = "cancel"
    FLATTEN = "flatten"


class ExperimentBase(BaseModel):
    name: str
    symbols: List[str] = Field(default_factory=list)
    intervals: List[str] = Field(default_factory=list)
    strategy_type: StrategyType
    parameter_space: dict[str, List[Any]] = Field(default_factory=dict)
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    prop_firm_rules: PropFirmRules
    initial_balance: float = Field(default=100_000, gt=0)
    position_size: float = Field(default=1.0, gt=0)
    commission: float = Field(default=5.0, ge=0)
    scoring_rule: ExperimentScoringRule = Field(default=ExperimentScoringRule.PROP_SCORE_V1)


class ExperimentCreate(ExperimentBase):
    pass


class ExperimentResult(ExperimentBase):
    experiment_id: str
    status: ExperimentStatus = Field(default=ExperimentStatus.DRAFT)
    total_runs: int = 0
    completed_runs: int = 0
    failed_runs: int = 0
    best_run_id: Optional[str] = None
    best_backtest_id: Optional[str] = None
    last_run_at: Optional[str] = None
    created_at: str
    updated_at: str


class ExperimentRunResult(BaseModel):
    experiment_run_id: str
    experiment_id: str
    candidate_id: Optional[str] = None
    backtest_id: Optional[str] = None
    symbol: str
    interval: str
    strategy_type: StrategyType
    strategy_params: dict[str, Any] = Field(default_factory=dict)
    dataset_id: Optional[str] = None
    status: ExperimentRunStatus
    score: Optional[float] = None
    rank: Optional[int] = None
    total_pnl: Optional[float] = None
    win_rate: Optional[float] = None
    max_drawdown: Optional[float] = None
    profit_factor: Optional[float] = None
    passed: Optional[bool] = None
    error: Optional[str] = None
    metrics: Optional[PerformanceMetrics] = None
    prop_firm_eval: Optional[PropFirmEvaluation] = None
    is_candidate: bool = False
    promoted_at: Optional[str] = None
    created_at: str
    updated_at: str


class ExperimentExecutionResult(BaseModel):
    experiment: ExperimentResult
    results: List[ExperimentRunResult]


class CandidateNote(BaseModel):
    note_id: str
    body: str
    author: str = "local-user"
    created_at: str


class CandidateAuditEvent(BaseModel):
    event_id: str
    event_type: str
    actor: str = "local-user"
    summary: str
    changes: dict[str, Any] = Field(default_factory=dict)
    created_at: str


class PaperBotConfig(BaseModel):
    paper_bot_id: str
    candidate_id: str
    symbol: str
    interval: str
    strategy_type: StrategyType
    strategy_params: dict[str, Any] = Field(default_factory=dict)
    guardrails: dict[str, Any] = Field(default_factory=dict)
    status: PaperBotStatus = Field(default=PaperBotStatus.DRAFT)
    paper_session_id: Optional[str] = None
    last_event_at: Optional[str] = None
    created_at: str
    updated_at: str


class PaperSessionBase(BaseModel):
    candidate_id: str
    paper_bot_id: Optional[str] = None
    name: str
    symbol: str
    interval: str
    strategy_type: StrategyType
    strategy_params: dict[str, Any] = Field(default_factory=dict)
    prop_firm_rules: PropFirmRules
    guardrails: dict[str, Any] = Field(default_factory=dict)
    status: PaperSessionStatus = Field(default=PaperSessionStatus.DRAFT)
    commission: float = Field(default=5.0, ge=0)
    tick_value: float = Field(default=1.0, gt=0)
    tick_size: float = Field(default=0.25, gt=0)
    spread_ticks: int = Field(default=1, ge=1)
    volatile_bar_threshold_ticks: int = Field(default=0, ge=0)
    volatile_bar_extra_ticks: int = Field(default=0, ge=0)
    resting_fill_mode: str = Field(default="touch")
    current_position: dict[str, Any] = Field(default_factory=dict)
    active_order: dict[str, Any] = Field(default_factory=dict)
    last_quote: dict[str, Any] = Field(default_factory=dict)
    trade_log: List[Trade] = Field(default_factory=list)
    equity_curve: List[float] = Field(default_factory=list)
    metrics_snapshot: dict[str, Any] = Field(default_factory=dict)
    guardrail_state: dict[str, Any] = Field(default_factory=dict)
    runner_state: dict[str, Any] = Field(default_factory=dict)
    last_bar_time: Optional[str] = None
    last_event_at: Optional[str] = None
    created_by: str = "local-user"


class PaperSessionCreate(BaseModel):
    actor: str = Field(default="local-user")
    name: Optional[str] = None


class PaperSessionStatusUpdate(BaseModel):
    status: PaperSessionStatus
    actor: str = Field(default="local-user")
    summary: Optional[str] = None


class PaperSessionExecutionRequest(BaseModel):
    action: PaperSessionTradeAction
    price: Optional[float] = Field(default=None, gt=0)
    filled_at: Optional[str] = None
    actor: str = Field(default="local-user")
    note: Optional[str] = None


class PaperRunnerStartRequest(BaseModel):
    actor: str = Field(default="local-user")
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    poll_interval_ms: int = Field(default=750, ge=100, le=60_000)
    reset_cursor: bool = False


class PaperRunnerPauseRequest(BaseModel):
    actor: str = Field(default="local-user")
    summary: Optional[str] = None


class PaperRunnerStepRequest(BaseModel):
    actor: str = Field(default="local-user")
    steps: int = Field(default=1, ge=1, le=500)


class PaperSessionResult(PaperSessionBase):
    paper_session_id: str
    created_at: str
    updated_at: str


class PaperSessionSummary(BaseModel):
    paper_session_id: str
    candidate_id: str
    name: str
    symbol: str
    interval: str
    status: PaperSessionStatus
    last_event_at: Optional[str] = None
    created_at: str
    updated_at: str


class PaperEventCreate(BaseModel):
    event_type: str = Field(min_length=1, max_length=80)
    summary: str = Field(min_length=1, max_length=1000)
    actor: str = Field(default="local-user")
    payload: dict[str, Any] = Field(default_factory=dict)


class PaperEventResult(BaseModel):
    paper_event_id: str
    paper_session_id: str
    candidate_id: str
    event_type: str
    actor: str = "local-user"
    summary: str
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: str


class CandidateResult(BaseModel):
    candidate_id: str
    experiment_id: str
    experiment_name: str
    experiment_run_id: str
    backtest_id: str
    symbol: str
    interval: str
    strategy_type: StrategyType
    strategy_params: dict[str, Any] = Field(default_factory=dict)
    prop_firm_rules: PropFirmRules
    experiment_snapshot: dict[str, Any] = Field(default_factory=dict)
    score: Optional[float] = None
    rank: Optional[int] = None
    total_pnl: Optional[float] = None
    win_rate: Optional[float] = None
    max_drawdown: Optional[float] = None
    profit_factor: Optional[float] = None
    passed: Optional[bool] = None
    metrics: Optional[PerformanceMetrics] = None
    prop_firm_eval: Optional[PropFirmEvaluation] = None
    lifecycle_status: CandidateLifecycleStatus = Field(default=CandidateLifecycleStatus.CANDIDATE)
    promotion_reason: str
    promoted_by: str = "local-user"
    promoted_at: str
    approved_by: Optional[str] = None
    approved_at: Optional[str] = None
    paper_bot: Optional[PaperBotConfig] = None
    notes: List[CandidateNote] = Field(default_factory=list)
    audit_log: List[CandidateAuditEvent] = Field(default_factory=list)
    created_at: str
    updated_at: str


class CandidateStatusUpdate(BaseModel):
    status: CandidateLifecycleStatus
    actor: str = Field(default="local-user")


class CandidateNoteCreate(BaseModel):
    body: str = Field(min_length=1, max_length=4000)
    author: str = Field(default="local-user")


class CandidatePaperBotCreate(BaseModel):
    actor: str = Field(default="local-user")


class CandidatePaperBotStatusUpdate(BaseModel):
    status: PaperBotStatus
    actor: str = Field(default="local-user")

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
    tick_size:       float          = Field(default=0.25, gt=0)
    tick_value:      float          = Field(default=12.5, gt=0)
    slippage_ticks:  float          = Field(default=1.0, ge=0)
    stop_loss_ticks: Optional[float] = Field(default=None, gt=0)
    take_profit_ticks: Optional[float] = Field(default=None, gt=0)


class BacktestRunConfig(BaseModel):
    initial_balance: float = Field(default=100_000, gt=0)
    position_size: float = Field(default=1.0, gt=0)
    commission: float = Field(default=5.0, ge=0)
    tick_size: float = Field(default=0.25, gt=0)
    tick_value: float = Field(default=12.5, gt=0)
    slippage_ticks: float = Field(default=1.0, ge=0)
    stop_loss_ticks: Optional[float] = Field(default=None, gt=0)
    take_profit_ticks: Optional[float] = Field(default=None, gt=0)

class BacktestResult(BaseModel):
    backtest_id:    str
    dataset_id:     str
    symbol:         Optional[str]   = None   # e.g. "NQ", "ES" — set for Databento backtests
    replay_context: Optional[ReplayContext] = None
    strategy:       Strategy
    prop_firm_rules: PropFirmRules
    run_config:     BacktestRunConfig
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
    replay_context: Optional[ReplayContext] = None
    strategy_type:  StrategyType
    status:         str
    total_pnl:      float
    win_rate:       float
    created_at:     str

class BacktestCompare(BaseModel):
    backtest_a: BacktestResult
    backtest_b: BacktestResult
    comparison: dict[str, Any]


class RobustnessDistribution(BaseModel):
    p05: float
    median: float
    p95: float
    worst: float
    best: float


class RobustnessMonteCarloScenario(BaseModel):
    key: str
    label: str
    simulations: int
    total_pnl: RobustnessDistribution
    max_drawdown: RobustnessDistribution
    profitable_rate: float
    worse_than_base_drawdown_rate: float
    note: str


class RobustnessSweepRun(BaseModel):
    rank: int
    params: dict[str, Any] = Field(default_factory=dict)
    score: float
    total_pnl: float
    max_drawdown: float
    profit_factor: float
    passed: bool


class RobustnessParameterSweep(BaseModel):
    ranking_rule: str
    total_runs: int
    profitable_rate: float
    passing_rate: float
    baseline_rank: Optional[int] = None
    median_score: float
    median_total_pnl: float
    top_runs: List[RobustnessSweepRun] = Field(default_factory=list)
    bottom_run: Optional[RobustnessSweepRun] = None
    note: str


class RobustnessWalkForwardFold(BaseModel):
    fold_index: int
    train_start: str
    train_end: str
    test_start: str
    test_end: str
    selected_params: dict[str, Any] = Field(default_factory=dict)
    train_score: float
    test_score: float
    test_total_pnl: float
    test_max_drawdown: float
    test_passed: bool
    test_trades: int


class RobustnessWalkForward(BaseModel):
    ranking_rule: str
    folds_requested: int
    folds_completed: int
    profitable_rate: float
    passing_rate: float
    total_test_pnl: float
    average_test_score: float
    average_test_pnl: float
    folds: List[RobustnessWalkForwardFold] = Field(default_factory=list)
    note: str


class RobustnessBaseline(BaseModel):
    total_pnl: float
    max_drawdown: float
    profit_factor: float
    win_rate: float
    total_trades: int
    passed: bool


class BacktestRobustnessResult(BaseModel):
    backtest_id: str
    symbol: Optional[str] = None
    strategy_type: StrategyType
    run_config: BacktestRunConfig
    baseline: RobustnessBaseline
    monte_carlo: List[RobustnessMonteCarloScenario] = Field(default_factory=list)
    parameter_sweep: RobustnessParameterSweep
    walk_forward: RobustnessWalkForward
    warnings: List[str] = Field(default_factory=list)

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
    tick_size: Optional[float] = None
    tick_value: Optional[float] = None

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
