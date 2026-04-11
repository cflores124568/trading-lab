import test from "node:test";
import assert from "node:assert/strict";

import { compareReplayToBacktest } from "../src/services/replayComparison.ts";
import type { PropFirmEvaluation, Trade } from "../src/services/api.ts";

function trade(args: {
  trade_id: number;
  side: "buy" | "sell";
  entry_time: string;
  exit_time: string;
  entry_price: number;
  exit_price: number;
  pnl: number;
}): Trade {
  return {
    ...args,
    status: "closed",
    commission: 5,
  };
}

function propEval(args: {
  passed: boolean;
  actual_profit_pct: number;
  actual_drawdown_pct: number;
}): PropFirmEvaluation {
  return {
    passed: args.passed,
    daily_loss_breached: false,
    drawdown_breached: false,
    profit_target_hit: args.actual_profit_pct > 0,
    consistency_passed: true,
    min_trading_days_passed: true,
    details: {
      actual_profit_pct: args.actual_profit_pct,
      actual_drawdown_pct: args.actual_drawdown_pct,
    },
  };
}

test("compareReplayToBacktest matches nearby trades and counts the gaps", () => {
  const systemTrades: Trade[] = [
    trade({
      trade_id: 1,
      side: "buy",
      entry_time: "2026-04-01T09:30:00.000Z",
      exit_time: "2026-04-01T09:45:00.000Z",
      entry_price: 100,
      exit_price: 101,
      pnl: 10,
    }),
    trade({
      trade_id: 2,
      side: "sell",
      entry_time: "2026-04-01T10:30:00.000Z",
      exit_time: "2026-04-01T10:45:00.000Z",
      entry_price: 102,
      exit_price: 103,
      pnl: -5,
    }),
    trade({
      trade_id: 3,
      side: "buy",
      entry_time: "2026-04-01T11:30:00.000Z",
      exit_time: "2026-04-01T11:45:00.000Z",
      entry_price: 104,
      exit_price: 105,
      pnl: 8,
    }),
  ];

  const manualTrades: Trade[] = [
    trade({
      trade_id: 10,
      side: "buy",
      entry_time: "2026-04-01T09:35:00.000Z",
      exit_time: "2026-04-01T09:40:00.000Z",
      entry_price: 100.5,
      exit_price: 102,
      pnl: 15,
    }),
    trade({
      trade_id: 11,
      side: "sell",
      entry_time: "2026-04-01T10:32:00.000Z",
      exit_time: "2026-04-01T10:55:00.000Z",
      entry_price: 102.5,
      exit_price: 103.5,
      pnl: -10,
    }),
    trade({
      trade_id: 12,
      side: "buy",
      entry_time: "2026-04-01T13:00:00.000Z",
      exit_time: "2026-04-01T13:15:00.000Z",
      entry_price: 106,
      exit_price: 107,
      pnl: 6,
    }),
  ];

  const report = compareReplayToBacktest({
    manualTrades,
    systemTrades,
    interval: "15min",
    manualPropEvaluation: propEval({
      passed: true,
      actual_profit_pct: 0.03,
      actual_drawdown_pct: 0.01,
    }),
    systemPropEvaluation: propEval({
      passed: false,
      actual_profit_pct: 0.01,
      actual_drawdown_pct: 0.015,
    }),
  });

  assert.equal(report.matchedTrades.length, 2);
  assert.equal(report.missedEntryCount, 1);
  assert.equal(report.manualOnlyCount, 1);
  assert.equal(report.earlyExitCount, 1);
  assert.equal(report.betterExitCount, 1);
  assert.equal(report.pnlDiff, -2);
  assert.equal(report.propComparison.passDelta, "improved");
  assert.equal(report.propComparison.actualProfitPctDiff, 0.02);
  assert.equal(report.propComparison.actualDrawdownPctDiff, -0.005);

  assert.equal(report.matchedTrades[0].entryDiffMinutes, 5);
  assert.equal(report.matchedTrades[0].exitDiffMinutes, -5);
  assert.equal(report.matchedTrades[0].betterExit, true);
});

test("compareReplayToBacktest keeps pass delta flat when both outcomes match", () => {
  const report = compareReplayToBacktest({
    manualTrades: [],
    systemTrades: [],
    interval: "1h",
    manualPropEvaluation: propEval({
      passed: false,
      actual_profit_pct: -0.01,
      actual_drawdown_pct: 0.02,
    }),
    systemPropEvaluation: propEval({
      passed: false,
      actual_profit_pct: -0.02,
      actual_drawdown_pct: 0.01,
    }),
  });

  assert.equal(report.matchedTrades.length, 0);
  assert.equal(report.missedEntryCount, 0);
  assert.equal(report.manualOnlyCount, 0);
  assert.equal(report.propComparison.passDelta, "same");
  assert.equal(report.propComparison.actualProfitPctDiff, 0.01);
});
