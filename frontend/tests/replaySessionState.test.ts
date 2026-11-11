import test from "node:test";
import assert from "node:assert/strict";

import {
  captureReplaySnapshot,
  formatReplaySessionStatus,
  getReplaySaveState,
  getReplaySessionStatus,
  restoreReplayReview,
} from "../src/services/replaySessionState.ts";
import { simulateReplaySession, type ReplayAction } from "../src/services/replaySimulator.ts";
import type { Candle, PropFirmRules } from "../src/services/api.ts";

test("replay session status prefers review and completion states in the right order", () => {
  assert.equal(
    getReplaySessionStatus({
      hasLaunch: false,
      isPlaying: false,
      isComplete: false,
      isReviewMode: false,
      isBreached: false,
    }),
    "draft",
  );

  assert.equal(
    getReplaySessionStatus({
      hasLaunch: true,
      isPlaying: true,
      isComplete: false,
      isReviewMode: false,
      isBreached: false,
    }),
    "active",
  );

  assert.equal(
    getReplaySessionStatus({
      hasLaunch: true,
      isPlaying: false,
      isComplete: true,
      isReviewMode: false,
      isBreached: false,
    }),
    "completed",
  );

  assert.equal(
    getReplaySessionStatus({
      hasLaunch: true,
      isPlaying: false,
      isComplete: true,
      isReviewMode: true,
      isBreached: false,
    }),
    "review",
  );

  assert.equal(
    getReplaySessionStatus({
      hasLaunch: true,
      isPlaying: true,
      isComplete: false,
      isReviewMode: false,
      isBreached: true,
    }),
    "breached",
  );
});

test("replay session status labels stay human", () => {
  assert.equal(formatReplaySessionStatus("active"), "Sim Running");
  assert.equal(formatReplaySessionStatus("paused"), "Sim Paused");
  assert.equal(formatReplaySessionStatus("completed"), "Sim Finished");
  assert.equal(formatReplaySessionStatus("review"), "Review Mode");
  assert.equal(formatReplaySessionStatus("breached"), "Account Breached");
  assert.equal(formatReplaySessionStatus("sim_locked"), "Sim Locked");
});

test("saving from before a breach keeps the unlocked review and liquidation outcome", () => {
  const candles: Candle[] = [
    { time: 1 as Candle["time"], open: 100, high: 100.5, low: 99.75, close: 100, volume: 1 },
    { time: 2 as Candle["time"], open: 100, high: 100.25, low: 98.5, close: 99, volume: 1 },
  ];
  const actions: ReplayAction[] = [
    { id: "buy-1", barIndex: 0, type: "lift_ask", createdAt: 1 },
  ];
  const propFirmRules: PropFirmRules = {
    name: "Replay Test",
    account_size: 100_000,
    daily_loss_limit: 0.0001,
    max_drawdown: 0.0001,
    profit_target: 0.1,
    consistency_rule: false,
    consistency_threshold: 0.3,
    drawdown_type: "intraday",
    min_trading_days: null,
  };
  const input = {
    candles, actions, propFirmRules,
    initialBalance: 100_000, commission: 0, tickValue: 10, tickSize: 0.25, spreadTicks: 1,
  };
  const breached = simulateReplaySession({ ...input, currentIndex: 1 });
  const earlier = simulateReplaySession({ ...input, currentIndex: 0 });
  assert.equal(earlier.propEvaluation.daily_loss_breached, false);
  assert.equal(breached.propEvaluation.daily_loss_breached, true);
  assert.equal(breached.trades.length, 1);

  const review = captureReplaySnapshot(breached, "breached");
  const saved = JSON.parse(JSON.stringify({
    ...getReplaySaveState(earlier, "review", review),
    current_bar_index: 0,
  }));
  assert.equal(saved.current_bar_index, 0);
  assert.equal(saved.review_unlocked, true);
  assert.deepEqual(restoreReplayReview(saved), JSON.parse(JSON.stringify(review)));
  assert.equal(restoreReplayReview(review), null);
  assert.deepEqual(restoreReplayReview({ ...review, status: "review" }), { ...review, status: "review" });
  assert.equal(getReplaySaveState(earlier, "paused", null).review_unlocked, false);
});
