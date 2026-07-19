#Pydantic schemas for my Trading Lab API
from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import Annotated, Any, List, Literal, Optional, Union
from pydantic import BaseModel, Field, model_validator

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
    daily_loss_limit: Optional[float] = Field(default=0.04, ge=0, le=1)
    max_drawdown: float = Field(default=0.08, gt=0, le=1)
    profit_target: float = Field(default=0.10, gt=0, le=1)
    consistency_rule: bool = Field(default=True)
    consistency_threshold: Optional[float] = Field(default=0.30, ge=0, le=1)
    drawdown_type: DrawdownType = Field(default=DrawdownType.EOD)
    min_trading_days: Optional[int] = Field(default=None, ge=1)

    @model_validator(mode="after")
    def _normalize_disabled_rules(self) -> "PropFirmRules":
        if self.daily_loss_limit == 0:
            self.daily_loss_limit = None

        if self.consistency_rule:
            if self.consistency_threshold is None or self.consistency_threshold <= 0:
                raise ValueError("consistency_threshold must be set when consistency_rule is true.")
        else:
            self.consistency_threshold = None

        return self

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
    quantity: Optional[float] = None
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
    profit_factor: Optional[float] = None
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
    price: Optional[float] = Field(default=None, gt=0)
    stop_price: Optional[float] = Field(default=None, gt=0)
    target_price: Optional[float] = Field(default=None, gt=0)
    order_id: Optional[str] = None
    bracket_role: Optional[Literal["stop", "target"]] = None


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
    position_size: float = Field(default=1.0, gt=0)
    spread_ticks: int = Field(default=1, ge=1)
    volatile_bar_threshold_ticks: int = Field(default=0, ge=0)
    volatile_bar_extra_ticks: int = Field(default=0, ge=0)
    resting_fill_mode: str = Field(default="touch")
    current_bar_index: int = Field(default=0, ge=0)
    status: str = Field(default="active")
    actions: List[ReplayAction] = Field(default_factory=list)
    active_order: Optional[dict[str, Any]] = None
    active_orders: List[dict[str, Any]] = Field(default_factory=list)
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
    prop_firm_rules: PropFirmRules
    prop_firm_eval: PropFirmEvaluation
    status: str
    current_bar_index: int
    total_pnl: float
    total_trades: int
    equity_curve: List[float] = Field(default_factory=list)
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


class ResearchCampaignStatus(str, Enum):
    DRAFT = "draft"
    QUEUED = "queued"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"


class ResearchTrialStatus(str, Enum):
    COMPLETED = "completed"
    FAILED = "failed"


class ResearchHypothesisAttemptStatus(str, Enum):
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    DUPLICATE = "duplicate"
    NEAR_DUPLICATE = "near_duplicate"
    BUDGET_REJECTED = "budget_rejected"


class ResearchValidationOutcome(str, Enum):
    RESEARCH_FINALIST = "research_finalist"
    REJECTED = "rejected"


class ResearchHoldoutStatus(str, Enum):
    SEALED = "sealed"
    EVALUATED = "evaluated"


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


class PaperPolicyMode(str, Enum):
    SHADOW = "shadow"
    APPROVAL_REQUIRED = "approval_required"
    AUTONOMOUS_PAPER = "autonomous_paper"


class PaperDecisionStatus(str, Enum):
    GENERATED = "generated"
    NO_ACTION = "no_action"
    SHADOWED = "shadowed"
    PENDING_APPROVAL = "pending_approval"
    EXECUTED = "executed"
    REJECTED = "rejected"
    BLOCKED = "blocked"


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
    ATTACH_BRACKET = "attach_bracket"
    REPLACE = "replace"
    CANCEL = "cancel"
    FLATTEN = "flatten"


class PaperMarketObservation(BaseModel):
    paper_session_id: str
    candidate_id: str
    symbol: str
    interval: str
    observed_at: str
    bar_index: int = Field(ge=0)
    bar: dict[str, Any]
    signal: int = Field(ge=-1, le=1)
    current_position: dict[str, Any] = Field(default_factory=dict)
    active_orders: List[dict[str, Any]] = Field(default_factory=list)
    metrics_snapshot: dict[str, Any] = Field(default_factory=dict)
    guardrail_state: dict[str, Any] = Field(default_factory=dict)


class PaperMarketEventBase(BaseModel):
    event_id: str = Field(min_length=1, max_length=200)
    source: str = Field(min_length=1, max_length=80)
    symbol: str = Field(min_length=1, max_length=80)
    instrument_id: Optional[str] = Field(default=None, max_length=120)
    publisher_id: Optional[str] = Field(default=None, max_length=120)
    event_time: str
    received_time: str
    sequence: int = Field(ge=0)


class PaperBBOEvent(PaperMarketEventBase):
    event_type: Literal["bbo"] = "bbo"
    bid_price: float = Field(gt=0)
    ask_price: float = Field(gt=0)
    bid_size: float = Field(ge=0)
    ask_size: float = Field(ge=0)
    bid_order_count: int = Field(default=0, ge=0)
    ask_order_count: int = Field(default=0, ge=0)


class PaperTradeEvent(PaperMarketEventBase):
    event_type: Literal["trade"] = "trade"
    price: float = Field(gt=0)
    size: float = Field(gt=0)
    aggressor_side: Literal["buy", "sell", "unknown"] = "unknown"


PaperMarketEvent = Annotated[
    Union[PaperBBOEvent, PaperTradeEvent],
    Field(discriminator="event_type"),
]


class PaperMarketSequenceGap(BaseModel):
    expected_sequence: int = Field(ge=0)
    received_sequence: int = Field(ge=0)
    missing_count: int = Field(ge=1)


class PaperMarketEventDisposition(BaseModel):
    status: Literal[
        "accepted",
        "accepted_with_gap",
        "duplicate",
        "stale",
        "rejected_locked",
        "rejected_crossed",
    ]
    reason: str
    event: PaperMarketEvent
    gap: Optional[PaperMarketSequenceGap] = None
    normalized_quote: Optional[dict[str, Any]] = None
    normalized_trade: Optional[dict[str, Any]] = None


class PaperRiskCheck(BaseModel):
    code: str
    passed: bool
    summary: str


class PaperRiskAssessment(BaseModel):
    assessment_id: str
    decision_id: str
    status: Literal["approved", "blocked"]
    checks: List[PaperRiskCheck] = Field(default_factory=list)
    violations: List[str] = Field(default_factory=list)
    checked_at: str


class PaperShadowScorecard(BaseModel):
    policy_name: str
    policy_version: str
    total_decisions: int = Field(default=0, ge=0)
    actionable_decisions: int = Field(default=0, ge=0)
    no_action_decisions: int = Field(default=0, ge=0)
    mark_decisions: int = Field(default=0, ge=0)
    buy_proposals: int = Field(default=0, ge=0)
    sell_proposals: int = Field(default=0, ge=0)
    exit_proposals: int = Field(default=0, ge=0)
    bullish_observations: int = Field(default=0, ge=0)
    bearish_observations: int = Field(default=0, ge=0)
    flat_observations: int = Field(default=0, ge=0)
    first_observed_at: Optional[str] = None
    last_observed_at: Optional[str] = None
    last_decision_id: Optional[str] = None


class PaperPolicyDecision(BaseModel):
    decision_id: str
    paper_session_id: str
    policy_name: str
    policy_version: str
    policy_mode: PaperPolicyMode
    status: PaperDecisionStatus = PaperDecisionStatus.GENERATED
    observed_at: str
    signal: int = Field(ge=-1, le=1)
    actions: List[Literal["buy", "sell", "exit", "mark"]] = Field(default_factory=list)
    action_label: str
    rationale: str
    observation: PaperMarketObservation
    created_at: str
    risk_assessment: Optional[PaperRiskAssessment] = None
    resolved_at: Optional[str] = None
    resolved_by: Optional[str] = None


class PaperDecisionResolutionRequest(BaseModel):
    approved: bool
    actor: str = Field(default="local-user")
    note: Optional[str] = None


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
    slippage_ticks: float = Field(default=1.0, ge=0)
    execution_mode: Literal["bar", "synthetic_quotes"] = Field(default="bar")
    spread_ticks: int = Field(default=1, ge=1)
    volatile_bar_threshold_ticks: int = Field(default=0, ge=0)
    volatile_bar_extra_ticks: int = Field(default=0, ge=0)
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


class ResearchSplitConfig(BaseModel):
    development_pct: float = Field(default=60.0, gt=0, lt=100)
    validation_pct: float = Field(default=20.0, gt=0, lt=100)
    holdout_pct: float = Field(default=20.0, gt=0, lt=100)

    @model_validator(mode="after")
    def _require_complete_split(self) -> "ResearchSplitConfig":
        percentages = [
            Decimal(str(self.development_pct)),
            Decimal(str(self.validation_pct)),
            Decimal(str(self.holdout_pct)),
        ]
        if any(value.as_tuple().exponent < -4 for value in percentages):
            raise ValueError("research split percentages support at most four decimal places.")
        if sum(percentages) != Decimal("100"):
            raise ValueError("development, validation, and holdout percentages must total exactly 100.")
        return self


class ResearchCampaignCreate(ResearchSplitConfig):
    name: str = Field(min_length=1, max_length=160)
    symbol: str = Field(min_length=1, max_length=32)
    interval: str = Field(min_length=1, max_length=16)
    start_time: datetime
    end_time: datetime
    created_by: str = Field(default="local-user", min_length=1, max_length=120)


class ResearchPartition(BaseModel):
    partition_name: Literal["development", "validation", "holdout"]
    start_time: datetime
    end_time: datetime
    bar_count: int = Field(ge=1)


class ResearchCampaignAuditEvent(BaseModel):
    research_campaign_event_id: str
    campaign_id: str
    event_type: str
    actor: str
    summary: str
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class ResearchCampaignSummary(ResearchSplitConfig):
    campaign_id: str
    name: str
    symbol: str
    interval: str
    start_time: datetime
    end_time: datetime
    status: ResearchCampaignStatus
    total_bar_count: int = Field(ge=3)
    created_by: str
    created_at: datetime
    updated_at: datetime
    search_config: Optional[dict[str, Any]] = None
    trial_budget: Optional[int] = None
    wall_clock_budget_seconds: Optional[int] = None
    search_progress: dict[str, Any] = Field(default_factory=dict)
    queued_at: Optional[datetime] = None
    started_at: Optional[datetime] = None
    deadline_at: Optional[datetime] = None


class ResearchCampaignResult(ResearchCampaignSummary):
    partitions: List[ResearchPartition] = Field(min_length=3, max_length=3)
    audit_events: List[ResearchCampaignAuditEvent] = Field(default_factory=list)


class ResearchCampaignQueueRequest(BaseModel):
    strategy_type: StrategyType
    parameter_space: dict[str, List[Any]] = Field(default_factory=dict)
    execution_config: dict[str, Any] = Field(default_factory=dict)
    trial_budget: int = Field(ge=1, le=10_000)
    wall_clock_budget_seconds: int = Field(ge=10, le=604_800)
    actor: str = Field(default="local-user", min_length=1, max_length=120)

    @model_validator(mode="after")
    def _validate_parameter_space(self) -> "ResearchCampaignQueueRequest":
        combinations = 1
        for key, values in self.parameter_space.items():
            if not key.strip() or not values:
                raise ValueError("parameter_space requires non-empty keys and value lists.")
            combinations *= len(values)
            if combinations > 100_000:
                raise ValueError("parameter_space expands beyond the 100,000-plan safety limit.")
        return self


class ResearchCampaignControlRequest(BaseModel):
    actor: str = Field(default="local-user", min_length=1, max_length=120)


class ResearchTrialCreate(BaseModel):
    strategy_type: StrategyType
    strategy_params: dict[str, Any] = Field(default_factory=dict)
    execution_config: dict[str, Any] = Field(default_factory=dict)
    random_seed: int = 0
    status: ResearchTrialStatus
    result: Optional[dict[str, Any]] = None
    error: Optional[str] = Field(default=None, max_length=4000)
    created_by: str = Field(default="local-user", min_length=1, max_length=120)

    @model_validator(mode="after")
    def _require_terminal_outcome(self) -> "ResearchTrialCreate":
        if self.status == ResearchTrialStatus.COMPLETED and self.error is not None:
            raise ValueError("completed trials cannot include an error.")
        if self.status == ResearchTrialStatus.FAILED and not self.error:
            raise ValueError("failed trials must include an error.")
        return self


class ResearchTrialResult(BaseModel):
    trial_id: str
    campaign_id: str
    fingerprint: str
    strategy_type: StrategyType
    strategy_params: dict[str, Any] = Field(default_factory=dict)
    execution_config: dict[str, Any] = Field(default_factory=dict)
    random_seed: int
    status: ResearchTrialStatus
    result: Optional[dict[str, Any]] = None
    error: Optional[str] = None
    created_by: str
    created_at: datetime
    completed_at: datetime
    was_duplicate: bool = False


class ResearchHypothesisBudgetRequest(BaseModel):
    hypothesis_budget: int = Field(ge=1, le=1_000)
    trial_budget: int = Field(ge=1, le=1_000)
    actor: str = Field(default="local-user", min_length=1, max_length=120)


class ResearchHypothesisBudgetResult(BaseModel):
    campaign_id: str
    hypothesis_budget: int = Field(ge=1, le=1_000)
    trial_budget: int = Field(ge=1, le=1_000)
    attempted_hypotheses: int = Field(ge=0)
    accepted_hypotheses: int = Field(ge=0)
    executed_trials: int = Field(ge=0)


class ResearchHypothesisProposal(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    rationale: str = Field(min_length=1, max_length=2_000)
    expected_market_behavior: str = Field(min_length=1, max_length=2_000)
    strategy_primitive: str = Field(min_length=1, max_length=80)
    strategy_params: dict[str, Any] = Field(default_factory=dict)
    proposed_by: str = Field(default="research-agent", min_length=1, max_length=120)


class ResearchHypothesisTrialContract(BaseModel):
    strategy_type: StrategyType
    strategy_params: dict[str, Any]
    execution_config: dict[str, Any]
    random_seed: int


class ResearchHypothesisAttemptResult(BaseModel):
    hypothesis_attempt_id: str
    campaign_id: str
    fingerprint: str
    near_duplicate_key: Optional[str] = None
    status: ResearchHypothesisAttemptStatus
    proposal: ResearchHypothesisProposal
    compiled_trial: Optional[ResearchHypothesisTrialContract] = None
    rejection_reasons: List[str] = Field(default_factory=list)
    duplicate_of_attempt_id: Optional[str] = None
    trial_id: Optional[str] = None
    created_at: datetime


class ResearchHypothesisExecuteRequest(BaseModel):
    actor: str = Field(default="local-user", min_length=1, max_length=120)


class ResearchMetricSnapshot(BaseModel):
    total_pnl: float = Field(allow_inf_nan=False)
    max_drawdown: float = Field(ge=0, allow_inf_nan=False)
    total_trades: int = Field(ge=0)
    profit_factor: float = Field(ge=0, allow_inf_nan=False)


class ResearchCostStressResult(BaseModel):
    cost_multiplier: Literal[1.0, 1.5, 2.0]
    metrics: ResearchMetricSnapshot


class ResearchWalkForwardFoldEvidence(BaseModel):
    fold_index: int = Field(ge=1)
    train_start: datetime
    train_end: datetime
    test_start: datetime
    test_end: datetime
    regime: str = Field(default="unspecified", min_length=1, max_length=80)
    cost_stresses: List[ResearchCostStressResult] = Field(min_length=3, max_length=3)

    @model_validator(mode="after")
    def _require_all_cost_stresses(self) -> "ResearchWalkForwardFoldEvidence":
        multipliers = sorted(item.cost_multiplier for item in self.cost_stresses)
        if multipliers != [1.0, 1.5, 2.0]:
            raise ValueError("each fold must include exactly one base, 1.5x, and 2x cost result.")
        return self


class ResearchNeighborEvidence(BaseModel):
    strategy_params: dict[str, Any]
    validation_total_pnl: float = Field(allow_inf_nan=False)


class ResearchConcentrationEvidence(BaseModel):
    symbol: str = Field(min_length=1, max_length=32)
    interval: str = Field(min_length=1, max_length=16)
    total_pnl: float = Field(allow_inf_nan=False)
    total_trades: int = Field(ge=0)


class ResearchValidationRequest(BaseModel):
    walk_forward_mode: Literal["rolling", "expanding"] = "expanding"
    folds: List[ResearchWalkForwardFoldEvidence] = Field(min_length=2, max_length=12)
    neighbors: List[ResearchNeighborEvidence] = Field(default_factory=list, max_length=50)
    concentration_slices: List[ResearchConcentrationEvidence] = Field(default_factory=list, max_length=50)
    min_trades_per_fold: int = Field(default=5, ge=1, le=10_000)
    min_fold_coverage: float = Field(default=0.67, gt=0, le=1, allow_inf_nan=False)
    max_allowed_drawdown: float = Field(default=0.10, gt=0, le=1, allow_inf_nan=False)
    parameter_cliff_threshold: float = Field(default=0.50, gt=0, le=1, allow_inf_nan=False)
    campaign_trial_count: int = Field(default=1, ge=1)
    actor: str = Field(default="local-user", min_length=1, max_length=120)


class ResearchValidationResult(BaseModel):
    evaluation_id: str
    campaign_id: str
    trial_id: str
    outcome: ResearchValidationOutcome
    robustness_score: float = Field(ge=0, le=100)
    score_components: dict[str, float]
    gates: dict[str, bool]
    rejection_reasons: List[str] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)
    diagnostics: dict[str, Any]
    evidence: ResearchValidationRequest
    created_at: datetime


class ResearchFinalistFreezeRequest(BaseModel):
    actor: str = Field(default="local-user", min_length=1, max_length=120)


class ResearchFinalistResult(BaseModel):
    campaign_id: str
    trial_id: str
    evaluation_id: str
    frozen_validation_score: float = Field(ge=0, le=100)
    holdout_status: ResearchHoldoutStatus
    holdout_result: Optional[dict[str, Any]] = None
    frozen_by: str
    frozen_at: datetime
    holdout_evaluated_at: Optional[datetime] = None


class ResearchCandidatePromotionRequest(BaseModel):
    promotion_reason: str = Field(min_length=1, max_length=1000)
    actor: str = Field(default="local-user", min_length=1, max_length=120)


class ResearchCandidatePromotionResult(BaseModel):
    research_candidate_id: str
    campaign_id: str
    trial_id: str
    evaluation_id: str
    validation_score: float = Field(ge=0, le=100)
    promotion_reason: str
    promoted_by: str
    promoted_at: datetime


class ResearchHoldoutEvaluationRequest(BaseModel):
    cost_stresses: List[ResearchCostStressResult] = Field(min_length=3, max_length=3)
    actor: str = Field(default="local-user", min_length=1, max_length=120)

    @model_validator(mode="after")
    def _require_all_cost_stresses(self) -> "ResearchHoldoutEvaluationRequest":
        multipliers = sorted(item.cost_multiplier for item in self.cost_stresses)
        if multipliers != [1.0, 1.5, 2.0]:
            raise ValueError("holdout evaluation requires exactly one base, 1.5x, and 2x cost result.")
        return self


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
    active_orders: List[dict[str, Any]] = Field(default_factory=list)
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
    stop_price: Optional[float] = Field(default=None, gt=0)
    target_price: Optional[float] = Field(default=None, gt=0)
    quantity: Optional[float] = Field(default=None, gt=0)
    filled_at: Optional[str] = None
    actor: str = Field(default="local-user")
    note: Optional[str] = None


class PaperRunnerStartRequest(BaseModel):
    actor: str = Field(default="local-user")
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    poll_interval_ms: int = Field(default=750, ge=100, le=60_000)
    reset_cursor: bool = False
    policy_mode: Optional[PaperPolicyMode] = None


class PaperRunnerPauseRequest(BaseModel):
    actor: str = Field(default="local-user")
    summary: Optional[str] = None


class PaperKillSwitchRequest(BaseModel):
    engaged: bool
    actor: str = Field(default="local-user")
    reason: Optional[str] = None


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
    runner_health: str = "idle"
    runner_bars_processed: int = 0
    runner_last_candle_time: Optional[str] = None
    runner_last_action: Optional[str] = None
    runner_parity_passed: Optional[bool] = None
    runner_last_error: Optional[str] = None
    last_event_at: Optional[str] = None
    last_bar_time: Optional[str] = None
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
    execution_mode: Literal["bar", "synthetic_quotes"] = Field(default="bar")
    spread_ticks: int = Field(default=1, ge=1)
    volatile_bar_threshold_ticks: int = Field(default=0, ge=0)
    volatile_bar_extra_ticks: int = Field(default=0, ge=0)


class BacktestRunConfig(BaseModel):
    initial_balance: float = Field(default=100_000, gt=0)
    position_size: float = Field(default=1.0, gt=0)
    commission: float = Field(default=5.0, ge=0)
    tick_size: float = Field(default=0.25, gt=0)
    tick_value: float = Field(default=12.5, gt=0)
    slippage_ticks: float = Field(default=1.0, ge=0)
    stop_loss_ticks: Optional[float] = Field(default=None, gt=0)
    take_profit_ticks: Optional[float] = Field(default=None, gt=0)
    execution_mode: Literal["bar", "synthetic_quotes"] = Field(default="bar")
    spread_ticks: int = Field(default=1, ge=1)
    volatile_bar_threshold_ticks: int = Field(default=0, ge=0)
    volatile_bar_extra_ticks: int = Field(default=0, ge=0)

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
