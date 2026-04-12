import type {
  PropFirmEvaluation,
  PropFirmPreset,
  PropFirmRules,
  Trade,
} from "./api";

export interface DailyPnlEntry {
  date: string;
  pnl: number;
  trade_count: number;
  winning_trades: number;
  losing_trades: number;
}

export interface TradeAnalyticsSummary {
  avg_win: number;
  avg_loss: number;
  gross_wins: number;
  gross_losses: number;
  current_balance: number;
  total_contracts: number;
  trading_days: number;
  largest_green_day: number;
  largest_red_day: number;
  daily_pnls: DailyPnlEntry[];
}

function round(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

export function summarizeTrades(
  trades: Trade[],
  equityCurve: number[],
  initialBalance: number,
): TradeAnalyticsSummary {
  const winningTrades = trades.filter((trade) => trade.pnl > 0);
  const losingTrades = trades.filter((trade) => trade.pnl < 0);
  const grossWins = winningTrades.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLosses = Math.abs(losingTrades.reduce((sum, trade) => sum + trade.pnl, 0));
  const dailyPnlMap = new Map<string, DailyPnlEntry>();

  for (const trade of trades) {
    if (!trade.exit_time) {
      continue;
    }

    const dayKey = trade.exit_time.slice(0, 10);
    const existing =
      dailyPnlMap.get(dayKey) ??
      {
        date: dayKey,
        pnl: 0,
        trade_count: 0,
        winning_trades: 0,
        losing_trades: 0,
      };

    existing.pnl += trade.pnl;
    existing.trade_count += 1;

    if (trade.pnl > 0) {
      existing.winning_trades += 1;
    } else if (trade.pnl < 0) {
      existing.losing_trades += 1;
    }

    dailyPnlMap.set(dayKey, existing);
  }

  const dailyPnls = Array.from(dailyPnlMap.values())
    .map((entry) => ({
      ...entry,
      pnl: round(entry.pnl),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    avg_win: winningTrades.length > 0 ? round(grossWins / winningTrades.length) : 0,
    avg_loss:
      losingTrades.length > 0
        ? round(losingTrades.reduce((sum, trade) => sum + trade.pnl, 0) / losingTrades.length)
        : 0,
    gross_wins: round(grossWins),
    gross_losses: round(grossLosses),
    current_balance:
      equityCurve.length > 0 ? round(equityCurve[equityCurve.length - 1]) : round(initialBalance),
    // Backtests currently run fixed-size trades, so trade count is the cleanest proxy.
    total_contracts: trades.length,
    trading_days: dailyPnls.length,
    largest_green_day:
      dailyPnls.length > 0 ? round(Math.max(...dailyPnls.map((entry) => entry.pnl))) : 0,
    largest_red_day:
      dailyPnls.length > 0 ? round(Math.min(...dailyPnls.map((entry) => entry.pnl))) : 0,
    daily_pnls: dailyPnls,
  };
}

function getReplayDrawdown(
  equityCurve: number[],
  accountSize: number,
  drawdownType: "intraday" | "eod",
): number {
  if (equityCurve.length < 2) return 0;

  if (drawdownType === "eod") {
    return Math.max(0, ...equityCurve.map((value) => (accountSize - value) / accountSize));
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

export function evaluatePropFirmRules(
  rules: PropFirmRules,
  trades: Trade[],
  equityCurve: number[],
  initialBalance: number,
): PropFirmEvaluation {
  const accountSize = rules.account_size ?? initialBalance;
  const dailyLossLimit = rules.daily_loss_limit ?? 0.04;
  const maxDrawdownLimit = rules.max_drawdown ?? 0.08;
  const profitTarget = rules.profit_target ?? 0.1;
  const consistencyRule = rules.consistency_rule ?? true;
  const consistencyThreshold = rules.consistency_threshold ?? 0.3;
  const drawdownType = rules.drawdown_type ?? "intraday";
  const minTradingDays = rules.min_trading_days ?? null;

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
    (pnl) => pnl < -(accountSize * dailyLossLimit),
  );

  const actualDrawdown = getReplayDrawdown(equityCurve, accountSize, drawdownType);
  const drawdownBreached = actualDrawdown > maxDrawdownLimit;

  const finalBalance =
    equityCurve.length > 0 ? equityCurve[equityCurve.length - 1] : initialBalance;
  const totalProfitPct = accountSize === 0 ? 0 : (finalBalance - accountSize) / accountSize;
  const profitTargetHit = totalProfitPct >= profitTarget;

  let consistencyPassed = true;
  let bestDayProfitPct = 0;
  if (consistencyRule && dailyPnls.size > 0) {
    const totalProfit = finalBalance - accountSize;
    if (totalProfit > 0) {
      const bestDay = Math.max(...dailyPnls.values());
      bestDayProfitPct = bestDay / totalProfit;
      consistencyPassed = bestDayProfitPct <= consistencyThreshold;
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
      daily_loss_limit_pct: dailyLossLimit,
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

function normalizeFirmName(name: string): string {
  return name
    .split(/\s+\d/)[0]
    .trim()
    .replace(/^My Funded Futures (Rapid|Flex)?/i, "My Funded Futures")
    .replace(/^Lucid Trading /i, "Lucid Trading")
    .trim();
}

export function groupPropPresets(
  presets: PropFirmPreset[],
): Record<string, PropFirmPreset[]> {
  return presets.reduce<Record<string, PropFirmPreset[]>>((acc, preset) => {
    const firm = normalizeFirmName(preset.name);
    (acc[firm] ??= []).push(preset);
    acc[firm].sort((a, b) => a.account_size - b.account_size || a.name.localeCompare(b.name));
    return acc;
  }, {});
}

export function findMatchingPresetKey(
  presets: PropFirmPreset[],
  rules: PropFirmRules,
): string | null {
  const found = presets.find((preset) => {
    return (
      preset.name === rules.name &&
      preset.account_size === rules.account_size &&
      preset.daily_loss_limit === rules.daily_loss_limit &&
      preset.max_drawdown === rules.max_drawdown &&
      preset.profit_target === rules.profit_target &&
      preset.consistency_rule === rules.consistency_rule &&
      preset.consistency_threshold === rules.consistency_threshold &&
      preset.drawdown_type === rules.drawdown_type &&
      preset.min_trading_days === rules.min_trading_days
    );
  });

  return found?.key ?? null;
}
