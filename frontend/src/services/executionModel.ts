import type { Candle } from "./api";

export type ExecutionActionType =
  | "lift_ask"
  | "hit_bid"
  | "join_bid"
  | "join_ask"
  | "rest_exit"
  | "replace"
  | "cancel"
  | "flatten";

export type LegacyExecutionActionType = "buy" | "sell" | "exit";

export type ExecutionSide = "buy" | "sell";
export type RestingFillMode = "touch" | "penetrate" | "touch_plus_1_bar";
export type RestingOrderIntent = "entry" | "exit";

export type RestingOrderStatus = "pending" | "filled" | "canceled" | "replaced";

export interface SyntheticQuote {
  bid: number;
  ask: number;
  reference: number;
  spread_ticks: number;
  base_spread_ticks: number;
  volatility_spread_ticks: number;
  bar_range_ticks: number;
  is_volatile: boolean;
  tick_size: number;
}

export interface RestingOrder {
  id: string;
  intent: RestingOrderIntent;
  side: ExecutionSide;
  price: number;
  submitted_at: string;
  submitted_bar_index: number;
  type: "join_bid" | "join_ask" | "rest_exit";
  status: RestingOrderStatus;
  filled_at?: string;
  filled_bar_index?: number;
  canceled_at?: string;
  canceled_bar_index?: number;
  replaced_at?: string;
  replaced_bar_index?: number;
  replaced_by_order_id?: string;
  parent_order_id?: string;
  replaces_order_id?: string;
  replace_count?: number;
  first_touch_at?: string;
  first_touch_bar_index?: number;
}

export interface ExecutionEvent {
  id: string;
  type:
    | "taker_fill"
    | "resting_submitted"
    | "resting_filled"
    | "resting_canceled"
    | "resting_replaced"
    | "flatten"
    | "ignored";
  action: ExecutionActionType | LegacyExecutionActionType;
  side?: ExecutionSide;
  price?: number;
  bar_index: number;
  time: string;
  order_id?: string;
  replaced_order_id?: string;
  reason?: string;
}

export interface ExecutionConfig {
  tickSize: number;
  spreadTicks: number;
  volatileBarThresholdTicks: number;
  volatileBarExtraTicks: number;
  restingFillMode: RestingFillMode;
}

export const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = {
  tickSize: 0.25,
  spreadTicks: 1,
  volatileBarThresholdTicks: 0,
  volatileBarExtraTicks: 0,
  restingFillMode: "touch",
};

const SYMBOL_EXECUTION_DEFAULTS: Record<string, Omit<ExecutionConfig, "tickSize">> = {
  ES: {
    spreadTicks: 1,
    volatileBarThresholdTicks: 8,
    volatileBarExtraTicks: 1,
    restingFillMode: "touch",
  },
  MES: {
    spreadTicks: 1,
    volatileBarThresholdTicks: 8,
    volatileBarExtraTicks: 1,
    restingFillMode: "touch",
  },
  NQ: {
    spreadTicks: 2,
    volatileBarThresholdTicks: 12,
    volatileBarExtraTicks: 1,
    restingFillMode: "touch",
  },
  MNQ: {
    spreadTicks: 2,
    volatileBarThresholdTicks: 12,
    volatileBarExtraTicks: 1,
    restingFillMode: "touch",
  },
  GC: {
    spreadTicks: 2,
    volatileBarThresholdTicks: 10,
    volatileBarExtraTicks: 1,
    restingFillMode: "touch",
  },
  MGC: {
    spreadTicks: 2,
    volatileBarThresholdTicks: 10,
    volatileBarExtraTicks: 1,
    restingFillMode: "touch",
  },
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

export function normalizeSymbolRoot(symbol?: string | null): string {
  if (!symbol) return "";
  const match = symbol.trim().toUpperCase().match(/^[A-Z]+/);
  return match?.[0] ?? "";
}

export function defaultExecutionConfigForSymbol(symbol?: string | null): Omit<ExecutionConfig, "tickSize"> {
  const root = normalizeSymbolRoot(symbol);
  return SYMBOL_EXECUTION_DEFAULTS[root] ?? {
    spreadTicks: DEFAULT_EXECUTION_CONFIG.spreadTicks,
    volatileBarThresholdTicks: DEFAULT_EXECUTION_CONFIG.volatileBarThresholdTicks,
    volatileBarExtraTicks: DEFAULT_EXECUTION_CONFIG.volatileBarExtraTicks,
    restingFillMode: DEFAULT_EXECUTION_CONFIG.restingFillMode,
  };
}

export function normalizeRestingFillMode(mode?: string | null): RestingFillMode {
  if (mode === "penetrate" || mode === "touch_plus_1_bar") {
    return mode;
  }
  return "touch";
}

export function syntheticQuoteForCandle(
  candle: Candle,
  config: Partial<ExecutionConfig> = {},
): SyntheticQuote {
  const tickSize = config.tickSize && config.tickSize > 0
    ? config.tickSize
    : DEFAULT_EXECUTION_CONFIG.tickSize;
  const baseSpreadTicks = Math.max(1, Math.round(config.spreadTicks ?? DEFAULT_EXECUTION_CONFIG.spreadTicks));
  const volatileBarThresholdTicks = Math.max(
    0,
    Math.round(config.volatileBarThresholdTicks ?? DEFAULT_EXECUTION_CONFIG.volatileBarThresholdTicks),
  );
  const volatileBarExtraTicks = Math.max(
    0,
    Math.round(config.volatileBarExtraTicks ?? DEFAULT_EXECUTION_CONFIG.volatileBarExtraTicks),
  );
  const barRangeTicks = Math.max(0, Math.round((candle.high - candle.low) / tickSize));
  const isVolatile =
    volatileBarThresholdTicks > 0 &&
    volatileBarExtraTicks > 0 &&
    barRangeTicks >= volatileBarThresholdTicks;
  const spreadTicks = baseSpreadTicks + (isVolatile ? volatileBarExtraTicks : 0);
  const reference = roundToTick(candle.close, tickSize);
  const bid = roundPrice(reference - Math.floor(spreadTicks / 2) * tickSize);
  const ask = roundPrice(bid + spreadTicks * tickSize);

  return {
    bid,
    ask,
    reference,
    spread_ticks: spreadTicks,
    base_spread_ticks: baseSpreadTicks,
    volatility_spread_ticks: isVolatile ? volatileBarExtraTicks : 0,
    bar_range_ticks: barRangeTicks,
    is_volatile: isVolatile,
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

export function restingOrderPenetrated(order: RestingOrder, candle: Candle): boolean {
  if (order.status !== "pending") return false;
  if (order.side === "buy") {
    return candle.low < order.price;
  }
  return candle.high > order.price;
}

export function restingOrderFillUpdate(args: {
  order: RestingOrder;
  candle: Candle;
  fillMode?: RestingFillMode;
  barIndex?: number;
  time?: string;
}): { shouldFill: boolean; order: RestingOrder } {
  const fillMode = normalizeRestingFillMode(args.fillMode);
  const nextOrder = { ...args.order };

  if (fillMode === "penetrate") {
    return { shouldFill: restingOrderPenetrated(nextOrder, args.candle), order: nextOrder };
  }

  const touched = restingOrderTouched(nextOrder, args.candle);
  if (fillMode === "touch") {
    return { shouldFill: touched, order: nextOrder };
  }

  if (!touched) {
    return { shouldFill: false, order: nextOrder };
  }

  if (nextOrder.first_touch_bar_index === undefined) {
    if (typeof args.barIndex === "number") {
      nextOrder.first_touch_bar_index = args.barIndex;
    }
    if (args.time) {
      nextOrder.first_touch_at = args.time;
    }
    return { shouldFill: false, order: nextOrder };
  }

  if (
    typeof args.barIndex === "number" &&
    args.barIndex <= nextOrder.first_touch_bar_index
  ) {
    return { shouldFill: false, order: nextOrder };
  }

  return { shouldFill: true, order: nextOrder };
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
  action: "join_bid" | "join_ask" | "rest_exit";
  id: string;
  barIndex: number;
  time: string;
  quote: SyntheticQuote;
  intent?: RestingOrderIntent;
  side?: ExecutionSide;
}): RestingOrder {
  const resolvedSide = args.side ?? (args.action === "join_bid" ? "buy" : "sell");

  return {
    id: args.id,
    intent: args.intent === "exit" ? "exit" : "entry",
    side: resolvedSide,
    price: resolvedSide === "buy" ? args.quote.bid : args.quote.ask,
    submitted_at: args.time,
    submitted_bar_index: args.barIndex,
    type: args.action,
    status: "pending",
  };
}

export function replaceRestingOrder(args: {
  order: RestingOrder;
  newId: string;
  price: number;
  barIndex: number;
  time: string;
}): { replacedOrder: RestingOrder; nextOrder: RestingOrder } {
  const parentOrderId = args.order.parent_order_id ?? args.order.id;
  const replaceCount = (args.order.replace_count ?? 0) + 1;

  const replacedOrder: RestingOrder = {
    ...args.order,
    status: "replaced",
    replaced_at: args.time,
    replaced_bar_index: args.barIndex,
    replaced_by_order_id: args.newId,
    parent_order_id: parentOrderId,
    replace_count: replaceCount,
  };
  delete replacedOrder.filled_at;
  delete replacedOrder.filled_bar_index;
  delete replacedOrder.canceled_at;
  delete replacedOrder.canceled_bar_index;

  const nextOrder: RestingOrder = {
    ...args.order,
    id: args.newId,
    price: roundPrice(args.price),
    submitted_at: args.time,
    submitted_bar_index: args.barIndex,
    status: "pending",
    parent_order_id: parentOrderId,
    replaces_order_id: args.order.id,
    replace_count: replaceCount,
  };
  delete nextOrder.filled_at;
  delete nextOrder.filled_bar_index;
  delete nextOrder.canceled_at;
  delete nextOrder.canceled_bar_index;
  delete nextOrder.replaced_at;
  delete nextOrder.replaced_bar_index;
  delete nextOrder.replaced_by_order_id;
  delete nextOrder.first_touch_at;
  delete nextOrder.first_touch_bar_index;

  return { replacedOrder, nextOrder };
}

function roundPrice(value: number): number {
  return Number(value.toFixed(10));
}
