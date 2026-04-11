import type { PropFirmEvaluation, Trade } from "./api";

const MINUTE_MS = 60_000;

export interface ReplayTradeMatch {
  systemTrade: Trade;
  manualTrade: Trade;
  entryDiffMinutes: number;
  exitDiffMinutes: number;
  pnlDiff: number;
  exitedEarly: boolean;
  betterExit: boolean;
}

export interface ReplayPropComparison {
  manualPassed: boolean;
  systemPassed: boolean;
  passDelta: "improved" | "worse" | "same";
  actualProfitPctDiff: number;
  actualDrawdownPctDiff: number;
}

export interface ReplayCompareReport {
  matchedTrades: ReplayTradeMatch[];
  missedSystemTrades: Trade[];
  extraManualTrades: Trade[];
  earlyExitCount: number;
  betterExitCount: number;
  manualOnlyCount: number;
  missedEntryCount: number;
  pnlDiff: number;
  propComparison: ReplayPropComparison;
}

function round(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function getIntervalMs(interval: string | null | undefined): number {
  if (!interval) {
    return 15 * MINUTE_MS;
  }

  const normalized = interval.trim().toLowerCase();
  const match = normalized.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days|w|wk|week|weeks)$/);
  if (!match) {
    return 15 * MINUTE_MS;
  }

  const value = Number(match[1]);
  const unit = match[2];

  if (unit.startsWith("m")) {
    return value * MINUTE_MS;
  }
  if (unit.startsWith("h")) {
    return value * 60 * MINUTE_MS;
  }
  if (unit.startsWith("d")) {
    return value * 24 * 60 * MINUTE_MS;
  }
  return value * 7 * 24 * 60 * MINUTE_MS;
}

function getPropNumber(
  evaluation: PropFirmEvaluation,
  key: "actual_profit_pct" | "actual_drawdown_pct",
): number {
  const raw = evaluation.details?.[key];
  return typeof raw === "number" ? raw : 0;
}

export function compareReplayToBacktest(args: {
  manualTrades: Trade[];
  systemTrades: Trade[];
  interval?: string | null;
  manualPropEvaluation: PropFirmEvaluation;
  systemPropEvaluation: PropFirmEvaluation;
}): ReplayCompareReport {
  const intervalMs = getIntervalMs(args.interval);
  const thresholdMs = Math.max(intervalMs * 3, 15 * MINUTE_MS);
  const earlyExitThresholdMs = Math.max(Math.min(intervalMs / 4, 5 * MINUTE_MS), 1);
  const manualTrades = [...args.manualTrades].sort(
    (a, b) => (parseTime(a.entry_time) ?? 0) - (parseTime(b.entry_time) ?? 0),
  );
  const systemTrades = [...args.systemTrades].sort(
    (a, b) => (parseTime(a.entry_time) ?? 0) - (parseTime(b.entry_time) ?? 0),
  );

  const unusedManualIndices = new Set(manualTrades.map((_, index) => index));
  const matchedTrades: ReplayTradeMatch[] = [];
  const missedSystemTrades: Trade[] = [];

  for (const systemTrade of systemTrades) {
    const systemEntry = parseTime(systemTrade.entry_time);
    if (systemEntry === null) {
      missedSystemTrades.push(systemTrade);
      continue;
    }

    let bestManualIndex: number | null = null;
    let bestEntryDiff = Number.POSITIVE_INFINITY;

    for (const manualIndex of unusedManualIndices) {
      const manualTrade = manualTrades[manualIndex];
      if (manualTrade.side !== systemTrade.side) {
        continue;
      }

      const manualEntry = parseTime(manualTrade.entry_time);
      if (manualEntry === null) {
        continue;
      }

      const entryDiff = Math.abs(manualEntry - systemEntry);
      if (entryDiff > thresholdMs || entryDiff >= bestEntryDiff) {
        continue;
      }

      bestEntryDiff = entryDiff;
      bestManualIndex = manualIndex;
    }

    if (bestManualIndex === null) {
      missedSystemTrades.push(systemTrade);
      continue;
    }

    unusedManualIndices.delete(bestManualIndex);
    const manualTrade = manualTrades[bestManualIndex];
    const manualEntry = parseTime(manualTrade.entry_time) ?? systemEntry;
    const manualExit = parseTime(manualTrade.exit_time);
    const systemExit = parseTime(systemTrade.exit_time);
    const exitDiffMs =
      manualExit !== null && systemExit !== null ? manualExit - systemExit : 0;
    const pnlDiff = round(manualTrade.pnl - systemTrade.pnl);

    matchedTrades.push({
      systemTrade,
      manualTrade,
      entryDiffMinutes: round((manualEntry - systemEntry) / MINUTE_MS),
      exitDiffMinutes: round(exitDiffMs / MINUTE_MS),
      pnlDiff,
      exitedEarly: exitDiffMs < -earlyExitThresholdMs,
      betterExit: pnlDiff > 0.01,
    });
  }

  const extraManualTrades = Array.from(unusedManualIndices)
    .sort((a, b) => a - b)
    .map((index) => manualTrades[index]);

  const manualPassed = args.manualPropEvaluation.passed;
  const systemPassed = args.systemPropEvaluation.passed;

  return {
    matchedTrades,
    missedSystemTrades,
    extraManualTrades,
    earlyExitCount: matchedTrades.filter((trade) => trade.exitedEarly).length,
    betterExitCount: matchedTrades.filter((trade) => trade.betterExit).length,
    manualOnlyCount: extraManualTrades.length,
    missedEntryCount: missedSystemTrades.length,
    pnlDiff: round(
      args.manualTrades.reduce((sum, trade) => sum + trade.pnl, 0) -
        args.systemTrades.reduce((sum, trade) => sum + trade.pnl, 0),
    ),
    propComparison: {
      manualPassed,
      systemPassed,
      passDelta:
        manualPassed === systemPassed
          ? "same"
          : manualPassed
            ? "improved"
            : "worse",
      actualProfitPctDiff: round(
        getPropNumber(args.manualPropEvaluation, "actual_profit_pct") -
          getPropNumber(args.systemPropEvaluation, "actual_profit_pct"),
        4,
      ),
      actualDrawdownPctDiff: round(
        getPropNumber(args.manualPropEvaluation, "actual_drawdown_pct") -
          getPropNumber(args.systemPropEvaluation, "actual_drawdown_pct"),
        4,
      ),
    },
  };
}
