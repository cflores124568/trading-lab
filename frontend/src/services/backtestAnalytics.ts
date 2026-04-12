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

export interface PayoutPolicy {
  label: string;
  cadence_label: string;
  eligible_profit_mode: "net_profit" | "profit_over_buffer";
  request_pct: number;
  min_payout: number;
  max_payout?: number;
  min_calendar_days_from_first_trade?: number;
  winning_days_required?: number;
  winning_day_profit?: number;
  min_profit_goal?: number;
  consistency_threshold?: number;
  buffer_balance?: number;
  assumptions: string[];
}

export interface PayoutEstimate {
  supported: boolean;
  eligible: boolean;
  policy_label: string;
  cadence_label: string;
  estimated_payout: number;
  eligible_profit: number;
  request_pct: number;
  min_payout: number;
  max_payout?: number;
  winning_days_hit: number;
  winning_days_required?: number;
  winning_day_profit?: number;
  min_profit_goal?: number;
  buffer_balance?: number;
  remaining_to_buffer: number;
  calendar_days_elapsed: number;
  blocked_by: string[];
  assumptions: string[];
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

function getFirstTradeTime(trades: Trade[]): number | null {
  const timestamps = trades
    .map((trade) => Date.parse(trade.entry_time))
    .filter((value) => Number.isFinite(value));

  return timestamps.length > 0 ? Math.min(...timestamps) : null;
}

function getLastTradeTime(trades: Trade[]): number | null {
  const timestamps = trades
    .map((trade) => Date.parse(trade.exit_time || trade.entry_time))
    .filter((value) => Number.isFinite(value));

  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function getMffBufferBalance(accountSize: number): number | undefined {
  return {
    50_000: 52_100,
    100_000: 103_100,
    150_000: 154_600,
  }[accountSize];
}

function getLucidProBufferBalance(accountSize: number): number | undefined {
  return {
    50_000: 52_100,
    100_000: 103_100,
    150_000: 154_600,
  }[accountSize];
}

function getLucidProMinProfitGoal(accountSize: number): number | undefined {
  return {
    25_000: 250,
    50_000: 500,
    100_000: 750,
    150_000: 1_000,
  }[accountSize];
}

function getLucidProMaxPayout(accountSize: number): number | undefined {
  return {
    25_000: 1_000,
    50_000: 2_000,
    100_000: 2_500,
    150_000: 3_000,
  }[accountSize];
}

function getLucidFlexWinningDayTarget(accountSize: number): number | undefined {
  return {
    25_000: 100,
    50_000: 150,
    100_000: 200,
    150_000: 250,
  }[accountSize];
}

function getLucidFlexMaxPayout(accountSize: number): number | undefined {
  return {
    25_000: 1_000,
    50_000: 2_000,
    100_000: 2_500,
    150_000: 3_000,
  }[accountSize];
}

function getMffFlexWinningDayTarget(accountSize: number): number | undefined {
  return {
    25_000: 100,
    50_000: 150,
  }[accountSize];
}

function getMffFlexMaxPayout(accountSize: number): number | undefined {
  return {
    25_000: 3_000,
    50_000: 5_000,
  }[accountSize];
}

export function resolvePayoutPolicy(
  presetKey: string | null,
  rules: PropFirmRules,
): PayoutPolicy | null {
  const accountSize = rules.account_size;

  if (presetKey?.startsWith("topstep_")) {
    return {
      label: "Topstep funded payout estimate",
      cadence_label: "5 winning days",
      eligible_profit_mode: "net_profit",
      request_pct: 0.5,
      max_payout: 5_000,
      min_payout: 0,
      winning_days_required: 5,
      winning_day_profit: 150,
      assumptions: [
        "Uses the funded-account 5 winning day path from Topstep's current payout policy.",
        "Treats modeled net profit as the payout balance proxy inside this simulator.",
      ],
    };
  }

  if (presetKey?.startsWith("mff_rapid_")) {
    const bufferBalance = getMffBufferBalance(accountSize);
    return {
      label: "MFF Rapid first payout estimate",
      cadence_label: "24h after first trade",
      eligible_profit_mode: "profit_over_buffer",
      request_pct: 0.9,
      min_payout: 500,
      min_calendar_days_from_first_trade: 1,
      buffer_balance: bufferBalance,
      assumptions: [
        "Models the current Rapid sim-funded rules from the official payout overview.",
        "Estimates payout from profit above the required buffer and applies the 90% trader share.",
      ],
    };
  }

  if (presetKey?.startsWith("mff_flex_")) {
    const winningDayProfit = getMffFlexWinningDayTarget(accountSize);
    const maxPayout = getMffFlexMaxPayout(accountSize);
    if (!winningDayProfit || !maxPayout) {
      return null;
    }

    return {
      label: "MFF Flex first payout estimate",
      cadence_label: "5 winning days",
      eligible_profit_mode: "net_profit",
      request_pct: 0.5,
      min_payout: 250,
      max_payout: maxPayout,
      winning_days_required: 5,
      winning_day_profit: winningDayProfit,
      assumptions: [
        "Uses the current Flex first-payout rule set from the official payout overview.",
        "Treats the request cap as 50% of modeled net profit, capped by the plan maximum.",
      ],
    };
  }

  if (presetKey?.startsWith("lucid_pro_")) {
    const bufferBalance = getLucidProBufferBalance(accountSize);
    const minProfitGoal = getLucidProMinProfitGoal(accountSize);
    const maxPayout = getLucidProMaxPayout(accountSize);
    if (!bufferBalance || !minProfitGoal || !maxPayout) {
      return null;
    }

    return {
      label: "LucidPro first payout estimate",
      cadence_label: "Any day after objectives",
      eligible_profit_mode: "profit_over_buffer",
      request_pct: 1,
      min_payout: 500,
      max_payout: maxPayout,
      min_profit_goal: minProfitGoal,
      consistency_threshold: 0.4,
      buffer_balance: bufferBalance,
      assumptions: [
        "Uses payout 1 limits from LucidPro's official payout article.",
        "Assumes this is the first payout cycle and excludes compliance or manual review checks.",
      ],
    };
  }

  if (presetKey?.startsWith("lucid_flex_")) {
    const winningDayProfit = getLucidFlexWinningDayTarget(accountSize);
    const maxPayout = getLucidFlexMaxPayout(accountSize);
    if (!winningDayProfit || !maxPayout) {
      return null;
    }

    return {
      label: "LucidFlex payout estimate",
      cadence_label: "Any day after objectives",
      eligible_profit_mode: "net_profit",
      request_pct: 0.5,
      min_payout: 500,
      max_payout: maxPayout,
      winning_days_required: 5,
      winning_day_profit: winningDayProfit,
      assumptions: [
        "Uses the current LucidFlex payout article.",
        "Caps the request at 50% of modeled profit up to the plan maximum.",
      ],
    };
  }

  return null;
}

export function estimateFirstPayout(args: {
  payoutPolicy: PayoutPolicy | null;
  rules: PropFirmRules;
  trades: Trade[];
  summary: TradeAnalyticsSummary;
}): PayoutEstimate {
  const { payoutPolicy, rules, trades, summary } = args;

  if (!payoutPolicy) {
    return {
      supported: false,
      eligible: false,
      policy_label: "Payout estimate unavailable",
      cadence_label: "Not modeled for this preset",
      estimated_payout: 0,
      eligible_profit: 0,
      request_pct: 0,
      min_payout: 0,
      winning_days_hit: 0,
      remaining_to_buffer: 0,
      calendar_days_elapsed: 0,
      blocked_by: [
        "This preset doesn't have a payout model wired in yet, so I'd rather show nothing than fake it.",
      ],
      assumptions: [
        "Current payout support is modeled for Topstep, MFF Rapid/Flex, LucidPro, and LucidFlex first-payout flows.",
      ],
    };
  }

  const netProfit = round(summary.current_balance - rules.account_size);
  const firstTradeTime = getFirstTradeTime(trades);
  const lastTradeTime = getLastTradeTime(trades);
  const calendarDaysElapsed =
    firstTradeTime !== null && lastTradeTime !== null
      ? Math.max(0, Math.floor((lastTradeTime - firstTradeTime) / 86_400_000))
      : 0;
  const winningDaysHit = payoutPolicy.winning_day_profit
    ? summary.daily_pnls.filter((entry) => entry.pnl >= payoutPolicy.winning_day_profit!).length
    : 0;

  const eligibleProfit =
    payoutPolicy.eligible_profit_mode === "profit_over_buffer"
      ? round(
          Math.max(0, summary.current_balance - (payoutPolicy.buffer_balance ?? summary.current_balance)),
        )
      : round(Math.max(0, netProfit));

  const rawEstimate = eligibleProfit * payoutPolicy.request_pct;
  const cappedEstimate = payoutPolicy.max_payout
    ? Math.min(rawEstimate, payoutPolicy.max_payout)
    : rawEstimate;
  const estimatedPayout = round(Math.max(0, cappedEstimate));
  const blockedBy: string[] = [];

  if (netProfit <= 0) {
    blockedBy.push("Need positive net profit in the payout cycle.");
  }

  if (
    payoutPolicy.min_calendar_days_from_first_trade !== undefined &&
    calendarDaysElapsed < payoutPolicy.min_calendar_days_from_first_trade
  ) {
    blockedBy.push(
      `Need ${payoutPolicy.min_calendar_days_from_first_trade} day(s) from the first trade before a request is allowed.`,
    );
  }

  if (
    payoutPolicy.winning_days_required !== undefined &&
    payoutPolicy.winning_day_profit !== undefined &&
    winningDaysHit < payoutPolicy.winning_days_required
  ) {
    blockedBy.push(
      `Need ${payoutPolicy.winning_days_required} winning day(s) of at least $${payoutPolicy.winning_day_profit}.`,
    );
  }

  if (
    payoutPolicy.min_profit_goal !== undefined &&
    netProfit < payoutPolicy.min_profit_goal
  ) {
    blockedBy.push(`Need at least $${payoutPolicy.min_profit_goal} net profit this payout cycle.`);
  }

  if (
    payoutPolicy.consistency_threshold !== undefined &&
    netProfit > 0 &&
    summary.largest_green_day / netProfit > payoutPolicy.consistency_threshold
  ) {
    blockedBy.push(
      `Largest green day is above the ${Math.round(payoutPolicy.consistency_threshold * 100)}% consistency limit.`,
    );
  }

  if (
    payoutPolicy.buffer_balance !== undefined &&
    summary.current_balance < payoutPolicy.buffer_balance
  ) {
    blockedBy.push(
      `Need to hold the buffer balance at $${payoutPolicy.buffer_balance.toLocaleString()}.`,
    );
  }

  if (estimatedPayout < payoutPolicy.min_payout) {
    blockedBy.push(`Need at least a $${payoutPolicy.min_payout} payout amount to request it.`);
  }

  return {
    supported: true,
    eligible: blockedBy.length === 0,
    policy_label: payoutPolicy.label,
    cadence_label: payoutPolicy.cadence_label,
    estimated_payout: estimatedPayout,
    eligible_profit: eligibleProfit,
    request_pct: payoutPolicy.request_pct,
    min_payout: payoutPolicy.min_payout,
    max_payout: payoutPolicy.max_payout,
    winning_days_hit: winningDaysHit,
    winning_days_required: payoutPolicy.winning_days_required,
    winning_day_profit: payoutPolicy.winning_day_profit,
    min_profit_goal: payoutPolicy.min_profit_goal,
    buffer_balance: payoutPolicy.buffer_balance,
    remaining_to_buffer:
      payoutPolicy.buffer_balance !== undefined
        ? round(Math.max(0, payoutPolicy.buffer_balance - summary.current_balance))
        : 0,
    calendar_days_elapsed: calendarDaysElapsed,
    blocked_by: blockedBy,
    assumptions: payoutPolicy.assumptions,
  };
}
