import type { UTCTimestamp } from "lightweight-charts";
import type { Interval, StrategyValue } from "../constants";
import { getBackendInterval } from "../constants";
/*Base API path for backend requests.

  If the backend route changes later (for example /v1/api),
  we only need to update it in one place.*/
const BASE = "/api";

/*Centralized API routes.

  Prevent repeating strings across
  codebase and reduce typos.*/

const API_ROUTES = {
  dbSymbols: "/data/db/symbols", //TimescaleDB replacing parquet
  dbCandles: (symbol: string) => `/data/db/${symbol}/candles`,
  dbInfo: (symbol: string) => `/data/db/${symbol}/info`,
  yfinanceCandles: "/data/yfinance/candles",
  symbols: "/data/symbols",
  loadSymbol: "/data/load-symbol",
  backtests: "/backtests",
  experiments: "/experiments",
  candidates: "/candidates",
  replaySessions: "/replay-sessions",
  paperSessions: "/paper-sessions",
  paperSessionRunnerStart: (paperSessionId: string) => `/paper-sessions/${paperSessionId}/runner/start`,
  paperSessionRunnerPause: (paperSessionId: string) => `/paper-sessions/${paperSessionId}/runner/pause`,
  paperSessionRunnerStep: (paperSessionId: string) => `/paper-sessions/${paperSessionId}/runner/step`,
  propFirms: "/prop-firms",
} as const;

/*
  Generic API helper.

  This wraps the native fetch API so we don't repeat
  error handling and JSON parsing in every function.
*/
async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${url}`, options);
  // Throw an error if the request failed
  if (!response.ok) {
    let detail: string | undefined;

    try {
      const payload = await response.json();
      if (typeof payload?.detail === "string" && payload.detail.trim()) {
        detail = payload.detail;
      }
    } catch {
      // Some failures don't come back as JSON. That's okay.
    }

    throw new Error(detail ?? `API request failed (${response.status}) for ${url}`);
  }

  return response.json();
}

//Types, w.r.t. Pydantic schemas

// Candlestick data used by chart compoent 
export interface Candle {
  time: UTCTimestamp; 
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

//Metadata for an uploaded/loaded dataset.
export interface DatasetInfo {
  dataset_id: string;
  name: string;
  rows: number; 
  columns: string[];
  start_date: string;
  end_date: string;
  uploaded_at: string;
  tick_size?: number | null;
  tick_value?: number | null;
}

//Metadata returned by GET /api/data/db/symbols for a single futures contract
export interface DbSymbolInfo {
  symbol: string;
  start_date: string;
  end_date: string;
  rows: number;
}

//Metadata for a single symbol available for loading from external sources (yfinance, Databento parquet)
export interface SymbolInfo {
  symbol: string;
  full_name: string;
  exchange: string;
  tick_size: number;
  tick_value: number;
  rows: number;
  start_date: string;
  end_date: string;
}

export interface LoadSymbolRequest {
  symbol: string;
  interval: string;
  start_date?: string;
  end_date?: string;
}

//A single trade produced by a backtest.
export interface Trade {
  trade_id: number;
  entry_time: string;
  exit_time: string;
  side: "buy" | "sell";
  entry_price: number;
  exit_price: number;
  pnl: number;
  status: string;
  commission: number;
  tick_size?: number | null;
  tick_value?: number | null;
  slippage_ticks?: number | null;
}

//Performance statistics calculated from trades.
export interface PerformanceMetrics {
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  win_rate: number;
  total_pnl: number;
  average_pnl: number;
  profit_factor: number;
  max_drawdown: number;
  sharpe_ratio: number;
  sortino_ratio: number;
  avg_trade_duration: number;
  best_trade: number;
  worst_trade: number;
}

//Evaluation of the strategy against prop firm rules.
export interface PropFirmEvaluation {
  passed: boolean;
  daily_loss_breached: boolean;
  drawdown_breached: boolean;
  profit_target_hit: boolean;
  consistency_passed: boolean;
  min_trading_days_passed?: boolean;
  details: Record<string, unknown>;
}

export interface PropFirmRules {
  name: string;
  account_size: number;
  daily_loss_limit: number | null;
  max_drawdown: number;
  profit_target: number;
  consistency_rule: boolean;
  consistency_threshold: number | null;
  drawdown_type: "intraday" | "eod";
  min_trading_days: number | null;
}

export interface BacktestCreateRequest {
  dataset_id: string;
  strategy: { type: StrategyValue; params: Record<string, number> };
  prop_firm_rules: PropFirmRules;
  start_date?: string;
  end_date?: string;
  initial_balance: number;
  position_size: number;
  commission: number;
  tick_size: number;
  tick_value: number;
  slippage_ticks: number;
  stop_loss_ticks?: number;
  take_profit_ticks?: number;
  execution_mode?: "bar" | "synthetic_quotes";
  spread_ticks?: number;
  volatile_bar_threshold_ticks?: number;
  volatile_bar_extra_ticks?: number;
}

//Full backtest result returned by the backend.
export interface BacktestResult {
  backtest_id: string;
  dataset_id: string;
  symbol: string;
  replay_context?: {
    source: string;
    symbol?: string;
    interval?: string;
    start_date?: string;
    end_date?: string;
  } | null;
  strategy: { type: string; params: Record<string, unknown> };
  prop_firm_rules: PropFirmRules;
  run_config: {
    initial_balance: number;
    position_size: number;
    commission: number;
    tick_size: number;
    tick_value: number;
    slippage_ticks: number;
    stop_loss_ticks?: number | null;
    take_profit_ticks?: number | null;
    execution_mode: "bar" | "synthetic_quotes";
    spread_ticks: number;
    volatile_bar_threshold_ticks: number;
    volatile_bar_extra_ticks: number;
  };
  status: string;
  created_at: string;
  trades: Trade[];
  metrics: PerformanceMetrics;
  prop_firm_eval: PropFirmEvaluation;
  equity_curve: number[];
}

/*Lightweight summary used for displaying a list
  of backtests in the UI.*/
export interface BacktestSummary {
  backtest_id: string;
  dataset_id: string;
  symbol: string;
  replay_context?: {
    source: string;
    symbol?: string;
    interval?: string;
    start_date?: string;
    end_date?: string;
  } | null;
  strategy_type: string;
  status: string;
  total_pnl: number;
  win_rate: number;
  created_at: string;
}

export interface BacktestMetrics {
  total_pnl: number;
  win_rate: number;
  max_drawdown: number;
  sharpe_ratio: number;
  profit_factor: number;
  total_trades?: number;
  best_trade?: number;
  worst_trade?: number;
}

export interface BacktestCompare {
  backtest_a: {
    backtest_id: string;
    symbol: string;
    replay_context?: {
      source: string;
      symbol?: string;
      interval?: string;
      start_date?: string;
      end_date?: string;
    } | null;
    strategy: { type: string; params: Record<string, unknown> };
    created_at: string;
    metrics: BacktestMetrics;
  };
  backtest_b: {
    backtest_id: string;
    symbol: string;
    replay_context?: {
      source: string;
      symbol?: string;
      interval?: string;
      start_date?: string;
      end_date?: string;
    } | null;
    strategy: { type: string; params: Record<string, unknown> };
    created_at: string;
    metrics: BacktestMetrics;
  };
}

export interface RobustnessDistribution {
  p05: number;
  median: number;
  p95: number;
  worst: number;
  best: number;
}

export interface RobustnessMonteCarloScenario {
  key: string;
  label: string;
  simulations: number;
  total_pnl: RobustnessDistribution;
  max_drawdown: RobustnessDistribution;
  profitable_rate: number;
  worse_than_base_drawdown_rate: number;
  note: string;
}

export interface RobustnessSweepRun {
  rank: number;
  params: Record<string, unknown>;
  score: number;
  total_pnl: number;
  max_drawdown: number;
  profit_factor: number;
  passed: boolean;
}

export interface RobustnessParameterSweep {
  ranking_rule: string;
  total_runs: number;
  profitable_rate: number;
  passing_rate: number;
  baseline_rank?: number | null;
  median_score: number;
  median_total_pnl: number;
  top_runs: RobustnessSweepRun[];
  bottom_run?: RobustnessSweepRun | null;
  note: string;
}

export interface RobustnessWalkForwardFold {
  fold_index: number;
  train_start: string;
  train_end: string;
  test_start: string;
  test_end: string;
  selected_params: Record<string, unknown>;
  train_score: number;
  test_score: number;
  test_total_pnl: number;
  test_max_drawdown: number;
  test_passed: boolean;
  test_trades: number;
}

export interface BacktestRobustnessResult {
  backtest_id: string;
  symbol?: string | null;
  strategy_type: string;
  run_config: {
    initial_balance: number;
    position_size: number;
    commission: number;
    tick_size: number;
    tick_value: number;
    slippage_ticks: number;
    stop_loss_ticks?: number | null;
    take_profit_ticks?: number | null;
    execution_mode: "bar" | "synthetic_quotes";
    spread_ticks: number;
    volatile_bar_threshold_ticks: number;
    volatile_bar_extra_ticks: number;
  };
  baseline: {
    total_pnl: number;
    max_drawdown: number;
    profit_factor: number;
    win_rate: number;
    total_trades: number;
    passed: boolean;
  };
  monte_carlo: RobustnessMonteCarloScenario[];
  parameter_sweep: RobustnessParameterSweep;
  walk_forward: {
    ranking_rule: string;
    folds_requested: number;
    folds_completed: number;
    profitable_rate: number;
    passing_rate: number;
    total_test_pnl: number;
    average_test_score: number;
    average_test_pnl: number;
    folds: RobustnessWalkForwardFold[];
    note: string;
  };
  warnings: string[];
}

export interface PropFirmPreset {
  key: string;
  name: string;
  account_size: number;
  daily_loss_limit: number | null;
  max_drawdown: number;
  profit_target: number;
  consistency_rule: boolean;
  consistency_threshold: number | null;
  drawdown_type: "intraday" | "eod";
  min_trading_days: number | null;
}

export type ExperimentScoringRule =
  | "prop_score_v1"
  | "total_pnl"
  | "sharpe_ratio"
  | "profit_factor";

export type ExperimentStatus = "draft" | "running" | "completed" | "failed";

export type ExperimentRunStatus = "completed" | "failed";
export type CandidateLifecycleStatus =
  | "candidate"
  | "approved"
  | "paper_ready"
  | "paper_running"
  | "paper_paused"
  | "rejected";
export type PaperBotStatus = "draft" | "ready" | "paper_running" | "stopped";
export type PaperSessionStatus =
  | "draft"
  | "ready"
  | "running"
  | "paused"
  | "stopped"
  | "failed";
export type PaperSessionTradeAction =
  | "buy"
  | "sell"
  | "mark"
  | "exit"
  | "lift_ask"
  | "hit_bid"
  | "join_bid"
  | "join_ask"
  | "rest_exit"
  | "attach_bracket"
  | "replace"
  | "cancel"
  | "flatten";

export interface ExperimentCreateRequest {
  name: string;
  symbols: string[];
  intervals: string[];
  strategy_type: StrategyValue;
  parameter_space: Record<string, unknown[]>;
  start_date?: string;
  end_date?: string;
  prop_firm_rules: PropFirmRules;
  initial_balance: number;
  position_size: number;
  commission: number;
  slippage_ticks: number;
  execution_mode: "bar" | "synthetic_quotes";
  spread_ticks: number;
  volatile_bar_threshold_ticks: number;
  volatile_bar_extra_ticks: number;
  scoring_rule: ExperimentScoringRule;
}

export interface ExperimentResult extends ExperimentCreateRequest {
  experiment_id: string;
  status: ExperimentStatus;
  total_runs: number;
  completed_runs: number;
  failed_runs: number;
  best_run_id?: string | null;
  best_backtest_id?: string | null;
  last_run_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExperimentRunResult {
  experiment_run_id: string;
  experiment_id: string;
  candidate_id?: string | null;
  backtest_id?: string | null;
  symbol: string;
  interval: string;
  strategy_type: StrategyValue;
  strategy_params: Record<string, unknown>;
  dataset_id?: string | null;
  status: ExperimentRunStatus;
  score?: number | null;
  rank?: number | null;
  total_pnl?: number | null;
  win_rate?: number | null;
  max_drawdown?: number | null;
  profit_factor?: number | null;
  passed?: boolean | null;
  error?: string | null;
  metrics?: PerformanceMetrics | null;
  prop_firm_eval?: PropFirmEvaluation | null;
  is_candidate: boolean;
  promoted_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExperimentExecutionResult {
  experiment: ExperimentResult;
  results: ExperimentRunResult[];
}

export interface CandidateNote {
  note_id: string;
  body: string;
  author: string;
  created_at: string;
}

export interface CandidateAuditEvent {
  event_id: string;
  event_type: string;
  actor: string;
  summary: string;
  changes: Record<string, unknown>;
  created_at: string;
}

export interface PaperBotConfig {
  paper_bot_id: string;
  candidate_id: string;
  symbol: string;
  interval: string;
  strategy_type: StrategyValue;
  strategy_params: Record<string, unknown>;
  guardrails: Record<string, unknown>;
  status: PaperBotStatus;
  paper_session_id?: string | null;
  last_event_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaperSessionResult {
  paper_session_id: string;
  candidate_id: string;
  paper_bot_id?: string | null;
  name: string;
  symbol: string;
  interval: string;
  strategy_type: StrategyValue;
  strategy_params: Record<string, unknown>;
  prop_firm_rules: PropFirmRules;
  guardrails: Record<string, unknown>;
  status: PaperSessionStatus;
  commission: number;
  tick_value: number;
  tick_size?: number;
  spread_ticks?: number;
  volatile_bar_threshold_ticks?: number;
  volatile_bar_extra_ticks?: number;
  resting_fill_mode?: "touch" | "penetrate" | "touch_plus_1_bar";
  current_position: Record<string, unknown>;
  active_order: Record<string, unknown>;
  active_orders: Record<string, unknown>[];
  last_quote: Record<string, unknown>;
  trade_log: Trade[];
  equity_curve: number[];
  metrics_snapshot: Record<string, unknown>;
  guardrail_state: Record<string, unknown>;
  runner_state: Record<string, unknown>;
  last_bar_time?: string | null;
  last_event_at?: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface PaperSessionSummary {
  paper_session_id: string;
  candidate_id: string;
  name: string;
  symbol: string;
  interval: string;
  status: PaperSessionStatus;
  runner_health: string;
  runner_bars_processed: number;
  runner_last_candle_time?: string | null;
  runner_last_action?: string | null;
  runner_parity_passed?: boolean | null;
  runner_last_error?: string | null;
  last_event_at?: string | null;
  last_bar_time?: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaperEventResult {
  paper_event_id: string;
  paper_session_id: string;
  candidate_id: string;
  event_type: string;
  actor: string;
  summary: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface CandidateResult {
  candidate_id: string;
  experiment_id: string;
  experiment_name: string;
  experiment_run_id: string;
  backtest_id: string;
  symbol: string;
  interval: string;
  strategy_type: StrategyValue;
  strategy_params: Record<string, unknown>;
  prop_firm_rules: PropFirmRules;
  experiment_snapshot: {
    name: string;
    symbols: string[];
    intervals: string[];
    start_date?: string | null;
    end_date?: string | null;
    scoring_rule?: string | null;
    status?: string | null;
    created_at?: string | null;
    last_run_at?: string | null;
  };
  score?: number | null;
  rank?: number | null;
  total_pnl?: number | null;
  win_rate?: number | null;
  max_drawdown?: number | null;
  profit_factor?: number | null;
  passed?: boolean | null;
  metrics?: PerformanceMetrics | null;
  prop_firm_eval?: PropFirmEvaluation | null;
  lifecycle_status: CandidateLifecycleStatus;
  promotion_reason: string;
  promoted_by: string;
  promoted_at: string;
  approved_by?: string | null;
  approved_at?: string | null;
  paper_bot?: PaperBotConfig | null;
  notes: CandidateNote[];
  audit_log: CandidateAuditEvent[];
  created_at: string;
  updated_at: string;
}

export interface ReplaySessionAction {
  id: string;
  bar_index: number;
  type:
    | "buy"
    | "sell"
    | "exit"
    | "lift_ask"
    | "hit_bid"
    | "join_bid"
    | "join_ask"
    | "rest_exit"
    | "attach_bracket"
    | "replace"
    | "cancel"
    | "flatten";
  created_at: number;
  price?: number;
  stop_price?: number;
  target_price?: number;
}

export interface ReplaySessionSourceBacktest {
  backtest_id: string;
  symbol?: string;
  interval?: string;
  start_date?: string;
  end_date?: string;
  strategy_type?: string;
}

export interface ReplaySessionPayload {
  name: string;
  symbol: string;
  interval: string;
  start_date?: string;
  end_date?: string;
  source_backtest?: ReplaySessionSourceBacktest | null;
  prop_firm_rules: PropFirmRules;
  commission: number;
  tick_value: number;
  tick_size?: number;
  spread_ticks?: number;
  volatile_bar_threshold_ticks?: number;
  volatile_bar_extra_ticks?: number;
  resting_fill_mode?: "touch" | "penetrate" | "touch_plus_1_bar";
  current_bar_index: number;
  status: string;
  actions: ReplaySessionAction[];
  active_order?: Record<string, unknown> | null;
  active_orders?: Record<string, unknown>[];
  execution_events?: Record<string, unknown>[];
  trades: Trade[];
  metrics: PerformanceMetrics;
  prop_firm_eval: PropFirmEvaluation;
  equity_curve: number[];
}

export interface ReplaySessionResult extends ReplaySessionPayload {
  replay_session_id: string;
  created_at: string;
  updated_at: string;
}

export interface ReplaySessionSummary {
  replay_session_id: string;
  name: string;
  symbol: string;
  interval: string;
  start_date?: string;
  end_date?: string;
  source_backtest?: ReplaySessionSourceBacktest | null;
  status: string;
  current_bar_index: number;
  total_pnl: number;
  total_trades: number;
  created_at: string;
  updated_at: string;
}


// Fetch helpers
/* Fetch futures symbols from TimescaleDB.
* GET /api/data/db/symbols returns metadata for every symbol migrated from Databento parquet
*/
export const fetchDbSymbols = async (): Promise<DbSymbolInfo[]> => {
  return api<DbSymbolInfo[]>(API_ROUTES.dbSymbols);
}
/* Fetch candlestick bars from TimescaleDB using time_bucket() aggregation 
* Replaces old parquet flow POST /data/paruqet/load -> GET /data/{dataset_id}/candles

Example: fetchCandles({ symbol: "NQ", interval: "15min", limit: 750 })
*/
export const fetchCandles = async ({
  symbol,
  interval = "1h",
  limit = 750,
  startDate,
  endDate,
}: {
  symbol: string;
  interval?: string;
  limit?: number;
  startDate?: string;
  endDate?: string;
}): Promise<Candle[]> => {
  // Date-bounded requests must bypass the cache
  const params = new URLSearchParams({interval, limit: String(limit)});
  if(startDate){
    params.set("start_date", startDate);
  }
  if(endDate){
    params.set("end_date", endDate);
  }
  return api<Candle[]>(`${API_ROUTES.dbCandles(symbol)}?${params}`);
};

export const fetchYfinanceCandles = async (
  symbol: string,
  interval: string,
  period: string,
): Promise<Candle[]> => {
  const params = new URLSearchParams({ symbol, interval, period });
  return api<Candle[]>(`${API_ROUTES.yfinanceCandles}?${params}`);
};

// Fetch replay candles for a backtest. The backend decides whether to
// rebuild them from persisted replay context or fall back to an in-memory
// dataset if the backtest predates durable replay metadata.
export const fetchBacktestCandles = async (
  backtestId: string,
  limit?: number,
): Promise<Candle[]> => {
  const params = new URLSearchParams();
  if (limit) params.set("limit", String(limit));
  const suffix = params.toString() ? `?${params}` : "";
  return api<Candle[]>(`/backtests/${backtestId}/candles${suffix}`);
};

// Fetch metadata (row coubt, date range) for a single DB symbol using
// GET /api/data/db/{symbol}/info
export const fetchDbSymbolInfo = async (symbol: string): Promise<DbSymbolInfo> => {
  return api<DbSymbolInfo>(API_ROUTES.dbInfo(symbol));
}
//Fetch list of previous backtests
export const fetchBacktests = async (): Promise<BacktestSummary[]> => {
  return api<BacktestSummary[]>(API_ROUTES.backtests);
};

export const fetchExperiments = async (): Promise<ExperimentResult[]> => {
  return api<ExperimentResult[]>(API_ROUTES.experiments);
};

export const fetchCandidates = async (): Promise<CandidateResult[]> => {
  return api<CandidateResult[]>(API_ROUTES.candidates);
};

export const fetchCandidate = async (id: string): Promise<CandidateResult> => {
  return api<CandidateResult>(`${API_ROUTES.candidates}/${id}`);
};

export const fetchExperiment = async (id: string): Promise<ExperimentResult> => {
  return api<ExperimentResult>(`${API_ROUTES.experiments}/${id}`);
};

export const fetchExperimentResults = async (id: string): Promise<ExperimentRunResult[]> => {
  return api<ExperimentRunResult[]>(`${API_ROUTES.experiments}/${id}/results`);
};

export const createExperiment = async (
  payload: ExperimentCreateRequest,
): Promise<ExperimentResult> => {
  return api<ExperimentResult>(API_ROUTES.experiments, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
};

export const runExperiment = async (id: string): Promise<ExperimentExecutionResult> => {
  return api<ExperimentExecutionResult>(`${API_ROUTES.experiments}/${id}/run`, {
    method: "POST",
  });
};

export const promoteExperimentRun = async (
  experimentId: string,
  experimentRunId: string,
): Promise<ExperimentRunResult> => {
  return api<ExperimentRunResult>(
    `${API_ROUTES.experiments}/${experimentId}/runs/${experimentRunId}/promote`,
    {
      method: "POST",
    },
  );
};

export const demoteExperimentRun = async (
  experimentId: string,
  experimentRunId: string,
): Promise<ExperimentRunResult> => {
  return api<ExperimentRunResult>(
    `${API_ROUTES.experiments}/${experimentId}/runs/${experimentRunId}/promote`,
    {
      method: "DELETE",
    },
  );
};

export const updateCandidateStatus = async (
  candidateId: string,
  status: CandidateLifecycleStatus,
  actor = "local-user",
): Promise<CandidateResult> => {
  return api<CandidateResult>(`${API_ROUTES.candidates}/${candidateId}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, actor }),
  });
};

export const addCandidateNote = async (
  candidateId: string,
  body: string,
  author = "local-user",
): Promise<CandidateResult> => {
  return api<CandidateResult>(`${API_ROUTES.candidates}/${candidateId}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body, author }),
  });
};

export const createCandidatePaperBot = async (
  candidateId: string,
  actor = "local-user",
): Promise<CandidateResult> => {
  return api<CandidateResult>(`${API_ROUTES.candidates}/${candidateId}/paper-bot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actor }),
  });
};

export const updateCandidatePaperBotStatus = async (
  candidateId: string,
  status: PaperBotStatus,
  actor = "local-user",
): Promise<CandidateResult> => {
  return api<CandidateResult>(`${API_ROUTES.candidates}/${candidateId}/paper-bot/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, actor }),
  });
};

export const createCandidatePaperSession = async (
  candidateId: string,
  options: { actor?: string; name?: string } = {},
): Promise<PaperSessionResult> => {
  return api<PaperSessionResult>(`${API_ROUTES.candidates}/${candidateId}/paper-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actor: options.actor ?? "local-user",
      name: options.name,
    }),
  });
};

export const fetchCandidatePaperSession = async (
  candidateId: string,
): Promise<PaperSessionResult> => {
  return api<PaperSessionResult>(`${API_ROUTES.candidates}/${candidateId}/paper-session`);
};

export const fetchPaperSessions = async (): Promise<PaperSessionSummary[]> => {
  return api<PaperSessionSummary[]>(API_ROUTES.paperSessions);
};

export const fetchPaperSession = async (paperSessionId: string): Promise<PaperSessionResult> => {
  return api<PaperSessionResult>(`${API_ROUTES.paperSessions}/${paperSessionId}`);
};

export const fetchPaperSessionEvents = async (
  paperSessionId: string,
): Promise<PaperEventResult[]> => {
  return api<PaperEventResult[]>(`${API_ROUTES.paperSessions}/${paperSessionId}/events`);
};

export const updatePaperSessionStatus = async (
  paperSessionId: string,
  status: PaperSessionStatus,
  options: { actor?: string; summary?: string } = {},
): Promise<PaperSessionResult> => {
  return api<PaperSessionResult>(`${API_ROUTES.paperSessions}/${paperSessionId}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status,
      actor: options.actor ?? "local-user",
      summary: options.summary,
    }),
  });
};

export const createPaperSessionEvent = async (
  paperSessionId: string,
  payload: {
    eventType: string;
    summary: string;
    actor?: string;
    payload?: Record<string, unknown>;
  },
): Promise<PaperEventResult> => {
  return api<PaperEventResult>(`${API_ROUTES.paperSessions}/${paperSessionId}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_type: payload.eventType,
      summary: payload.summary,
      actor: payload.actor ?? "local-user",
      payload: payload.payload ?? {},
    }),
  });
};

export const executePaperSessionAction = async (
  paperSessionId: string,
  payload: {
    action: PaperSessionTradeAction;
    price?: number;
    stopPrice?: number;
    targetPrice?: number;
    filledAt?: string;
    actor?: string;
    note?: string;
  },
): Promise<PaperSessionResult> => {
  return api<PaperSessionResult>(`${API_ROUTES.paperSessions}/${paperSessionId}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: payload.action,
      price: payload.price,
      stop_price: payload.stopPrice,
      target_price: payload.targetPrice,
      filled_at: payload.filledAt,
      actor: payload.actor ?? "local-user",
      note: payload.note,
    }),
  });
};

export const startPaperSessionRunner = async (
  paperSessionId: string,
  payload: {
    actor?: string;
    startDate?: string;
    endDate?: string;
    pollIntervalMs?: number;
    resetCursor?: boolean;
  } = {},
): Promise<PaperSessionResult> => {
  return api<PaperSessionResult>(API_ROUTES.paperSessionRunnerStart(paperSessionId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actor: payload.actor ?? "local-user",
      start_date: payload.startDate,
      end_date: payload.endDate,
      poll_interval_ms: payload.pollIntervalMs,
      reset_cursor: payload.resetCursor ?? false,
    }),
  });
};

export const pausePaperSessionRunner = async (
  paperSessionId: string,
  payload: {
    actor?: string;
    summary?: string;
  } = {},
): Promise<PaperSessionResult> => {
  return api<PaperSessionResult>(API_ROUTES.paperSessionRunnerPause(paperSessionId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actor: payload.actor ?? "local-user",
      summary: payload.summary,
    }),
  });
};

export const stepPaperSessionRunner = async (
  paperSessionId: string,
  payload: {
    actor?: string;
    steps?: number;
  } = {},
): Promise<PaperSessionResult> => {
  return api<PaperSessionResult>(API_ROUTES.paperSessionRunnerStep(paperSessionId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actor: payload.actor ?? "local-user",
      steps: payload.steps ?? 1,
    }),
  });
};

export const fetchReplaySessions = async (): Promise<ReplaySessionSummary[]> => {
  return api<ReplaySessionSummary[]>(API_ROUTES.replaySessions);
};

export const fetchReplaySession = async (id: string): Promise<ReplaySessionResult> => {
  return api<ReplaySessionResult>(`${API_ROUTES.replaySessions}/${id}`);
};

export const createReplaySession = async (
  payload: ReplaySessionPayload,
): Promise<ReplaySessionResult> => {
  return api<ReplaySessionResult>(API_ROUTES.replaySessions, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
};

export const updateReplaySession = async (
  id: string,
  payload: ReplaySessionPayload,
): Promise<ReplaySessionResult> => {
  return api<ReplaySessionResult>(`${API_ROUTES.replaySessions}/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
};

//Fetch detailed results for a specific backtest.
export const fetchBacktest = async (id: string): Promise<BacktestResult> => {
  return api<BacktestResult>(`${API_ROUTES.backtests}/${id}`);
};

export const fetchBacktestRobustness = async (
  id: string,
): Promise<BacktestRobustnessResult> => {
  return api<BacktestRobustnessResult>(`${API_ROUTES.backtests}/${id}/robustness`);
};

//Run a new backtest with a strategy configuration.
export const runBacktest = async (payload: BacktestCreateRequest): Promise<BacktestResult> => {
  return api<BacktestResult>(API_ROUTES.backtests, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(payload),
  });
};

export const compareBacktests = async (
  a: string,
  b: string
): Promise<BacktestCompare> => {
  const params = new URLSearchParams({ a, b });
  return api<BacktestCompare>(`${API_ROUTES.backtests}/compare?${params}`);
};

//Fetch prop firm rule presets.
export const fetchPropPresets = async (): Promise<PropFirmPreset[]> => {
  return api<PropFirmPreset[]>(API_ROUTES.propFirms);
};

export const fetchSymbols = async (): Promise<SymbolInfo[]> => {
  return api<SymbolInfo[]>(API_ROUTES.symbols);
};

export const loadSymbol = async (req: LoadSymbolRequest): Promise<DatasetInfo> => {
  return api<DatasetInfo>(API_ROUTES.loadSymbol, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(req),
  });
};

// Accepts Interval object and coverts to correct backend format using getBackendInterval() 
export const loadSymbolWithInterval = async (
  symbol: string,
  interval: Interval,         
  start_date?: string,
  end_date?: string
): Promise<DatasetInfo> => {
  return loadSymbol({
    symbol,
    interval: getBackendInterval(interval),  
    start_date,
    end_date,
  });
};
