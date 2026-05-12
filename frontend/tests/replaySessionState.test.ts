import test from "node:test";
import assert from "node:assert/strict";

import {
  formatReplaySessionStatus,
  getReplaySessionStatus,
} from "../src/services/replaySessionState.ts";

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
