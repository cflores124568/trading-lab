import type { Candle, PropFirmEvaluation, PropFirmRules, Trade } from "./api";
import {
  createBracketExitOrders,
  createRestingOrder,
  DEFAULT_EXECUTION_CONFIG,
  normalizeExecutionAction,
  normalizeRestingFillMode,
  replaceRestingOrder,
  restingOrderPriority,
  restingOrderFillUpdate,
  sameBracketGroup,
  syntheticQuoteForCandle,
  type ExecutionConfig,
  type ExecutionEvent,
  type LegacyExecutionActionType,
  type RestingFillMode,
  type RestingOrder,
  type SyntheticQuote,
} from "./executionModel.ts";

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
  avg_trade_duration: number;
  best_trade: number;
  worst_trade: number;
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
}

export interface ReplaySession {
  trades: Trade[];
  metrics: ReplayMetrics;
  equityCurve: number[];
  propEvaluation: PropFirmEvaluation;
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
  return round(raw - commission);
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
  for (const trade of trades) {
    if (!trade.exit_time) continue;
    const key = trade.exit_time.slice(0, 10);
    dailyPnls.set(key, (dailyPnls.get(key) ?? 0) + trade.pnl);
  }
  const tradingDaysCompleted = dailyPnls.size;
  const minTradingDaysPassed =
    minTradingDays === null || tradingDaysCompleted >= minTradingDays;

  const dailyLossBreached = Array.from(dailyPnls.values()).some(
    (pnl) => pnl < -(accountSize * effectiveDailyLossLimit),
  );

  const actualDrawdown = getReplayDrawdown(equityCurve, accountSize, drawdownType);
  const drawdownBreached = actualDrawdown > maxDrawdownLimit;

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
      !dailyLossBreached &&
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
      daily_loss_limit_amount: dailyLossLimitAmount,
      drawdown_type: drawdownType,
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

export function simulateReplaySession(args: {
  candles: Candle[];
  currentIndex: number;
  actions: ReplayAction[];
  initialBalance: number;
  positionSize?: number;
  commission?: number;
  tickValue?: number;
  tickSize?: number;
  spreadTicks?: number;
  volatileBarThresholdTicks?: number;
  volatileBarExtraTicks?: number;
  restingFillMode?: RestingFillMode;
  propFirmRules: PropFirmRules;
}): ReplaySession {
  const {
    candles,
    currentIndex,
    actions,
    initialBalance,
    positionSize = 1,
    commission = 5,
    tickValue = 1,
    tickSize = DEFAULT_EXECUTION_CONFIG.tickSize,
    spreadTicks = DEFAULT_EXECUTION_CONFIG.spreadTicks,
    volatileBarThresholdTicks = DEFAULT_EXECUTION_CONFIG.volatileBarThresholdTicks,
    volatileBarExtraTicks = DEFAULT_EXECUTION_CONFIG.volatileBarExtraTicks,
    restingFillMode = DEFAULT_EXECUTION_CONFIG.restingFillMode,
    propFirmRules,
  } = args;

  const executionConfig: ExecutionConfig = {
    tickSize,
    spreadTicks,
    volatileBarThresholdTicks,
    volatileBarExtraTicks,
    restingFillMode,
  };

  if (candles.length === 0) {
    const equityCurve = [initialBalance];
    return {
      trades: [],
      metrics: emptyMetrics(),
      equityCurve,
      propEvaluation: evaluatePropFirm(propFirmRules, [], equityCurve, initialBalance),
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
  let activeOrders: RestingOrder[] = [];
  let tradeId = 0;
  const trades: Trade[] = [];
  const equityCurve: number[] = [];
  const executionEvents: ExecutionEvent[] = [];

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
      positionSize,
      tickValue,
      commission,
    );
    balance = round(balance + pnl);
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
      commission,
    });
    tradeId += 1;
    position = null;
  };

  const openPosition = (
    side: "buy" | "sell",
    price: number,
    candle: Candle,
    barIndex: number,
  ) => {
    position = {
      side,
      quantity: positionSize,
      entryPrice: price,
      entryTime: getCandleTime(candle),
      entryBarIndex: barIndex,
    };
  };

  const primaryActiveOrder = (): RestingOrder | null => activeOrders[0] ?? null;
  const hasPendingOrders = (): boolean => activeOrders.some((order) => order.status === "pending");
  const clearActiveOrders = (): void => {
    activeOrders = [];
  };

  for (let i = 0; i < visibleCandles.length; i += 1) {
    const candle = visibleCandles[i];
    const quote = syntheticQuoteForCandle(candle, executionConfig);
    const actionsAtBar = visibleActions.filter((action) => action.barIndex === i);

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
          openPosition(completedOrder.side, completedOrder.price, candle, i);
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
      } else {
        activeOrders = updatedOrders;
      }
    }

    for (const action of actionsAtBar) {
      const actionType = normalizeExecutionAction(action.type);

      if (actionType === "cancel") {
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
            });
          }
          clearActiveOrders();
        } else {
          appendEvent({
            type: "ignored",
            action: action.type,
            bar_index: i,
            time: getCandleTime(candle),
            reason: "No pending order to cancel.",
          });
        }
        continue;
      }

      if (actionType === "replace") {
        const currentOrder = primaryActiveOrder();
        if (currentOrder && currentOrder.status === "pending" && activeOrders.length === 1) {
          const nextPrice = currentOrder.side === "buy" ? quote.bid : quote.ask;
          const replacement = replaceRestingOrder({
            order: currentOrder,
            newId: action.id,
            price: nextPrice,
            barIndex: i,
            time: getCandleTime(candle),
          });
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

        const nextOrder = createRestingOrder({
          action: actionType,
          id: action.id,
          barIndex: i,
          time: getCandleTime(candle),
          quote,
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
        if (hasPendingOrders()) {
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
        const bracketOrders = createBracketExitOrders({
          bracketId: action.id,
          positionSide: bracketPosition.side,
          barIndex: i,
          time: getCandleTime(candle),
          stopPrice: action.stopPrice,
          targetPrice: action.targetPrice,
        });
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
      openPosition(nextSide, fillPrice, candle, i);
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
          positionSize,
          tickValue,
          commission,
        )
      : 0;

    equityCurve.push(round(balance + unrealizedPnl));
  }

  const currentCandle = visibleCandles[visibleCandles.length - 1];
  const currentQuote = syntheticQuoteForCandle(currentCandle, executionConfig);
  const finalPosition = getPosition();
  const finalUnrealizedPnl = finalPosition
    ? computePnl(
        finalPosition.side,
        finalPosition.entryPrice,
        currentCandle.close,
        positionSize,
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
      }
    : null;

  const metrics = calculateMetrics(trades, equityCurve);
  return {
    trades,
    metrics,
    equityCurve,
    propEvaluation: evaluatePropFirm(propFirmRules, trades, equityCurve, initialBalance),
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
