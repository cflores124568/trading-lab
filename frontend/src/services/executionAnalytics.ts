import type { Candle, PaperEventResult, Trade } from "./api";
import {
  normalizeExecutionAction,
  syntheticQuoteForCandle,
  type ExecutionConfig,
  type ExecutionEvent,
  type ExecutionSide,
} from "./executionModel.ts";

export type LiquidityRole = "maker" | "taker";
export type FillRole = "entry" | "exit";

export interface ExecutionFillAnalytics {
  id: string;
  role: FillRole;
  liquidity: LiquidityRole;
  side: ExecutionSide;
  price: number;
  time: string;
  barIndex: number | null;
  referencePrice: number | null;
  slippageTicks: number | null;
  tradeId?: number;
}

export interface ExecutionAnalyticsSummary {
  totalFills: number;
  totalEntries: number;
  totalExits: number;
  makerEntries: number;
  takerEntries: number;
  makerExits: number;
  takerExits: number;
  avgEntrySlippageTicks: number | null;
  avgExitSlippageTicks: number | null;
  avgOneBarMarkoutTicks: number | null;
  avgThreeBarMarkoutTicks: number | null;
  avgMaeTicks: number | null;
  avgMfeTicks: number | null;
  worstMaeTicks: number | null;
}

export interface ExecutionTapeRow {
  id: string;
  time: string;
  category: "fill" | "order" | "system";
  role: FillRole | "n/a";
  liquidity: LiquidityRole | "n/a";
  action: string;
  side: ExecutionSide | null;
  price: number | null;
  referencePrice: number | null;
  slippageTicks: number | null;
  note: string | null;
}

export interface ExecutionAnalyticsResult {
  fills: ExecutionFillAnalytics[];
  summary: ExecutionAnalyticsSummary;
  tape: ExecutionTapeRow[];
}

interface ReplayTradeMatch {
  trade: Trade;
  entryFill: ExecutionFillAnalytics | null;
  exitFill: ExecutionFillAnalytics | null;
}

interface ReplayFillCandidate extends ExecutionFillAnalytics {
  eventType: ExecutionEvent["type"];
}

interface PaperFillCandidate extends ExecutionFillAnalytics {
  eventType: string;
}

function round(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

function safeMean(values: Array<number | null | undefined>, digits = 2): number | null {
  const filtered = values.filter((value): value is number => value !== null && value !== undefined);
  if (filtered.length === 0) {
    return null;
  }
  return round(filtered.reduce((sum, value) => sum + value, 0) / filtered.length, digits);
}

function executionSideForExit(tradeSide: Trade["side"]): ExecutionSide {
  return tradeSide === "buy" ? "sell" : "buy";
}

function directionalSlippageTicks(
  side: ExecutionSide,
  fillPrice: number,
  referencePrice: number | null,
  tickSize: number,
): number | null {
  if (referencePrice === null || tickSize <= 0) {
    return null;
  }

  const signedTicks =
    side === "buy"
      ? (fillPrice - referencePrice) / tickSize
      : (referencePrice - fillPrice) / tickSize;
  return round(signedTicks, 2);
}

function fillLiquidityFromReplayEvent(event: ExecutionEvent): LiquidityRole | null {
  if (event.type === "resting_filled") {
    return "maker";
  }
  if (event.type === "taker_fill" || event.type === "flatten") {
    return "taker";
  }
  return null;
}

function normalizeReplayActionLabel(event: ExecutionEvent): string {
  return normalizeExecutionAction(event.action).replace(/_/g, " ");
}

function findReplayReferencePrice(
  event: ExecutionEvent,
  candles: Candle[],
  executionConfig: ExecutionConfig,
): number | null {
  if (event.bar_index < 0 || event.bar_index >= candles.length) {
    return null;
  }
  return syntheticQuoteForCandle(candles[event.bar_index], executionConfig).reference;
}

function approxEqual(left: number | undefined | null, right: number | undefined | null, epsilon = 0.0001): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return Math.abs(left - right) <= epsilon;
}

function buildEmptySummary(): ExecutionAnalyticsSummary {
  return {
    totalFills: 0,
    totalEntries: 0,
    totalExits: 0,
    makerEntries: 0,
    takerEntries: 0,
    makerExits: 0,
    takerExits: 0,
    avgEntrySlippageTicks: null,
    avgExitSlippageTicks: null,
    avgOneBarMarkoutTicks: null,
    avgThreeBarMarkoutTicks: null,
    avgMaeTicks: null,
    avgMfeTicks: null,
    worstMaeTicks: null,
  };
}

function summarizeFillMix(fills: ExecutionFillAnalytics[]): Pick<
  ExecutionAnalyticsSummary,
  | "totalFills"
  | "totalEntries"
  | "totalExits"
  | "makerEntries"
  | "takerEntries"
  | "makerExits"
  | "takerExits"
  | "avgEntrySlippageTicks"
  | "avgExitSlippageTicks"
> {
  const entries = fills.filter((fill) => fill.role === "entry");
  const exits = fills.filter((fill) => fill.role === "exit");

  return {
    totalFills: fills.length,
    totalEntries: entries.length,
    totalExits: exits.length,
    makerEntries: entries.filter((fill) => fill.liquidity === "maker").length,
    takerEntries: entries.filter((fill) => fill.liquidity === "taker").length,
    makerExits: exits.filter((fill) => fill.liquidity === "maker").length,
    takerExits: exits.filter((fill) => fill.liquidity === "taker").length,
    avgEntrySlippageTicks: safeMean(entries.map((fill) => fill.slippageTicks)),
    avgExitSlippageTicks: safeMean(exits.map((fill) => fill.slippageTicks)),
  };
}

function buildReplayFillCandidates(args: {
  candles: Candle[];
  executionEvents: ExecutionEvent[];
  executionConfig: ExecutionConfig;
  tickSize: number;
}): ReplayFillCandidate[] {
  const { candles, executionEvents, executionConfig, tickSize } = args;

  return executionEvents.flatMap((event) => {
    const liquidity = fillLiquidityFromReplayEvent(event);
    if (!liquidity || event.price === undefined) {
      return [];
    }

    const referencePrice = findReplayReferencePrice(event, candles, executionConfig);
    return [
      {
        id: event.id,
        eventType: event.type,
        role: "entry",
        liquidity,
        side: (event.side ?? "buy") as ExecutionSide,
        price: event.price,
        time: event.time,
        barIndex: event.bar_index,
        referencePrice,
        slippageTicks:
          event.side && referencePrice !== null
            ? directionalSlippageTicks(event.side, event.price, referencePrice, tickSize)
            : null,
      },
    ];
  });
}

function findReplayTradeEntryFill(
  trade: Trade,
  fillCandidates: ReplayFillCandidate[],
): ReplayFillCandidate | null {
  return (
    fillCandidates.find(
      (candidate) =>
        candidate.time === trade.entry_time &&
        candidate.side === trade.side &&
        approxEqual(candidate.price, trade.entry_price),
    ) ?? null
  );
}

function findReplayTradeExitFill(
  trade: Trade,
  fillCandidates: ReplayFillCandidate[],
): ReplayFillCandidate | null {
  const expectedSide = executionSideForExit(trade.side);
  return (
    fillCandidates.find(
      (candidate) =>
        candidate.time === trade.exit_time &&
        approxEqual(candidate.price, trade.exit_price) &&
        (candidate.eventType === "flatten" || candidate.side === expectedSide),
    ) ?? null
  );
}

function replayTradeExcursion(args: {
  trade: Trade;
  entryBarIndex: number | null;
  exitBarIndex: number | null;
  candles: Candle[];
  tickSize: number;
}): { maeTicks: number | null; mfeTicks: number | null } {
  const { trade, entryBarIndex, exitBarIndex, candles, tickSize } = args;
  if (
    tickSize <= 0 ||
    entryBarIndex === null ||
    exitBarIndex === null ||
    entryBarIndex < 0 ||
    exitBarIndex < entryBarIndex
  ) {
    return { maeTicks: null, mfeTicks: null };
  }

  const window = candles.slice(entryBarIndex, exitBarIndex + 1);
  if (window.length === 0) {
    return { maeTicks: null, mfeTicks: null };
  }

  const maxHigh = Math.max(...window.map((candle) => candle.high));
  const minLow = Math.min(...window.map((candle) => candle.low));
  if (trade.side === "buy") {
    return {
      maeTicks: round(Math.max(0, (trade.entry_price - minLow) / tickSize), 2),
      mfeTicks: round(Math.max(0, (maxHigh - trade.entry_price) / tickSize), 2),
    };
  }

  return {
    maeTicks: round(Math.max(0, (maxHigh - trade.entry_price) / tickSize), 2),
    mfeTicks: round(Math.max(0, (trade.entry_price - minLow) / tickSize), 2),
  };
}

function replayTradeMarkoutTicks(args: {
  trade: Trade;
  entryBarIndex: number | null;
  candles: Candle[];
  barsForward: number;
  tickSize: number;
}): number | null {
  const { trade, entryBarIndex, candles, barsForward, tickSize } = args;
  if (tickSize <= 0 || entryBarIndex === null) {
    return null;
  }

  const target = candles[entryBarIndex + barsForward];
  if (!target) {
    return null;
  }

  const signedTicks =
    trade.side === "buy"
      ? (target.close - trade.entry_price) / tickSize
      : (trade.entry_price - target.close) / tickSize;
  return round(signedTicks, 2);
}

function buildReplayTapeRows(args: {
  executionEvents: ExecutionEvent[];
  candles: Candle[];
  executionConfig: ExecutionConfig;
  tickSize: number;
}): ExecutionTapeRow[] {
  const { executionEvents, candles, executionConfig, tickSize } = args;

  return executionEvents.map((event) => {
    const liquidity = fillLiquidityFromReplayEvent(event);
    const referencePrice = event.price === undefined ? null : findReplayReferencePrice(event, candles, executionConfig);
    const slippageTicks =
      liquidity && event.side && event.price !== undefined
        ? directionalSlippageTicks(event.side, event.price, referencePrice, tickSize)
        : null;
    const role: FillRole | "n/a" =
      event.type === "resting_filled" || event.type === "taker_fill" || event.type === "flatten"
        ? event.type === "flatten"
          ? "exit"
          : "entry"
        : "n/a";

    return {
      id: event.id,
      time: event.time,
      category: liquidity ? "fill" : event.type.includes("resting") ? "order" : "system",
      role,
      liquidity: liquidity ?? "n/a",
      action: normalizeReplayActionLabel(event),
      side: event.side ?? null,
      price: event.price ?? null,
      referencePrice,
      slippageTicks,
      note: event.reason ?? null,
    };
  });
}

export function buildReplayExecutionAnalytics(args: {
  candles: Candle[];
  trades: Trade[];
  executionEvents: ExecutionEvent[];
  tickSize: number;
  executionConfig: ExecutionConfig;
}): ExecutionAnalyticsResult {
  const { candles, trades, executionEvents, tickSize, executionConfig } = args;
  if (trades.length === 0 && executionEvents.length === 0) {
    return { fills: [], summary: buildEmptySummary(), tape: [] };
  }

  const fillCandidates = buildReplayFillCandidates({
    candles,
    executionEvents,
    executionConfig,
    tickSize,
  });

  const matches: ReplayTradeMatch[] = trades.map((trade) => ({
    trade,
    entryFill: findReplayTradeEntryFill(trade, fillCandidates),
    exitFill: findReplayTradeExitFill(trade, fillCandidates),
  }));

  const fills = matches.flatMap((match) => {
    const tradeFills: ExecutionFillAnalytics[] = [];
    if (match.entryFill) {
      tradeFills.push({
        ...match.entryFill,
        role: "entry",
        tradeId: match.trade.trade_id,
      });
    }
    if (match.exitFill) {
      const exitSide = executionSideForExit(match.trade.side);
      tradeFills.push({
        ...match.exitFill,
        role: "exit",
        side: exitSide,
        slippageTicks:
          match.exitFill.slippageTicks ??
          directionalSlippageTicks(
            exitSide,
            match.exitFill.price,
            match.exitFill.referencePrice,
            tickSize,
          ),
        tradeId: match.trade.trade_id,
      });
    }
    return tradeFills;
  });

  const oneBarMarkouts = matches.map((match) =>
    replayTradeMarkoutTicks({
      trade: match.trade,
      entryBarIndex: match.entryFill?.barIndex ?? null,
      candles,
      barsForward: 1,
      tickSize,
    }),
  );
  const threeBarMarkouts = matches.map((match) =>
    replayTradeMarkoutTicks({
      trade: match.trade,
      entryBarIndex: match.entryFill?.barIndex ?? null,
      candles,
      barsForward: 3,
      tickSize,
    }),
  );
  const excursions = matches.map((match) =>
    replayTradeExcursion({
      trade: match.trade,
      entryBarIndex: match.entryFill?.barIndex ?? null,
      exitBarIndex: match.exitFill?.barIndex ?? null,
      candles,
      tickSize,
    }),
  );
  const fillSummary = summarizeFillMix(fills);

  return {
    fills,
    summary: {
      ...buildEmptySummary(),
      ...fillSummary,
      avgOneBarMarkoutTicks: safeMean(oneBarMarkouts),
      avgThreeBarMarkoutTicks: safeMean(threeBarMarkouts),
      avgMaeTicks: safeMean(excursions.map((entry) => entry.maeTicks)),
      avgMfeTicks: safeMean(excursions.map((entry) => entry.mfeTicks)),
      worstMaeTicks: excursions
        .map((entry) => entry.maeTicks)
        .filter((value): value is number => value !== null)
        .reduce<number | null>((worst, value) => (worst === null ? value : Math.max(worst, value)), null),
    },
    tape: buildReplayTapeRows({ executionEvents, candles, executionConfig, tickSize }),
  };
}

function paperLiquidityFromEventType(eventType: string): LiquidityRole | null {
  if (eventType === "order_filled") {
    return "maker";
  }
  if (eventType === "position_opened" || eventType === "position_closed") {
    return "taker";
  }
  return null;
}

function paperPayloadRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function actionLabelFromEvent(event: PaperEventResult): string {
  const payload = paperPayloadRecord(event.payload);
  const rawAction = stringFromUnknown(payload.action);
  if (rawAction) {
    return rawAction.replace(/_/g, " ");
  }
  return event.event_type.replace(/_/g, " ");
}

function paperEntryFillFromEvent(event: PaperEventResult, tickSize: number): PaperFillCandidate[] {
  const payload = paperPayloadRecord(event.payload);
  const liquidity = paperLiquidityFromEventType(event.event_type);
  if (!liquidity) {
    return [];
  }

  if (event.event_type === "order_filled") {
    const order = paperPayloadRecord(payload.order);
    const quote = paperPayloadRecord(payload.quote);
    const side = stringFromUnknown(order.side) as ExecutionSide | null;
    const price = numberFromUnknown(order.price);
    const referencePrice = numberFromUnknown(quote.reference);
    if (!side || price === null) {
      return [];
    }
    return [
      {
        id: `${event.paper_event_id}:entry`,
        eventType: event.event_type,
        role: "entry",
        liquidity,
        side,
        price,
        time: stringFromUnknown(order.filled_at) ?? event.created_at,
        barIndex: numberFromUnknown(order.filled_bar_index),
        referencePrice,
        slippageTicks: directionalSlippageTicks(side, price, referencePrice, tickSize),
      },
    ];
  }

  if (event.event_type === "position_opened") {
    const side = stringFromUnknown(payload.side) as ExecutionSide | null;
    const price = numberFromUnknown(payload.entry_price);
    const quote = paperPayloadRecord(payload.quote);
    const referencePrice = numberFromUnknown(quote.reference);
    const entryTime = stringFromUnknown(payload.entry_time) ?? event.created_at;
    if (!side || price === null) {
      return [];
    }
    return [
      {
        id: `${event.paper_event_id}:entry`,
        eventType: event.event_type,
        role: "entry",
        liquidity,
        side,
        price,
        time: entryTime,
        barIndex: null,
        referencePrice,
        slippageTicks: directionalSlippageTicks(side, price, referencePrice, tickSize),
      },
    ];
  }

  return [];
}

function paperExitFillFromEvent(
  event: PaperEventResult,
  tradesById: Map<number, Trade>,
  tickSize: number,
): PaperFillCandidate[] {
  const payload = paperPayloadRecord(event.payload);
  const quote = paperPayloadRecord(payload.quote);
  const referencePrice = numberFromUnknown(quote.reference);
  const tradeId = numberFromUnknown(payload.trade_id);

  if (event.event_type === "position_closed") {
    const price = numberFromUnknown(payload.exit_price);
    const trade = tradeId !== null ? tradesById.get(tradeId) ?? null : null;
    if (price === null || !trade) {
      return [];
    }
    const side = executionSideForExit(trade.side);
    return [
      {
        id: `${event.paper_event_id}:exit`,
        eventType: event.event_type,
        role: "exit",
        liquidity: "taker",
        side,
        price,
        time: trade.exit_time,
        barIndex: null,
        referencePrice,
        slippageTicks: directionalSlippageTicks(side, price, referencePrice, tickSize),
        tradeId: tradeId ?? undefined,
      },
    ];
  }

  if (event.event_type === "position_opened") {
    const closedTrade = paperPayloadRecord(payload.closed_trade);
    const closedTradeId = numberFromUnknown(closedTrade.trade_id);
    const price = numberFromUnknown(closedTrade.exit_price);
    const trade = closedTradeId !== null ? tradesById.get(closedTradeId) ?? null : null;
    if (price === null || !trade) {
      return [];
    }
    const side = executionSideForExit(trade.side);
    return [
      {
        id: `${event.paper_event_id}:exit`,
        eventType: "position_reversed",
        role: "exit",
        liquidity: "taker",
        side,
        price,
        time: trade.exit_time,
        barIndex: null,
        referencePrice,
        slippageTicks: directionalSlippageTicks(side, price, referencePrice, tickSize),
        tradeId: closedTradeId ?? undefined,
      },
    ];
  }

  return [];
}

function buildPaperTapeRows(args: {
  events: PaperEventResult[];
  tickSize: number;
  tradesById: Map<number, Trade>;
}): ExecutionTapeRow[] {
  const { events, tickSize, tradesById } = args;

  return events.map((event) => {
    const payload = paperPayloadRecord(event.payload);
    const closedTrade = paperPayloadRecord(payload.closed_trade);
    const liquidity = paperLiquidityFromEventType(event.event_type);
    const price =
      numberFromUnknown(payload.entry_price) ??
      numberFromUnknown(payload.exit_price) ??
      numberFromUnknown(paperPayloadRecord(payload.order).price);
    const side =
      (stringFromUnknown(payload.side) as ExecutionSide | null) ??
      (stringFromUnknown(paperPayloadRecord(payload.order).side) as ExecutionSide | null);
    const referencePrice = numberFromUnknown(paperPayloadRecord(payload.quote).reference);
    const tradeId = numberFromUnknown(payload.trade_id);
    const exitSide =
      tradeId !== null && tradesById.has(tradeId)
        ? executionSideForExit(tradesById.get(tradeId)!.side)
        : side;
    const signedSide = event.event_type === "position_closed" ? exitSide : side;

    const closedTradeSide = stringFromUnknown(closedTrade.side);
    const closedTradeExitPrice = numberFromUnknown(closedTrade.exit_price);
    const note =
      event.event_type === "position_opened" && closedTradeSide && closedTradeExitPrice !== null
        ? `${event.summary} Closed ${closedTradeSide} at ${closedTradeExitPrice.toFixed(2)} on the flip.`
        : event.summary;

    return {
      id: event.paper_event_id,
      time: event.created_at,
      category: liquidity ? "fill" : event.event_type.includes("order") ? "order" : "system",
      role:
        event.event_type === "position_opened" || event.event_type === "order_filled"
          ? "entry"
          : event.event_type === "position_closed"
            ? "exit"
            : "n/a",
      liquidity: liquidity ?? "n/a",
      action: actionLabelFromEvent(event),
      side: signedSide ?? null,
      price: price ?? null,
      referencePrice,
      slippageTicks:
        liquidity && signedSide && price !== null
          ? directionalSlippageTicks(signedSide, price, referencePrice, tickSize)
          : null,
      note,
    };
  });
}

export function buildPaperExecutionAnalytics(args: {
  trades: Trade[];
  events: PaperEventResult[];
  tickSize: number;
}): ExecutionAnalyticsResult {
  const { trades, events, tickSize } = args;
  const tradesById = new Map(trades.map((trade) => [trade.trade_id, trade]));
  const fills = events.flatMap((event) => [
    ...paperEntryFillFromEvent(event, tickSize),
    ...paperExitFillFromEvent(event, tradesById, tickSize),
  ]);
  const fillSummary = summarizeFillMix(fills);

  return {
    fills,
    summary: {
      ...buildEmptySummary(),
      ...fillSummary,
    },
    tape: buildPaperTapeRows({ events, tickSize, tradesById }),
  };
}
