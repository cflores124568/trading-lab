import type { UTCTimestamp } from "lightweight-charts";
import type { Interval } from "../constants";
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
  symbol: string;
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
  symbol: string;
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
}

export interface BacktestCompare {
  backtest_a: {
    backtest_id: string;
    symbol: string;
    strategy: { type: string; params: Record<string, unknown> };
    created_at: string;
    metrics: BacktestMetrics;
  };
  backtest_b: {
    backtest_id: string;
    symbol: string;
    strategy: { type: string; params: Record<string, unknown> };
    created_at: string;
    metrics: BacktestMetrics;
  };
}

export interface PropFirmPreset {
  key: string;
  name: string;
  account_size: number;
  daily_loss_limit: number;
  max_drawdown: number;
  profit_target: number;
  consistency_rule: boolean;
  consistency_threshold: number;
  drawdown_type: "intraday" | "eod";
  min_trading_days: number | null;
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

// Fetch candles for a loaded in-memory dataset by its UUID.
// Hits GET /api/data/{dataset_id}/candles — the in-memory store path,
// not the TimescaleDB symbol path. Used by the backtest detail page
// to load chart data for replay without re-fetching by symbol.
export const fetchDatasetCandles = async (
  datasetId: string,
  interval = "1min",
  limit?: number,
): Promise<Candle[]> => {
  const params = new URLSearchParams({ interval });
  if (limit) params.set("limit", String(limit));
  return api<Candle[]>(`/data/${datasetId}/candles?${params}`);
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

