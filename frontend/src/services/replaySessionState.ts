import type { ReplaySessionPayload } from "./api";
import { sanitizeReplayMetrics, type ReplaySession } from "./replaySimulator.ts";

export type ReplaySessionStatus = "draft" | "active" | "paused" | "completed" | "review" | "breached";

export type ReplaySnapshot = Pick<ReplaySessionPayload,
  "status" | "active_order" | "active_orders" | "execution_events" |
  "trades" | "metrics" | "prop_firm_eval" | "equity_curve"
>;

export function captureReplaySnapshot(session: ReplaySession, status: ReplaySessionStatus): ReplaySnapshot {
  return {
    status,
    active_order: session.activeOrder ? { ...session.activeOrder } : null,
    active_orders: session.activeOrders.map((order) => ({ ...order })),
    execution_events: session.executionEvents.map((event) => ({ ...event })),
    trades: session.trades,
    metrics: sanitizeReplayMetrics(session.metrics),
    prop_firm_eval: session.propEvaluation,
    equity_curve: session.equityCurve,
  };
}

export function restoreReplayReview(saved: ReplaySnapshot & { review_unlocked?: boolean }): ReplaySnapshot | null {
  if (!saved.review_unlocked && saved.status !== "review") {
    return null;
  }
  const { status, active_order, active_orders, execution_events, trades, metrics, prop_firm_eval, equity_curve } = saved;
  return { status, active_order, active_orders, execution_events, trades, metrics, prop_firm_eval, equity_curve };
}

export function getReplaySaveState(session: ReplaySession, status: ReplaySessionStatus, review: ReplaySnapshot | null) {
  return {
    ...(review ?? captureReplaySnapshot(session, status)),
    review_unlocked: review !== null,
  };
}

export function getReplaySessionStatus(input: {
  hasLaunch: boolean;
  isPlaying: boolean;
  isComplete: boolean;
  isReviewMode: boolean;
  isBreached: boolean;
}): ReplaySessionStatus {
  if (!input.hasLaunch) {
    return "draft";
  }

  if (input.isReviewMode) {
    return "review";
  }

  if (input.isBreached) {
    return "breached";
  }

  if (input.isPlaying) {
    return "active";
  }

  if (input.isComplete) {
    return "completed";
  }

  return "paused";
}

export function formatReplaySessionStatus(status: string): string {
  if (status === "active") {
    return "Sim Running";
  }

  if (status === "paused") {
    return "Sim Paused";
  }

  if (status === "completed") {
    return "Sim Finished";
  }

  if (status === "review") {
    return "Review Mode";
  }

  if (status === "breached") {
    return "Account Breached";
  }

  if (status === "draft") {
    return "Draft";
  }

  return status
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}
