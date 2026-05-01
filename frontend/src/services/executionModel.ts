import type { Candle } from "./api";

export type ExecutionActionType =
  | "lift_ask"
  | "hit_bid"
  | "join_bid"
  | "join_ask"
  | "cancel"
  | "flatten";

export type LegacyExecutionActionType = "buy" | "sell" | "exit";

export type ExecutionSide = "buy" | "sell";

export type RestingOrderStatus = "pending" | "filled" | "canceled";

export interface SyntheticQuote {
  bid: number;
  ask: number;
  reference: number;
  spread_ticks: number;
  tick_size: number;
}

export interface RestingOrder {
  id: string;
  side: ExecutionSide;
  price: number;
  submitted_at: string;
  submitted_bar_index: number;
  type: "join_bid" | "join_ask";
  status: RestingOrderStatus;
  filled_at?: string;
  filled_bar_index?: number;
  canceled_at?: string;
  canceled_bar_index?: number;
}

export interface ExecutionEvent {
  id: string;
  type: "taker_fill" | "resting_submitted" | "resting_filled" | "resting_canceled" | "flatten" | "ignored";
  action: ExecutionActionType | LegacyExecutionActionType;
  side?: ExecutionSide;
  price?: number;
  bar_index: number;
  time: string;
  order_id?: string;
  reason?: string;
}

export interface ExecutionConfig {
  tickSize: number;
  spreadTicks: number;
}

export const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = {
  tickSize: 0.25,
  spreadTicks: 1,
};

export function normalizeExecutionAction(
  action: ExecutionActionType | LegacyExecutionActionType,
): ExecutionActionType {
  if (action === "buy") return "lift_ask";
  if (action === "sell") return "hit_bid";
  if (action === "exit") return "flatten";
  return action;
}

export function roundToTick(price: number, tickSize: number): number {
  const safeTick = tickSize > 0 ? tickSize : DEFAULT_EXECUTION_CONFIG.tickSize;
  return roundPrice(Math.round(price / safeTick) * safeTick);
}

export function syntheticQuoteForCandle(
  candle: Candle,
  config: Partial<ExecutionConfig> = {},
): SyntheticQuote {
  const tickSize = config.tickSize && config.tickSize > 0
    ? config.tickSize
    : DEFAULT_EXECUTION_CONFIG.tickSize;
  const spreadTicks = Math.max(1, Math.round(config.spreadTicks ?? DEFAULT_EXECUTION_CONFIG.spreadTicks));
  const reference = roundToTick(candle.close, tickSize);
  const bid = roundPrice(reference - Math.floor(spreadTicks / 2) * tickSize);
  const ask = roundPrice(bid + spreadTicks * tickSize);

  return {
    bid,
    ask,
    reference,
    spread_ticks: spreadTicks,
    tick_size: tickSize,
  };
}

export function restingOrderTouched(order: RestingOrder, candle: Candle): boolean {
  if (order.status !== "pending") return false;
  if (order.side === "buy") {
    return candle.low <= order.price;
  }
  return candle.high >= order.price;
}

export function actionFillPrice(action: ExecutionActionType, quote: SyntheticQuote): number | null {
  if (action === "lift_ask" || action === "flatten") {
    return quote.ask;
  }
  if (action === "hit_bid") {
    return quote.bid;
  }
  return null;
}

export function createRestingOrder(args: {
  action: "join_bid" | "join_ask";
  id: string;
  barIndex: number;
  time: string;
  quote: SyntheticQuote;
}): RestingOrder {
  return {
    id: args.id,
    side: args.action === "join_bid" ? "buy" : "sell",
    price: args.action === "join_bid" ? args.quote.bid : args.quote.ask,
    submitted_at: args.time,
    submitted_bar_index: args.barIndex,
    type: args.action,
    status: "pending",
  };
}

function roundPrice(value: number): number {
  return Number(value.toFixed(10));
}
