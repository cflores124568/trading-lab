import test from "node:test";
import assert from "node:assert/strict";

import {
  clampReplayIndex,
  findJumpTarget,
  getReplayIndexFromProgress,
  getReplayProgress,
  simulateReplaySession,
  type ReplayAction,
} from "../src/services/replaySimulator.ts";
import type { Candle, PropFirmRules } from "../src/services/api.ts";

function makeCandles(count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    time: (1_700_000_000 + index * 60) as Candle["time"],
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100 + index,
    volume: 1_000 + index,
  }));
}

const rules: PropFirmRules = {
  name: "Replay Test",
  account_size: 100_000,
  daily_loss_limit: 0.05,
  max_drawdown: 0.1,
  profit_target: 0.1,
  consistency_rule: false,
  consistency_threshold: 0.3,
  drawdown_type: "intraday",
  min_trading_days: null,
};

test("replay helpers clamp indices and progress consistently", () => {
  assert.equal(clampReplayIndex(-10, 12), 0);
  assert.equal(clampReplayIndex(30, 12), 11);
  assert.equal(getReplayProgress(5, 11), 0.5);
  assert.equal(getReplayIndexFromProgress(0.5, 11), 5);
});

test("trade jump targets resolve nearest next and previous indices", () => {
  const targets = [4, 10, 22];
  assert.equal(findJumpTarget(4, targets, "next"), 10);
  assert.equal(findJumpTarget(18, targets, "prev"), 10);
  assert.equal(findJumpTarget(30, targets, "next"), null);
});

test("manual replay session closes and reverses positions correctly", () => {
  const candles = makeCandles(6);
  const actions: ReplayAction[] = [
    { id: "a", barIndex: 1, type: "buy", createdAt: 1 },
    { id: "b", barIndex: 3, type: "sell", createdAt: 2 },
    { id: "c", barIndex: 5, type: "exit", createdAt: 3 },
  ];

  const session = simulateReplaySession({
    candles,
    currentIndex: 5,
    actions,
    initialBalance: 100_000,
    commission: 5,
    tickValue: 10,
    propFirmRules: rules,
  });

  assert.equal(session.trades.length, 2);
  assert.equal(session.trades[0].side, "buy");
  assert.equal(session.trades[0].entry_price, 101);
  assert.equal(session.trades[0].exit_price, 103);
  assert.equal(session.trades[0].pnl, 15);
  assert.equal(session.trades[1].side, "sell");
  assert.equal(session.trades[1].entry_price, 103);
  assert.equal(session.trades[1].exit_price, 105);
  assert.equal(session.trades[1].pnl, -25);
  assert.equal(session.position, null);
  assert.equal(session.balance, 99_990);
  assert.equal(session.metrics.total_trades, 2);
});

test("open positions remain mark-to-market when replay has not exited", () => {
  const candles = makeCandles(4);
  const actions: ReplayAction[] = [{ id: "a", barIndex: 1, type: "buy", createdAt: 1 }];

  const session = simulateReplaySession({
    candles,
    currentIndex: 3,
    actions,
    initialBalance: 100_000,
    commission: 5,
    tickValue: 10,
    propFirmRules: rules,
  });

  assert.equal(session.trades.length, 0);
  assert.equal(session.position?.side, "buy");
  assert.equal(session.unrealizedPnl, 15);
  assert.equal(session.totalPnl, 15);
  assert.equal(session.equityCurve.at(-1), 100_015);
});
