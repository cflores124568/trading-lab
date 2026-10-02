import assert from "node:assert/strict";
import test from "node:test";
import { createSeriesSynchronizer, visiblePointCount } from "../src/services/chartSeriesSync.ts";

test("replay advances append newly revealed points without exposing future bars", () => {
  const source = Array.from({ length: 50_000 }, (_, time) => ({ time, value: time * 2 }));
  const replacements: typeof source[] = [];
  const updates: typeof source = [];
  const sync = createSeriesSynchronizer({ setData: (data: typeof source) => replacements.push(data), update: (point: typeof source[number]) => updates.push(point) });
  sync(source, 100);
  sync(source, 101);
  sync(source, 105);
  sync(source, 105);
  assert.equal(replacements.length, 1);
  assert.equal(replacements[0].length, 100);
  assert.deepEqual(updates.map((point) => point.time), [100, 101, 102, 103, 104]);
});

test("rewinds, corrected data and empty windows replace the visible prefix", () => {
  const source = [{ time: 1, value: 10 }, { time: 2, value: 20 }, { time: 3, value: 30 }];
  let shown: typeof source = [];
  const sync = createSeriesSynchronizer({ setData: (data: typeof source) => { shown = data; }, update: (point: typeof source[number]) => shown.push(point) });
  sync(source);
  sync(source, 1);
  assert.deepEqual(shown, [source[0]]);
  const corrected = [{ time: 1, value: 99 }, source[1]];
  sync(corrected);
  assert.deepEqual(shown, corrected);
  sync(corrected, 0);
  assert.deepEqual(shown, []);
  sync(corrected, 10);
  assert.deepEqual(shown, corrected);
  assert.equal(corrected.length, 2);
});

test("indicator cutoff includes the current candle and excludes future values", () => {
  const points = [{ time: 10 }, { time: 20 }, { time: 30 }];
  assert.equal(visiblePointCount([], 20), 0);
  assert.equal(visiblePointCount(points, 5), 0);
  assert.equal(visiblePointCount(points, 20), 2);
  assert.equal(visiblePointCount(points, 29), 2);
  assert.equal(visiblePointCount(points, Infinity), 3);
});
