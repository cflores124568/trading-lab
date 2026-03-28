
import type { UTCTimestamp } from "lightweight-charts";
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
  backtests: "/backtests",
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
    throw new Error(`API request failed (${response.status}) for ${url}`);
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
}

//Metadata returned by GET /api/data/db/symbols for a single futures contract
export interface DbSymbolInfo {
  symbol: string;
  start_date: string;
  end_date: string;
  rows: number;
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
  details: Record<string, unknown>;
}

//Full backtest result returned by the backend.
export interface BacktestResult {
  backtest_id: string;
  dataset_id: string;
  strategy: { type: string; params: Record<string, unknown> };
  prop_firm_rules: Record<string, unknown>;
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
  strategy_type: string;
  status: string;
  total_pnl: number;
  win_rate: number;
  created_at: string;
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

// Fetch metadata (row coubt, date range) for a single DB symbol using
// GET /api/data/db/{symbol}/info
export const fetchDbSymbolInfo = async (symbol: string): Promise<DbSymbolInfo> => {
  return api<DbSymbolInfo>(API_ROUTES.dbInfo(symbol));
}
//Fetch list of previous backtests
export const fetchBacktests = async (): Promise<BacktestSummary[]> => {
  return api<BacktestSummary[]>(API_ROUTES.backtests);
};

//Fetch detailed results for a specific backtest.
export const fetchBacktest = async (id: string): Promise<BacktestResult> => {
  return api<BacktestResult>(`${API_ROUTES.backtests}/${id}`);
};

//Run a new backtest with a strategy configuration.
export const runBacktest = async (payload: unknown): Promise<BacktestResult> => {
  return api<BacktestResult>(API_ROUTES.backtests, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(payload),
  });
};

//Fetch prop firm rule presets.
export const fetchPropPresets = async () => {
  return api(API_ROUTES.propFirms);
};
