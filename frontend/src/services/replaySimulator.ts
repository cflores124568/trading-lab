import type { Candle, PerformanceMetrics, PropFirmEvaluation, PropFirmRules, Trade } from "./api";
import { getMffuDrawdown, mffuSession } from "./mffuDrawdown.ts";
import { mffuContractLimit } from "./mffuContracts.ts";
import { assessMffuEvidence, parseMffuTime } from "./mffuEvidence.ts";
import {
  createBracketExitOrders,
  createRestingOrder,
  DEFAULT_EXECUTION_CONFIG,
  normalizeExecutionAction,
  normalizeRestingFillMode,
  replaceRestingOrder,
  restingOrderPriority,
  restingOrderFillUpdate,
  roundToTick,
  sameBracketGroup,
  syntheticQuoteForCandle,
  type ExecutionConfig,
  type ExecutionEvent,
  type LegacyExecutionActionType,
  type RestingFillMode,
  type RestingOrder,
  type SyntheticQuote,
} from "./executionModel.ts";

export type ReplaySizingMode = "fixed" | "risk_percent";

export type ReplayActionType =
  | LegacyExecutionActionType
  | "lift_ask"
  | "hit_bid"
  | "join_bid"
  | "join_ask"
  | "rest_exit"
  | "attach_bracket"
  | "replace"
  | "cancel"
  | "flatten";

export interface ReplayAction {
  id: string;
  barIndex: number;
  type: ReplayActionType;
  createdAt: number;
  price?: number;
  stopPrice?: number;
  targetPrice?: number;
  orderId?: string;
  bracketRole?: "stop" | "target";
}

export interface ReplayMetrics {
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
  avg_r_multiple: number | null;
  total_r: number | null;
  r_profit_factor: number | null;
  risk_budget_exceeded_trades: number;
  avg_trade_duration: number;
  best_trade: number;
  worst_trade: number;
}

export interface ReplayPassInfo {
  barIndex: number;
  time: string;
  equity: number;
}

export function sanitizeReplayMetrics(metrics: ReplayMetrics): PerformanceMetrics {
  return {
    total_trades: Number.isFinite(metrics.total_trades) ? metrics.total_trades : 0,
    winning_trades: Number.isFinite(metrics.winning_trades) ? metrics.winning_trades : 0,
    losing_trades: Number.isFinite(metrics.losing_trades) ? metrics.losing_trades : 0,
    win_rate: Number.isFinite(metrics.win_rate) ? metrics.win_rate : 0,
    total_pnl: Number.isFinite(metrics.total_pnl) ? metrics.total_pnl : 0,
    average_pnl: Number.isFinite(metrics.average_pnl) ? metrics.average_pnl : 0,
    profit_factor: Number.isFinite(metrics.profit_factor) ? metrics.profit_factor : null,
    max_drawdown: Number.isFinite(metrics.max_drawdown) ? metrics.max_drawdown : 0,
    sharpe_ratio: Number.isFinite(metrics.sharpe_ratio) ? metrics.sharpe_ratio : 0,
    sortino_ratio: Number.isFinite(metrics.sortino_ratio) ? metrics.sortino_ratio : 0,
    avg_r_multiple:
      metrics.avg_r_multiple != null && Number.isFinite(metrics.avg_r_multiple)
        ? metrics.avg_r_multiple
        : null,
    total_r:
      metrics.total_r != null && Number.isFinite(metrics.total_r) ? metrics.total_r : null,
    r_profit_factor:
      metrics.r_profit_factor != null && Number.isFinite(metrics.r_profit_factor)
        ? metrics.r_profit_factor
        : null,
    risk_budget_exceeded_trades: Number.isFinite(metrics.risk_budget_exceeded_trades)
      ? metrics.risk_budget_exceeded_trades
      : 0,
    avg_trade_duration: Number.isFinite(metrics.avg_trade_duration) ? metrics.avg_trade_duration : 0,
    best_trade: Number.isFinite(metrics.best_trade) ? metrics.best_trade : 0,
    worst_trade: Number.isFinite(metrics.worst_trade) ? metrics.worst_trade : 0,
  };
}

export interface ReplayPosition {
  side: "buy" | "sell";
  quantity: number;
  entry_price: number;
  entry_time: string;
  entry_bar_index: number;
  current_price: number;
  current_time: string;
  unrealized_pnl: number;
  initial_risk?: number;
  risk_budget?: number | null;
  risk_exceeded?: boolean;
}

export interface ReplaySession {
  trades: Trade[];
  metrics: ReplayMetrics;
  equityCurve: number[];
  propEvaluation: PropFirmEvaluation;
  firstPass: ReplayPassInfo | null;
  position: ReplayPosition | null;
  activeOrder: RestingOrder | null;
  activeOrders: RestingOrder[];
  currentQuote: SyntheticQuote | null;
  executionEvents: ExecutionEvent[];
  balance: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
}

interface OpenReplayPosition {
  side: "buy" | "sell";
  quantity: number;
  entryPrice: number;
  entryTime: string;
  entryBarIndex: number;
  initialStopPrice?: number;
  initialRisk?: number;
  riskBudget?: number | null;
  riskExceeded: boolean;
}

interface EntrySizing {
  quantity: number;
  initialStopPrice?: number;
  initialRisk?: number;
  riskBudget?: number | null;
  riskExceeded: boolean;
}

function round(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

export function clampReplayIndex(index: number, totalBars: number): number {
  if (totalBars <= 0) return 0;
  return Math.min(Math.max(index, 0), totalBars - 1);
}

export function getReplayProgress(currentIndex: number, totalBars: number): number {
  if (totalBars <= 1) return 0;
  return clampReplayIndex(currentIndex, totalBars) / (totalBars - 1);
}

export function getReplayIndexFromProgress(progress: number, totalBars: number): number {
  if (totalBars <= 1) return 0;
  const clamped = Math.min(Math.max(progress, 0), 1);
  return clampReplayIndex(Math.round(clamped * (totalBars - 1)), totalBars);
}

export function getCandleTime(candle: Candle): string {
  return new Date(candle.time * 1000).toISOString();
}

export function getTradeEntryIndices(candles: Candle[], trades: Trade[]): number[] {
  const candleTimes = candles.map((candle) => Number(candle.time));

  return trades
    .map((trade) => Math.floor(new Date(trade.entry_time).getTime() / 1000))
    .map((entryTime) => findNearestCandleIndex(candleTimes, entryTime))
    .filter((value): value is number => value !== null);
}

export function findJumpTarget(
  currentIndex: number,
  targetIndices: number[],
  direction: "next" | "prev",
): number | null {
  if (direction === "next") {
    return targetIndices.find((index) => index > currentIndex) ?? null;
  }

  for (let i = targetIndices.length - 1; i >= 0; i -= 1) {
    if (targetIndices[i] < currentIndex) {
      return targetIndices[i];
    }
  }

  return null;
}

function findNearestCandleIndex(candleTimes: number[], targetTime: number): number | null {
  if (candleTimes.length === 0) return null;

  let closestIndex = 0;
  let closestDiff = Math.abs(candleTimes[0] - targetTime);

  for (let i = 1; i < candleTimes.length; i += 1) {
    const diff = Math.abs(candleTimes[i] - targetTime);
    if (diff < closestDiff) {
      closestDiff = diff;
      closestIndex = i;
    }
  }

  return closestIndex;
}

function computePnl(
  side: "buy" | "sell",
  entryPrice: number,
  exitPrice: number,
  positionSize: number,
  tickValue: number,
  commission: number,
): number {
  const raw =
    side === "buy"
      ? (exitPrice - entryPrice) * positionSize * tickValue
      : (entryPrice - exitPrice) * positionSize * tickValue;
  return round(raw - commission * positionSize);
}

function emptyMetrics(): ReplayMetrics {
  return {
    total_trades: 0,
    winning_trades: 0,
    losing_trades: 0,
    win_rate: 0,
    total_pnl: 0,
    average_pnl: 0,
    profit_factor: 0,
    max_drawdown: 0,
    sharpe_ratio: 0,
    sortino_ratio: 0,
    avg_r_multiple: null,
    total_r: null,
    r_profit_factor: null,
    risk_budget_exceeded_trades: 0,
    avg_trade_duration: 0,
    best_trade: 0,
    worst_trade: 0,
  };
}

function calculateMetrics(trades: Trade[], equityCurve: number[]): ReplayMetrics {
  if (trades.length === 0) {
    return emptyMetrics();
  }

  const pnls = trades.map((trade) => trade.pnl);
  const totalTrades = trades.length;
  const winningTrades = pnls.filter((pnl) => pnl > 0).length;
  const losingTrades = pnls.filter((pnl) => pnl < 0).length;
  const totalPnl = pnls.reduce((sum, pnl) => sum + pnl, 0);
  const grossWins = pnls.filter((pnl) => pnl > 0).reduce((sum, pnl) => sum + pnl, 0);
  const grossLosses = Math.abs(
    pnls.filter((pnl) => pnl < 0).reduce((sum, pnl) => sum + pnl, 0),
  );
  const rValues = trades
    .map((trade) => trade.r_multiple)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const grossRWins = rValues.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossRLosses = Math.abs(
    rValues.filter((value) => value < 0).reduce((sum, value) => sum + value, 0),
  );

  return {
    total_trades: totalTrades,
    winning_trades: winningTrades,
    losing_trades: losingTrades,
    win_rate: round(winningTrades / totalTrades, 4),
    total_pnl: round(totalPnl),
    average_pnl: round(totalPnl / totalTrades),
    profit_factor: grossLosses === 0 ? Number.POSITIVE_INFINITY : round(grossWins / grossLosses, 4),
    max_drawdown: round(maxDrawdown(equityCurve), 4),
    sharpe_ratio: sharpeRatio(pnls),
    sortino_ratio: sortinoRatio(pnls),
    avg_r_multiple:
      rValues.length === 0
        ? null
        : round(rValues.reduce((sum, value) => sum + value, 0) / rValues.length, 4),
    total_r:
      rValues.length === 0
        ? null
        : round(rValues.reduce((sum, value) => sum + value, 0), 4),
    r_profit_factor:
      rValues.length === 0
        ? null
        : grossRLosses === 0
          ? round(grossRWins, 4)
          : round(grossRWins / grossRLosses, 4),
    risk_budget_exceeded_trades: trades.filter((trade) => trade.risk_exceeded).length,
    avg_trade_duration: round(avgDurationMinutes(trades)),
    best_trade: round(Math.max(...pnls)),
    worst_trade: round(Math.min(...pnls)),
  };
}

function maxDrawdown(equityCurve: number[]): number {
  if (equityCurve.length < 2) return 0;

  let peak = equityCurve[0];
  let max = 0;
  for (const value of equityCurve) {
    peak = Math.max(peak, value);
    if (peak > 0) {
      max = Math.max(max, (peak - value) / peak);
    }
  }
  return max;
}

function sharpeRatio(pnls: number[]): number {
  if (pnls.length < 2) return 0;
  const mean = pnls.reduce((sum, value) => sum + value, 0) / pnls.length;
  const variance =
    pnls.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (pnls.length - 1);

  if (variance === 0) return 0;
  return round((mean / Math.sqrt(variance)) * Math.sqrt(252), 4);
}

function sortinoRatio(pnls: number[]): number {
  if (pnls.length < 2) return 0;
  const mean = pnls.reduce((sum, value) => sum + value, 0) / pnls.length;
  const downside = pnls.filter((value) => value < 0);
  if (downside.length < 2) return 0;

  const downsideMean = downside.reduce((sum, value) => sum + value, 0) / downside.length;
  const downsideVariance =
    downside.reduce((sum, value) => sum + (value - downsideMean) ** 2, 0) / (downside.length - 1);

  if (downsideVariance === 0) return 0;
  return round((mean / Math.sqrt(downsideVariance)) * Math.sqrt(252), 4);
}

function avgDurationMinutes(trades: Trade[]): number {
  const durations = trades
    .map((trade) => {
      const entry = Date.parse(trade.entry_time);
      const exit = trade.exit_time ? Date.parse(trade.exit_time) : Number.NaN;
      if (Number.isNaN(entry) || Number.isNaN(exit)) {
        return null;
      }
      return (exit - entry) / 60_000;
    })
    .filter((value): value is number => value !== null);

  if (durations.length === 0) return 0;
  return durations.reduce((sum, value) => sum + value, 0) / durations.length;
}

function evaluatePropFirm(
  rules: PropFirmRules,
  trades: Trade[],
  equityCurve: number[],
  initialBalance: number,
  timestamps: number[] = [],
  openEntryTime?: string,
): PropFirmEvaluation {
  const accountSize = rules.account_size ?? initialBalance;
  const dailyLossLimit = rules.daily_loss_limit ?? null;
  const maxDrawdownLimit = rules.max_drawdown ?? 0.08;
  const profitTarget = rules.profit_target ?? 0.1;
  const consistencyRule = rules.consistency_rule ?? true;
  const consistencyThreshold = rules.consistency_threshold ?? null;
  const drawdownType = rules.drawdown_type ?? "intraday";
  const minTradingDays = rules.min_trading_days ?? null;
  const dailyLossEnabled = dailyLossLimit != null && dailyLossLimit > 0;
  const effectiveDailyLossLimit = dailyLossEnabled ? dailyLossLimit : Number.POSITIVE_INFINITY;
  const dailyLossLimitPct = dailyLossEnabled ? dailyLossLimit : null;
  const dailyLossLimitAmount =
    dailyLossEnabled && dailyLossLimit != null ? round(accountSize * dailyLossLimit) : null;

  const dailyPnls = new Map<string, number>();
  const mffu = rules.evaluation_model === "mffu_eod" || rules.evaluation_model === "mffu_static";
  const mffuTradingDays = new Set<string>();
  for (const trade of trades) {
    if (mffu) {
      for (const time of [trade.entry_time, trade.exit_time]) {
        const parsed = time ? parseMffuTime(time) : NaN;
        if (Number.isFinite(parsed)) mffuTradingDays.add(mffuSession(parsed));
      }
    }
    if (!trade.exit_time) continue;
    const parsedExit = parseMffuTime(trade.exit_time);
    if (mffu && !Number.isFinite(parsedExit)) continue;
    const key = mffu ? mffuSession(parsedExit) : trade.exit_time.slice(0, 10);
    dailyPnls.set(key, (dailyPnls.get(key) ?? 0) + trade.pnl);
  }
  if (mffu && openEntryTime && Number.isFinite(parseMffuTime(openEntryTime))) mffuTradingDays.add(mffuSession(parseMffuTime(openEntryTime)));
  const tradingDaysCompleted = mffu ? mffuTradingDays.size : dailyPnls.size;
  const minTradingDaysPassed =
    minTradingDays === null || tradingDaysCompleted >= minTradingDays;

  const dailyLossBreached = rules.daily_loss_mode !== "soft_pause" && Array.from(dailyPnls.values()).some(
    (pnl) => pnl < -(accountSize * effectiveDailyLossLimit),
  );

  const mffuDrawdown = rules.evaluation_model === "mffu_eod" || rules.evaluation_model === "mffu_static"
    ? getMffuDrawdown(equityCurve, timestamps, accountSize, maxDrawdownLimit, rules.evaluation_model === "mffu_static")
    : null;
  const actualDrawdown = mffuDrawdown?.actual ?? getReplayDrawdown(equityCurve, accountSize, drawdownType);
  const drawdownBreached = mffuDrawdown ? mffuDrawdown.breached : actualDrawdown > maxDrawdownLimit;

  const finalBalance = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1] : initialBalance;
  const totalProfitPct = accountSize === 0 ? 0 : (finalBalance - accountSize) / accountSize;
  const profitTargetHit = totalProfitPct >= profitTarget;

  let consistencyPassed = true;
  let bestDayProfitPct = 0;
  if (consistencyRule) {
    if (consistencyThreshold === null) {
      consistencyPassed = false;
    } else if (dailyPnls.size > 0) {
      const totalProfit = finalBalance - accountSize;
      if (totalProfit > 0) {
        const bestDay = Math.max(...dailyPnls.values());
        bestDayProfitPct = bestDay / totalProfit;
        consistencyPassed = bestDayProfitPct <= consistencyThreshold;
      }
    }
  }

  return {
    passed:
      !mffuDrawdown?.incomplete && !dailyLossBreached &&
      !drawdownBreached &&
      profitTargetHit &&
      consistencyPassed &&
      minTradingDaysPassed,
    daily_loss_breached: dailyLossBreached,
    drawdown_breached: drawdownBreached,
    profit_target_hit: profitTargetHit,
    consistency_passed: consistencyPassed,
    min_trading_days_passed: minTradingDaysPassed,
    details: {
      account_size: accountSize,
      daily_loss_limit_pct: dailyLossLimitPct,
      daily_loss_mode: rules.daily_loss_mode ?? "breach",
      daily_loss_limit_amount: dailyLossLimitAmount,
      drawdown_type: drawdownType,
      evaluation_model: rules.evaluation_model ?? "legacy",
      drawdown_evidence_incomplete: mffuDrawdown?.incomplete ?? false,
      drawdown_floor: mffuDrawdown?.floor ?? null,
      max_drawdown_limit_pct: maxDrawdownLimit,
      actual_drawdown_pct: round(actualDrawdown, 4),
      profit_target_pct: profitTarget,
      actual_profit_pct: round(totalProfitPct, 4),
      best_day_profit_pct: round(bestDayProfitPct, 4),
      consistency_threshold: consistencyThreshold,
      min_trading_days_required: minTradingDays,
      trading_days_completed: tradingDaysCompleted,
      daily_pnls: Object.fromEntries(
        Array.from(dailyPnls.entries()).map(([key, value]) => [key, round(value)]),
      ),
    },
  };
}

function getReplayDrawdown(
  equityCurve: number[],
  accountSize: number,
  drawdownType: "intraday" | "eod",
): number {
  if (equityCurve.length < 2) return 0;

  if (drawdownType === "eod") {
    return Math.max(
      0,
      ...equityCurve.map((value) => (accountSize - value) / accountSize),
    );
  }

  let peak = equityCurve[0];
  let max = 0;
  for (const value of equityCurve) {
    peak = Math.max(peak, value);
    if (peak > 0) {
      max = Math.max(max, (peak - value) / peak);
    }
  }
  return max;
}

function buildAtrSeries(candles: Candle[], period: number): number[] {
  const values = new Array<number>(candles.length).fill(Number.NaN);
  if (period <= 0 || candles.length < period + 1) {
    return values;
  }

  const trueRanges = new Array<number>(candles.length).fill(Number.NaN);
  for (let i = 1; i < candles.length; i += 1) {
    const high = candles[i].high;
    const low = candles[i].low;
    const previousClose = candles[i - 1].close;
    trueRanges[i] = Math.max(
      high - low,
      Math.abs(high - previousClose),
      Math.abs(low - previousClose),
    );
  }

  let seed = 0;
  for (let i = 1; i <= period; i += 1) {
    seed += trueRanges[i];
  }
  values[period] = seed / period;

  const alpha = 1 / period;
  for (let i = period + 1; i < candles.length; i += 1) {
    values[i] = alpha * trueRanges[i] + (1 - alpha) * values[i - 1];
  }

  return values;
}

export function simulateReplaySession(args: {
  candles: Candle[];
  currentIndex: number;
  actions: ReplayAction[];
  initialBalance: number;
  positionSize?: number;
  sizingMode?: ReplaySizingMode;
  riskPerTradePct?: number | null;
  maxPositionSize?: number | null;
  stopLossTicks?: number | null;
  stopLossAtr?: number | null;
  atrPeriod?: number;
  commission?: number;
  tickValue?: number;
  tickSize?: number;
  spreadTicks?: number;
  volatileBarThresholdTicks?: number;
  volatileBarExtraTicks?: number;
  restingFillMode?: RestingFillMode;
  propFirmRules: PropFirmRules;
  symbol?: string;
  interval?: string;
}): ReplaySession {
  const {
    candles,
    currentIndex,
    actions,
    initialBalance,
    positionSize = 1,
    sizingMode = "fixed",
    riskPerTradePct = null,
    maxPositionSize = null,
    stopLossTicks = null,
    stopLossAtr = null,
    atrPeriod = 14,
    commission = 5,
    tickValue = 1,
    tickSize = DEFAULT_EXECUTION_CONFIG.tickSize,
    spreadTicks = DEFAULT_EXECUTION_CONFIG.spreadTicks,
    volatileBarThresholdTicks = DEFAULT_EXECUTION_CONFIG.volatileBarThresholdTicks,
    volatileBarExtraTicks = DEFAULT_EXECUTION_CONFIG.volatileBarExtraTicks,
    restingFillMode = DEFAULT_EXECUTION_CONFIG.restingFillMode,
    propFirmRules,
    symbol,
    interval,
  } = args;

  const executionConfig: ExecutionConfig = {
    tickSize,
    spreadTicks,
    volatileBarThresholdTicks,
    volatileBarExtraTicks,
    restingFillMode,
  };

  // The replay simulator prices PnL off points, not ticks: tickValue is dollars
  // per full point (for example $50 for ES, $5 for MES).
  const safeTickSize = tickSize > 0 ? tickSize : DEFAULT_EXECUTION_CONFIG.tickSize;
  const riskSizing = sizingMode === "risk_percent";
  const requireContracts = (value: number, name: string) => {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a whole number (1 or more).`);
    }
    return value;
  };
  const normalizedPositionSize = requireContracts(positionSize, "Contracts");
  const firmContractLimit = mffuContractLimit(symbol, propFirmRules);
  if (!riskSizing && firmContractLimit !== null && normalizedPositionSize > firmContractLimit) {
    throw new Error(`Requested ${normalizedPositionSize} contracts exceeds the account limit of ${firmContractLimit} for ${symbol}.`);
  }
  const normalizedMaxPositionSize = maxPositionSize == null
    ? null : requireContracts(maxPositionSize, "Maximum contracts");
  const normalizedAtrPeriod = requireContracts(atrPeriod, "ATR period");
  if (sizingMode !== "fixed" && sizingMode !== "risk_percent") {
    throw new Error("Unknown sizing mode.");
  }
  if (stopLossTicks != null && stopLossAtr != null) {
    throw new Error("Choose a tick stop or an ATR stop, not both.");
  }
  for (const stop of [stopLossTicks, stopLossAtr]) {
    if (stop != null && (!Number.isFinite(stop) || stop <= 0)) {
      throw new Error("Initial stops must be greater than zero.");
    }
  }
  if (riskSizing) {
    if (riskPerTradePct == null || !Number.isFinite(riskPerTradePct) || riskPerTradePct <= 0 || riskPerTradePct > 100) {
      throw new Error("Risk per trade must be greater than zero and at most 100%.");
    }
    if (stopLossTicks == null && stopLossAtr == null) {
      throw new Error("Risk sizing requires an initial stop.");
    }
  } else if (riskPerTradePct != null || maxPositionSize != null) {
    throw new Error("Risk percent and maximum contracts require risk sizing.");
  }
  const atrValues = stopLossAtr != null ? buildAtrSeries(candles, normalizedAtrPeriod) : null;

  if (candles.length === 0) {
    const equityCurve = [initialBalance];
    return {
      trades: [],
      metrics: emptyMetrics(),
      equityCurve,
      propEvaluation: evaluatePropFirm(propFirmRules, [], equityCurve, initialBalance),
      firstPass: null,
      position: null,
      activeOrder: null,
      activeOrders: [],
      currentQuote: null,
      executionEvents: [],
      balance: initialBalance,
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalPnl: 0,
    };
  }

  const cappedIndex = clampReplayIndex(currentIndex, candles.length);
  const visibleCandles = candles.slice(0, cappedIndex + 1);
  const visibleActions = actions
    .filter((action) => action.barIndex <= cappedIndex)
    .sort((a, b) => (a.barIndex - b.barIndex) || (a.createdAt - b.createdAt));

  let balance = initialBalance;
  let position: OpenReplayPosition | null = null;
  const getPosition = (): OpenReplayPosition | null => position;

  const stopTicksForEntry = (
    side: "buy" | "sell",
    entryPrice: number,
    entryIndex: number,
  ): number | null => {
    const atr = entryIndex > 0 && atrValues ? atrValues[entryIndex - 1] : null;
    const stopDistance =
      stopLossTicks != null
        ? stopLossTicks * safeTickSize
        : stopLossAtr != null && atr != null && Number.isFinite(atr) && atr > 0
          ? stopLossAtr * atr
          : null;

    if (stopDistance == null || !Number.isFinite(stopDistance) || stopDistance <= 0) {
      return null;
    }

    const rawStop = side === "buy" ? entryPrice - stopDistance : entryPrice + stopDistance;
    const stopPrice = roundToTick(rawStop, safeTickSize);
    const stopTicks = Math.abs(entryPrice - stopPrice) / safeTickSize;
    return Number.isFinite(stopTicks) && stopTicks > 0 ? stopTicks : null;
  };

  const riskForQuantity = (
    side: "buy" | "sell",
    entryPrice: number,
    entryIndex: number,
    quantity: number,
  ): Omit<EntrySizing, "quantity"> => {
    const stopTicks = stopTicksForEntry(side, entryPrice, entryIndex);
    if (stopTicks == null) {
      return {
        initialRisk: undefined,
        riskBudget: riskSizing ? null : undefined,
        riskExceeded: false,
      };
    }

    const riskPerContract = stopTicks * safeTickSize * tickValue + commission;
    const initialRisk = quantity * riskPerContract;
    const initialStopPrice = roundToTick(
      side === "buy" ? entryPrice - stopTicks * safeTickSize : entryPrice + stopTicks * safeTickSize,
      safeTickSize,
    );

    if (!riskSizing) {
      return { initialStopPrice, initialRisk, riskBudget: undefined, riskExceeded: false };
    }

    const riskBudget =
      riskPerTradePct != null && riskPerTradePct > 0
        ? (balance * riskPerTradePct) / 100
        : null;
    return {
      initialStopPrice,
      initialRisk,
      riskBudget,
      riskExceeded: riskBudget == null ? true : initialRisk > riskBudget,
    };
  };

  const quantityForEntry = (
    side: "buy" | "sell",
    entryPrice: number,
    entryIndex: number,
  ): EntrySizing | null => {
    if ((stopLossTicks != null || stopLossAtr != null) && stopTicksForEntry(side, entryPrice, entryIndex) == null) {
      return null;
    }
    if (!riskSizing) {
      const quantity = normalizedPositionSize;
      return {
        quantity,
        ...riskForQuantity(side, entryPrice, entryIndex, quantity),
      };
    }

    if (riskPerTradePct == null || riskPerTradePct <= 0) {
      return null;
    }

    const stopTicks = stopTicksForEntry(side, entryPrice, entryIndex);
    if (stopTicks == null) {
      return null;
    }

    const riskPerContract = stopTicks * safeTickSize * tickValue + commission;
    if (!Number.isFinite(riskPerContract) || riskPerContract <= 0) {
      return null;
    }

    const riskBudget = (balance * riskPerTradePct) / 100;
    const rawContracts =
      riskPerContract > 0 ? Math.floor(riskBudget / riskPerContract) : 1;
    let quantity = Math.max(1, rawContracts);
    if (normalizedMaxPositionSize != null) {
      quantity = Math.min(quantity, normalizedMaxPositionSize);
    }
    if (firmContractLimit !== null) quantity = Math.min(quantity, firmContractLimit);

    return {
      quantity,
      ...riskForQuantity(side, entryPrice, entryIndex, quantity),
    };
  };
  let activeOrders: RestingOrder[] = [];
  let tradeId = 0;
  const trades: Trade[] = [];
  const equityCurve: number[] = [];
  const executionEvents: ExecutionEvent[] = [];
  let firstPass: ReplayPassInfo | null = null;
  let softSession = mffuSession(visibleCandles[0].time);
  let sessionStartEquity = initialBalance;
  let softPaused = false;
  let lastCandle = visibleCandles[0];
  let lastQuote = syntheticQuoteForCandle(lastCandle, executionConfig);

  const appendEvent = (event: Omit<ExecutionEvent, "id">) => {
    executionEvents.push({
      id: `evt_${executionEvents.length}_${event.bar_index}`,
      ...event,
    });
  };

  const closePosition = (candle: Candle, exitPrice: number) => {
    if (!position) return;

    const pnl = computePnl(
      position.side,
      position.entryPrice,
      exitPrice,
      position.quantity,
      tickValue,
      commission,
    );
    balance = round(balance + pnl);
    const rMultiple =
      position.initialRisk != null && position.initialRisk > 0
        ? round(pnl / position.initialRisk, 4)
        : undefined;
    trades.push({
      trade_id: tradeId,
      entry_time: position.entryTime,
      exit_time: getCandleTime(candle),
      side: position.side,
      quantity: position.quantity,
      entry_price: position.entryPrice,
      exit_price: exitPrice,
      pnl,
      status: "closed",
      commission: round(commission * position.quantity),
      initial_risk:
        position.initialRisk != null ? round(position.initialRisk) : undefined,
      risk_budget:
        position.riskBudget != null ? round(position.riskBudget) : undefined,
      r_multiple: rMultiple,
      risk_exceeded: position.riskExceeded,
    });
    tradeId += 1;
    position = null;
  };

  const openPosition = (
    side: "buy" | "sell",
    price: number,
    candle: Candle,
    barIndex: number,
    sizing: EntrySizing,
  ) => {
    position = {
      side,
      quantity: sizing.quantity,
      entryPrice: price,
      entryTime: getCandleTime(candle),
      entryBarIndex: barIndex,
      initialStopPrice: sizing.initialStopPrice,
      initialRisk: sizing.initialRisk,
      riskBudget: sizing.riskBudget,
      riskExceeded: sizing.riskExceeded,
    };
  };

  const placeInitialStop = (candle: Candle, barIndex: number) => {
    const opened = getPosition();
    if (opened?.initialStopPrice == null) return;
    const stop: RestingOrder = {
      id: `initial_${barIndex}_${tradeId}_stop`,
      intent: "exit",
      side: opened.side === "buy" ? "sell" : "buy",
      price: opened.initialStopPrice,
      quantity: opened.quantity,
      submitted_at: getCandleTime(candle),
      submitted_bar_index: barIndex,
      type: "bracket_stop",
      status: "pending",
      reduce_only: true,
      bracket_id: `initial_${barIndex}_${tradeId}`,
      bracket_role: "stop",
    };
    activeOrders = [stop];
    appendEvent({
      type: "resting_submitted",
      action: "bracket_stop",
      side: stop.side,
      price: stop.price,
      bar_index: barIndex,
      time: stop.submitted_at,
      order_id: stop.id,
      reason: "Configured initial stop.",
    });
  };

  const primaryActiveOrder = (): RestingOrder | null => activeOrders[0] ?? null;
  const hasPendingOrders = (): boolean => activeOrders.some((order) => order.status === "pending");
  const canReplaceBracketOrders = (): boolean => {
    const pending = activeOrders.filter((order) => order.status === "pending");
    return (
      pending.length > 0 &&
      pending.every(
        (order) =>
          order.intent === "exit" &&
          Boolean(order.bracket_id) &&
          (order.bracket_role === "stop" || order.bracket_role === "target"),
      )
    );
  };
  const clearActiveOrders = (): void => {
    activeOrders = [];
  };

  const bracketValidityError = (
    activePosition: OpenReplayPosition,
    stopPrice: number,
    targetPrice: number,
    quote: SyntheticQuote,
  ): string | null => {
    if (activePosition.side === "buy") {
      if (stopPrice >= quote.reference) return "Long brackets need the stop below the current reference price.";
      if (targetPrice <= quote.reference) return "Long brackets need the target above the current reference price.";
      return null;
    }

    if (stopPrice <= quote.reference) return "Short brackets need the stop above the current reference price.";
    if (targetPrice >= quote.reference) return "Short brackets need the target below the current reference price.";
    return null;
  };

  for (let i = 0; i < visibleCandles.length; i += 1) {
    const candle = visibleCandles[i];
    const quote = syntheticQuoteForCandle(candle, executionConfig);
    lastCandle = candle;
    lastQuote = quote;
    const actionsAtBar = visibleActions.filter((action) => action.barIndex === i);

    if (propFirmRules.daily_loss_mode === "soft_pause") {
      const currentSession = mffuSession(candle.time);
      if (currentSession !== softSession) {
        softSession = currentSession;
        sessionStartEquity = equityCurve[equityCurve.length - 1] ?? initialBalance;
        softPaused = false;
      }
      if (softPaused) {
        for (const action of actionsAtBar) appendEvent({type: "ignored", action: action.type, bar_index: i, time: getCandleTime(candle), reason: "Trading paused after the daily soft loss limit."});
        equityCurve.push(round(balance));
        continue;
      }
    }

    const pendingOrders = activeOrders.filter(
      (order) => order.status === "pending" && i > order.submitted_bar_index,
    );
    if (pendingOrders.length > 0) {
      const updatedOrders = activeOrders.map((order) => {
        if (order.status !== "pending" || i <= order.submitted_bar_index) {
          return order;
        }
        return restingOrderFillUpdate({
          order,
          candle,
          fillMode: normalizeRestingFillMode(executionConfig.restingFillMode),
          barIndex: i,
          time: getCandleTime(candle),
        }).order;
      });
      const fillCandidates = updatedOrders.filter((_order, index) => {
        const original = activeOrders[index];
        if (original.status !== "pending" || i <= original.submitted_bar_index) {
          return false;
        }
        return restingOrderFillUpdate({
          order: original,
          candle,
          fillMode: normalizeRestingFillMode(executionConfig.restingFillMode),
          barIndex: i,
          time: getCandleTime(candle),
        }).shouldFill;
      });

      if (fillCandidates.length > 0) {
        const filledOrder = [...fillCandidates].sort((left, right) => {
          const priorityDiff = restingOrderPriority(left) - restingOrderPriority(right);
          if (priorityDiff !== 0) return priorityDiff;
          return left.id.localeCompare(right.id);
        })[0];
        const completedOrder: RestingOrder = {
          ...filledOrder,
          status: "filled",
          filled_at: getCandleTime(candle),
          filled_bar_index: i,
        };

        if (completedOrder.intent === "exit") {
          closePosition(candle, completedOrder.price);
        } else {
          const quantity = completedOrder.quantity ?? normalizedPositionSize;
          openPosition(completedOrder.side, completedOrder.price, candle, i, {
            quantity,
            // A resting entry keeps the stop basis used when it was submitted.
            ...riskForQuantity(completedOrder.side, completedOrder.price, completedOrder.submitted_bar_index, quantity),
          });
        }
        appendEvent({
          type: "resting_filled",
          action: completedOrder.type,
          side: completedOrder.side,
          price: completedOrder.price,
          bar_index: i,
          time: getCandleTime(candle),
          order_id: completedOrder.id,
        });

        activeOrders = updatedOrders.flatMap((order) => {
          if (order.id === completedOrder.id) {
            return [];
          }
          if (sameBracketGroup(order, completedOrder)) {
            appendEvent({
              type: "resting_canceled",
              action: order.type,
              side: order.side,
              price: order.price,
              bar_index: i,
              time: getCandleTime(candle),
              order_id: order.id,
              reason: "OCO sibling filled first.",
            });
            return [];
          }
          return [order];
        });
        if (completedOrder.intent === "entry") placeInitialStop(candle, i);
      } else {
        activeOrders = updatedOrders;
      }
    }

    for (const action of actionsAtBar) {
      const actionType = normalizeExecutionAction(action.type);

      if (actionType === "cancel") {
        const cancelTargets = activeOrders.filter((candidate) => {
          if (candidate.status !== "pending") {
            return false;
          }
          if (action.orderId) {
            return candidate.id === action.orderId;
          }
          if (action.bracketRole) {
            return candidate.bracket_role === action.bracketRole;
          }
          return true;
        });

        if (cancelTargets.length > 0) {
          const cancelTargetIds = new Set(cancelTargets.map((order) => order.id));
          for (const order of cancelTargets) {
            appendEvent({
              type: "resting_canceled",
              action: action.type,
              side: order.side,
              price: order.price,
              bar_index: i,
              time: getCandleTime(candle),
              order_id: order.id,
            });
          }
          activeOrders = activeOrders.filter((order) => !cancelTargetIds.has(order.id));
        } else {
          appendEvent({
            type: "ignored",
            action: action.type,
            bar_index: i,
            time: getCandleTime(candle),
            reason: action.bracketRole
              ? `No pending ${action.bracketRole} order to cancel.`
              : "No pending order to cancel.",
          });
        }
        continue;
      }

      if (actionType === "replace") {
        const currentOrder = primaryActiveOrder();
        if (currentOrder && currentOrder.status === "pending" && activeOrders.length === 1) {
          const nextPrice = currentOrder.side === "buy" ? quote.bid : quote.ask;
          const sizing = currentOrder.intent === "entry"
            ? quantityForEntry(currentOrder.side, nextPrice, i) : null;
          if (currentOrder.intent === "entry" && !sizing) {
            appendEvent({
              type: "ignored", action: action.type, bar_index: i,
              time: getCandleTime(candle),
              reason: "Risk sizing needs a usable initial stop before this entry can be replaced.",
            });
            continue;
          }
          const replacement = replaceRestingOrder({
            order: currentOrder,
            newId: action.id,
            price: nextPrice,
            barIndex: i,
            time: getCandleTime(candle),
          });
          if (sizing) replacement.nextOrder.quantity = sizing.quantity;
          appendEvent({
            type: "resting_replaced",
            action: action.type,
            side: replacement.nextOrder.side,
            price: replacement.nextOrder.price,
            bar_index: i,
            time: getCandleTime(candle),
            order_id: replacement.nextOrder.id,
            replaced_order_id: replacement.replacedOrder.id,
          });
          activeOrders = [replacement.nextOrder];
        } else {
          appendEvent({
            type: "ignored",
            action: action.type,
            bar_index: i,
            time: getCandleTime(candle),
            reason: hasPendingOrders()
              ? "Replace only supports one live order right now."
              : "No pending order to replace.",
          });
        }
        continue;
      }

      if (actionType === "flatten") {
        if (hasPendingOrders()) {
          for (const order of activeOrders.filter((candidate) => candidate.status === "pending")) {
            appendEvent({
              type: "resting_canceled",
              action: action.type,
              side: order.side,
              price: order.price,
              bar_index: i,
              time: getCandleTime(candle),
              order_id: order.id,
              reason: "Flatten canceled the pending order.",
            });
          }
          clearActiveOrders();
        }

        if (position) {
          const exitPrice = position.side === "buy" ? quote.bid : quote.ask;
          closePosition(candle, exitPrice);
          appendEvent({
            type: "flatten",
            action: action.type,
            price: exitPrice,
            bar_index: i,
            time: getCandleTime(candle),
          });
        }
        continue;
      }

      if (actionType === "join_bid" || actionType === "join_ask") {
        if (position) {
          appendEvent({
            type: "ignored",
            action: action.type,
            bar_index: i,
            time: getCandleTime(candle),
            reason: "Resting entries are only supported while flat in Phase 1.",
          });
          continue;
        }
        if (hasPendingOrders()) {
          appendEvent({
            type: "ignored",
            action: action.type,
            bar_index: i,
            time: getCandleTime(candle),
            order_id: primaryActiveOrder()?.id,
            reason: "Only one active resting order is supported right now.",
          });
          continue;
        }

        const entrySide = actionType === "join_bid" ? "buy" : "sell";
        const entryPrice = entrySide === "buy" ? quote.bid : quote.ask;
        const sizing = quantityForEntry(entrySide, entryPrice, i);
        if (!sizing) {
          appendEvent({
            type: "ignored",
            action: action.type,
            bar_index: i,
            time: getCandleTime(candle),
            reason: "Risk sizing needs a usable initial stop before this entry can be placed.",
          });
          continue;
        }

        const nextOrder = createRestingOrder({
          action: actionType,
          id: action.id,
          barIndex: i,
          time: getCandleTime(candle),
          quote,
          quantity: sizing.quantity,
        });
        activeOrders = [nextOrder];
        appendEvent({
          type: "resting_submitted",
          action: action.type,
          side: nextOrder.side,
          price: nextOrder.price,
          bar_index: i,
          time: getCandleTime(candle),
          order_id: nextOrder.id,
        });
        continue;
      }

      if (actionType === "rest_exit") {
        const activePosition = position;
        if (!activePosition) {
          appendEvent({
            type: "ignored",
            action: action.type,
            bar_index: i,
            time: getCandleTime(candle),
            reason: "Resting exits need an open position first.",
          });
          continue;
        }
        if (hasPendingOrders()) {
          appendEvent({
            type: "ignored",
            action: action.type,
            bar_index: i,
            time: getCandleTime(candle),
            order_id: primaryActiveOrder()?.id,
            reason: "Only one active resting order is supported right now.",
          });
          continue;
        }

        const exitPosition = activePosition as OpenReplayPosition;
        const exitSide = exitPosition.side === "buy" ? "sell" : "buy";
        const nextOrder = createRestingOrder({
          action: actionType,
          id: action.id,
          barIndex: i,
          time: getCandleTime(candle),
          quote,
          intent: "exit",
          side: exitSide,
          quantity: exitPosition.quantity,
        });
        activeOrders = [nextOrder];
        appendEvent({
          type: "resting_submitted",
          action: action.type,
          side: nextOrder.side,
          price: nextOrder.price,
          bar_index: i,
          time: getCandleTime(candle),
          order_id: nextOrder.id,
        });
        continue;
      }

      if (actionType === "attach_bracket") {
        const activePosition = position;
        if (!activePosition) {
          appendEvent({
            type: "ignored",
            action: action.type,
            bar_index: i,
            time: getCandleTime(candle),
            reason: "Bracket exits need an open position first.",
          });
          continue;
        }
        if (hasPendingOrders() && !canReplaceBracketOrders()) {
          appendEvent({
            type: "ignored",
            action: action.type,
            bar_index: i,
            time: getCandleTime(candle),
            order_id: primaryActiveOrder()?.id,
            reason: "Cancel the current resting order before attaching a bracket.",
          });
          continue;
        }
        if (action.stopPrice === undefined || action.targetPrice === undefined) {
          appendEvent({
            type: "ignored",
            action: action.type,
            bar_index: i,
            time: getCandleTime(candle),
            reason: "Bracket actions need both stop and target prices.",
          });
          continue;
        }

        const bracketPosition = activePosition as OpenReplayPosition;
        const validityError = bracketValidityError(
          bracketPosition,
          action.stopPrice,
          action.targetPrice,
          quote,
        );
        if (validityError) {
          appendEvent({
            type: "ignored",
            action: action.type,
            bar_index: i,
            time: getCandleTime(candle),
            reason: validityError,
          });
          continue;
        }

        const bracketOrders = createBracketExitOrders({
          bracketId: action.id,
          positionSide: bracketPosition.side,
          barIndex: i,
          time: getCandleTime(candle),
          stopPrice: action.stopPrice,
          targetPrice: action.targetPrice,
          quantity: bracketPosition.quantity,
        });

        if (hasPendingOrders() && canReplaceBracketOrders()) {
          for (const order of activeOrders.filter((candidate) => candidate.status === "pending")) {
            appendEvent({
              type: "resting_canceled",
              action: action.type,
              side: order.side,
              price: order.price,
              bar_index: i,
              time: getCandleTime(candle),
              order_id: order.id,
              reason: "Bracket moved.",
            });
          }
        }
        activeOrders = bracketOrders;
        for (const order of bracketOrders) {
          appendEvent({
            type: "resting_submitted",
            action: action.type,
            side: order.side,
            price: order.price,
            bar_index: i,
            time: getCandleTime(candle),
            order_id: order.id,
          });
        }
        continue;
      }

      const nextSide = actionType === "lift_ask" ? "buy" : "sell";
      const fillPrice = actionType === "lift_ask" ? quote.ask : quote.bid;
      const activePosition: OpenReplayPosition | null = position;

      if (activePosition && (activePosition as OpenReplayPosition).side === nextSide) {
        continue;
      }

      if (activePosition) {
        closePosition(candle, fillPrice);
      }

      clearActiveOrders();
      const sizing = quantityForEntry(nextSide, fillPrice, i);
      if (!sizing) {
        appendEvent({
          type: "ignored",
          action: action.type,
          bar_index: i,
          time: getCandleTime(candle),
          reason: "Risk sizing needs a usable initial stop before this entry can be placed.",
        });
        continue;
      }
      openPosition(nextSide, fillPrice, candle, i, sizing);
      placeInitialStop(candle, i);
      appendEvent({
        type: "taker_fill",
        action: action.type,
        side: nextSide,
        price: fillPrice,
        bar_index: i,
        time: getCandleTime(candle),
      });
    }

    const markedPosition = getPosition();
    const unrealizedPnl = markedPosition
      ? computePnl(
          markedPosition.side,
          markedPosition.entryPrice,
          candle.close,
          markedPosition.quantity,
          tickValue,
          commission,
        )
      : 0;

    equityCurve.push(round(balance + unrealizedPnl));

    const currentEvaluation = evaluatePropFirm(propFirmRules, trades, equityCurve, initialBalance, visibleCandles.slice(0, equityCurve.length).map((item) => item.time), getPosition()?.entryTime);
    if (currentEvaluation.daily_loss_breached || currentEvaluation.drawdown_breached) {
      // Freeze the session right here so later candles can't sneak in extra fills.
      if (hasPendingOrders()) {
        for (const order of activeOrders.filter((candidate) => candidate.status === "pending")) {
          appendEvent({
            type: "resting_canceled",
            action: "cancel",
            side: order.side,
            price: order.price,
            bar_index: i,
            time: getCandleTime(candle),
            order_id: order.id,
            reason: "Prop firm breach canceled the resting order.",
          });
        }
        clearActiveOrders();
      }

      const breachPosition = getPosition();
      if (breachPosition) {
        const exitPrice = breachPosition.side === "buy" ? quote.bid : quote.ask;
        closePosition(candle, exitPrice);
        appendEvent({
          type: "flatten",
          action: "flatten",
          price: exitPrice,
          bar_index: i,
          time: getCandleTime(candle),
          reason: "Prop firm breach forced liquidation.",
        });
        equityCurve[equityCurve.length - 1] = balance;
      }

      break;
    }

    if (propFirmRules.daily_loss_mode === "soft_pause" && propFirmRules.daily_loss_limit != null &&
        equityCurve[equityCurve.length - 1] <= sessionStartEquity - propFirmRules.account_size * propFirmRules.daily_loss_limit) {
      for (const order of activeOrders.filter((candidate) => candidate.status === "pending")) {
        appendEvent({type: "resting_canceled", action: "cancel", side: order.side, price: order.price,
          bar_index: i, time: getCandleTime(candle), order_id: order.id, reason: "Daily soft pause canceled the order."});
      }
      clearActiveOrders();
      const open = getPosition();
      if (open) {
        const exitPrice = open.side === "buy" ? quote.bid : quote.ask;
        closePosition(candle, exitPrice);
        appendEvent({type: "flatten", action: "flatten", price: exitPrice, bar_index: i,
          time: getCandleTime(candle), reason: "Daily soft loss limit paused trading."});
        equityCurve[equityCurve.length - 1] = balance;
      }
      softPaused = true;
    }
    const settledEvaluation = softPaused
      ? evaluatePropFirm(propFirmRules, trades, equityCurve, initialBalance, visibleCandles.slice(0, equityCurve.length).map((item) => item.time), getPosition()?.entryTime)
      : currentEvaluation;
    if (settledEvaluation.passed && !firstPass) {
      firstPass = {barIndex: i, time: getCandleTime(candle), equity: equityCurve[equityCurve.length - 1]};
    }
  }

  const currentCandle = lastCandle;
  const currentQuote = lastQuote;
  const finalPosition = getPosition();
  const finalUnrealizedPnl = finalPosition
    ? computePnl(
        finalPosition.side,
        finalPosition.entryPrice,
        currentCandle.close,
        finalPosition.quantity,
        tickValue,
        commission,
      )
    : 0;

  const replayPosition = finalPosition
    ? {
        side: finalPosition.side,
        quantity: finalPosition.quantity,
        entry_price: finalPosition.entryPrice,
        entry_time: finalPosition.entryTime,
        entry_bar_index: finalPosition.entryBarIndex,
        current_price: currentCandle.close,
        current_time: getCandleTime(currentCandle),
        unrealized_pnl: finalUnrealizedPnl,
        initial_risk: finalPosition.initialRisk,
        risk_budget: finalPosition.riskBudget,
        risk_exceeded: finalPosition.riskExceeded,
      }
    : null;

  const metrics = calculateMetrics(trades, equityCurve);
  const finalEvaluation = evaluatePropFirm(propFirmRules, trades, equityCurve, initialBalance, visibleCandles.slice(0, equityCurve.length).map((item) => item.time), finalPosition?.entryTime);
  if (propFirmRules.evaluation_model === "mffu_eod" || propFirmRules.evaluation_model === "mffu_static") {
    const openTrade: Trade[] = finalPosition ? [{
      trade_id: tradeId, entry_time: finalPosition.entryTime, exit_time: getCandleTime(currentCandle),
      side: finalPosition.side, quantity: finalPosition.quantity, entry_price: finalPosition.entryPrice,
      exit_price: currentCandle.close, pnl: finalUnrealizedPnl, status: "closed",
      commission: commission * finalPosition.quantity,
    }] : [];
    const evidence = assessMffuEvidence(visibleCandles.slice(0, equityCurve.length), [...trades, ...openTrade], equityCurve, initialBalance, propFirmRules, interval, tickValue);
    finalEvaluation.details.mffu_evidence = evidence;
    if (evidence.incomplete || evidence.possible_intrabar_limit) {
      finalEvaluation.passed = false;
      firstPass = null;
    }
  }
  return {
    trades,
    metrics,
    equityCurve,
    propEvaluation: finalEvaluation,
    firstPass,
    position: replayPosition,
    activeOrder: primaryActiveOrder(),
    activeOrders,
    currentQuote,
    executionEvents,
    balance,
    realizedPnl: round(balance - initialBalance),
    unrealizedPnl: finalUnrealizedPnl,
    totalPnl: round(balance - initialBalance + finalUnrealizedPnl),
  };
}
