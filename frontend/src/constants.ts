/*Source of truth for all symbol and interval lists
 *
 * I used 2 distinct symbol tables because the two data sources use
 *  different identifiers:
 *
 *   DATABENTO_SYMBOLS: used by the backtest pipeline.
 *                        Keys match the parquet filenames on disk: (NQ_c_0.parquet)
 *
 *  YFINANCE_SYMBOLS: used only by the live Dashboard chart preview.
 *                        Yahoo Finance tickers (NQ=F) are NOT valid for backtesting
 *
 * Don't mix them. If you add a new instrument, add it to both tables
 * (or just DATABENTO_SYMBOLS if you don't need a live chart for it)
 */


export interface DatabentoSymbol {
  label:  string;
  key: string;   // base symbol 
  continuous: string;   // must follow Databento continuous format: (NQ.c.0)
  parquet: string;   // filename must end in .parquet: (NQ_c_0.parquet)
  tickValue: number;   
  exchange: string;
  note?: string;
}

export const DATABENTO_SYMBOLS: DatabentoSymbol[] = [
  { label: "NQ  · Nasdaq 100", key: "NQ",  continuous: "NQ.c.0",  parquet: "NQ_c_0.parquet", tickValue: 20.00, exchange: "CME"},
  { label: "MNQ · Micro Nasdaq 100", key: "MNQ", continuous: "MNQ.c.0", parquet: "MNQ_c_0.parquet", tickValue:  2.00, exchange: "CME"},
  { label: "ES  · S&P 500", key: "ES",  continuous: "ES.c.0",  parquet: "ES_c_0.parquet", tickValue: 50.00, exchange: "CME"},
  { label: "MES · Micro S&P 500", key: "MES", continuous: "MES.c.0", parquet: "MES_c_0.parquet", tickValue:  5.00, exchange: "CME"},
  { label: "GC  · Gold", key: "GC",  continuous: "GC.c.0",  parquet: "GC_c_0.parquet",  tickValue: 10.00, exchange: "COMEX", note: "There are only 88,130 bars from 2019-01-02 2026-03-19 since GC volume trades on COMEX, not Globex. Ill have to find GC elsewhere"},
  { label: "MGC · Micro Gold", key: "MGC", continuous: "MGC.c.0", parquet: "MGC_c_0.parquet", tickValue:  1.00, exchange: "COMEX" },
];

export const DEFAULT_DATABENTO_SYMBOL = DATABENTO_SYMBOLS[0]; 

//For live chart preview only
export interface YFinanceSymbol {
  label: string;
  key: string;  
  ticker: string;  
}

export const YFINANCE_SYMBOLS: YFinanceSymbol[] = [
  { label: "NQ  · Nasdaq 100", key: "NQ", ticker: "NQ=F" },
  { label: "MNQ · Micro Nasdaq 100", key: "MNQ", ticker: "MNQ=F"},
  { label: "GC  · Gold", key: "GC",  ticker: "GC=F"},
  { label: "MGC · Micro Gold", key: "MGC", ticker: "MGC=F"},
];

export const DEFAULT_YFINANCE_SYMBOL = YFINANCE_SYMBOLS[0];

// Intervals 
// resampleRule: pandas rule passed to data_loader.py resample_ohlcv().
//      null = sessionware groupby required (daily+).
// yfinanceInterval: what yfinance accepts. null = not supported by yfinance.
// maxLiveDays: yfinance history cap. null = N/A (backtest-only interval).

export interface Interval {
  label: string;
  value: string;
  resampleRule: string | null;
  yfinanceInterval: string | null;
  maxLiveDays: number | null;
}

export const INTERVALS: Interval[] = [
  { label: "1 min", value: "1m", resampleRule: "1min", yfinanceInterval: "1m", maxLiveDays: 7 },
  { label: "5 min", value: "5m", resampleRule: "5min", yfinanceInterval: "5m", maxLiveDays: 60 },
  { label: "10 min", value: "10m", resampleRule: "10min", yfinanceInterval: null, maxLiveDays: null },
  { label: "15 min", value: "15m", resampleRule: "15min", yfinanceInterval: "15m", maxLiveDays: 60 },
  { label: "30 min", value: "30m", resampleRule: "30min", yfinanceInterval: "30m", maxLiveDays: 60 },
  { label: "1 hour", value: "1h", resampleRule: "1h", yfinanceInterval: "1h", maxLiveDays: 730  },
  { label: "4 hour", value: "4h", resampleRule: "4h", yfinanceInterval: null, maxLiveDays: null },
  { label: "Daily",  value: "1d", resampleRule: null, yfinanceInterval: "1d", maxLiveDays: null },
  { label: "Weekly", value: "1w", resampleRule: null, yfinanceInterval: "1wk", maxLiveDays: null },
];

// Live chart uses yfinance: only intervals Yahoo Finance supports.
// Backtest uses stored CSV: all intervals are valid via resample_ohlcv().
export const LIVE_CHART_INTERVALS = INTERVALS.filter((i): i is Interval & { yfinanceInterval: string} => i.yfinanceInterval !== null);
export const BACKTEST_INTERVALS = INTERVALS; //Databento supports all intervals 😈

export const DEFAULT_INTERVAL = INTERVALS.find(i => i.value === "15m")!;

// Recent periods for live chart
//Not used for backtesting
export interface Period {
  label: string;
  value: string;
  days:  number;
}

export const PERIODS: Period[] = [
  { label: "7 days", value: "7d",   days:  7 },
  { label: "30 days", value: "30d", days: 30 },
  { label: "60 days", value: "60d", days: 60 },
];

export const DEFAULT_PERIOD = PERIODS[1]; 