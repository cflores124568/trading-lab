import test from "node:test";
import assert from "node:assert/strict";
import { validateSessionStrategyGrid } from "../src/services/strategyValidation.ts";
import { STRATEGY_PARAMS } from "../src/constants.ts";

test("new strategy defaults pass on supported intervals", () => {
  for (const strategy of ["orb", "vwap_mean_reversion"] as const) {
    const grid = Object.fromEntries(STRATEGY_PARAMS[strategy].map((param) => [param.key, [param.default]]));
    assert.equal(validateSessionStrategyGrid(strategy, grid, ["1min", "5min", "15min"]), null);
  }
});

test("ORB checks every opening range against every selected interval", () => {
  assert.equal(validateSessionStrategyGrid("orb", { opening_range_minutes: [15, 30] }, ["5min", "15min"]), null);
  assert.match(validateSessionStrategyGrid("orb", { opening_range_minutes: [15, 30] }, ["5min", "10min"])!, /multiple/);
  assert.match(validateSessionStrategyGrid("orb", {}, ["1d"])!, /intraday/);
});

test("all clock combinations must describe a valid same-day session", () => {
  assert.match(validateSessionStrategyGrid("orb", { session_start: [930, 1260] }, ["1min"])!, /HHMM/);
  assert.match(validateSessionStrategyGrid("orb", { session_start: [930, 1500], session_end: [1200, 1600] }, ["1min"])!, /after/);
  assert.match(validateSessionStrategyGrid("orb", { opening_range_minutes: [15, 390] }, ["1min"])!, /shorter/);
});

test("session open must align with source buckets", () => {
  assert.match(validateSessionStrategyGrid("vwap_mean_reversion", {}, ["1h"])!, /align/);
  assert.equal(validateSessionStrategyGrid("vwap_mean_reversion", { session_start: [900] }, ["1h"]), null);
});

test("VWAP grids reject invalid distances, warmup and conflicting alignment", () => {
  assert.match(validateSessionStrategyGrid("vwap_mean_reversion", { entry_deviation_percent: [0] }, ["1min"])!, /at least/);
  assert.match(validateSessionStrategyGrid("vwap_mean_reversion", { entry_deviation_percent: [Infinity] }, ["1min"])!, /finite/);
  assert.match(validateSessionStrategyGrid("vwap_mean_reversion", { warmup_minutes: [390] }, ["1min"])!, /shorter/);
  assert.match(validateSessionStrategyGrid("vwap_mean_reversion", { vwap_bias: [0, 1] }, ["1min"])!, /blocks/);
});

test("existing strategy validation is unaffected", () => {
  assert.equal(validateSessionStrategyGrid("ema_crossover", {}, ["1d"]), null);
});
