import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LogicalRange,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";
import type { Candle } from "../services/api";
import {
  buildPriceChartIndicatorSeries,
  normalizePriceChartIndicatorSettings,
  type IndicatorLinePoint,
  type PriceChartIndicatorSettings,
  type VolumeHistogramPoint,
} from "../services/chartIndicators";

export interface PriceChartMarker {
  time: number;
  position: "aboveBar" | "belowBar" | "inBar";
  color: string;
  shape: "arrowUp" | "arrowDown" | "circle" | "square";
  text: string;
}

export interface PriceChartBracket {
  entryPrice: number;
  side: "buy" | "sell";
  quantity: number;
  tickSize: number;
  tickValue: number;
  stopPrice?: number | null;
  targetPrice?: number | null;
  onCommit?: (next: { stopPrice: number; targetPrice: number }) => void;
  onCancel?: () => void;
}

export interface PriceChartRestingOrder {
  id: string;
  side: "buy" | "sell";
  price: number;
  label: string;
}

interface Props {
  candles: Candle[];
  markers?: PriceChartMarker[];
  visibleIndex?: number;
  followLatest?: boolean;
  height?: number;
  class?: string;
  indicators?: Partial<PriceChartIndicatorSettings>;
  indicatorLegend?: "hidden" | "compact" | "full";
  bracket?: PriceChartBracket | null;
  restingOrders?: PriceChartRestingOrder[];
}

interface IndicatorLegendRow {
  label: string;
  value: string;
  color: string;
}

const INDICATOR_COLORS = {
  ema9: "#38bdf8",
  ema20: "#f59e0b",
  ema50: "#f97316",
  vwap: "#a78bfa",
  sessionHigh: "#22c55e",
  sessionLow: "#f43f5e",
  previousDayHigh: "#14b8a6",
  previousDayLow: "#ec4899",
  volume: "#71717a",
} as const;

function formatPrice(value: number): string {
  return value.toLocaleString(undefined, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  });
}

function formatVolume(value: number): string {
  return value.toLocaleString(undefined, {
    maximumFractionDigits: 0,
  });
}

function formatLegendTime(time: Time | undefined): string {
  if (time === undefined) {
    return "Latest";
  }

  const timestamp = Number(time);
  if (!Number.isFinite(timestamp)) {
    return "Latest";
  }

  return new Date(timestamp * 1000).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildValueMap(points: IndicatorLinePoint[]): Map<number, number> {
  return new Map(points.map((point) => [Number(point.time), point.value]));
}

function buildVolumeValueMap(points: VolumeHistogramPoint[]): Map<number, number> {
  return new Map(points.map((point) => [Number(point.time), point.value]));
}

function median(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  return sorted[middle];
}

function sanitizeCandles(candles: Candle[]): Candle[] {
  const structurallyValid = candles.filter((candle) => {
    const values = [candle.open, candle.high, candle.low, candle.close, candle.volume];
    if (values.some((value) => !Number.isFinite(value))) {
      return false;
    }

    if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0) {
      return false;
    }

    if (candle.high < candle.low) {
      return false;
    }

    return true;
  });

  if (structurallyValid.length <= 2) {
    return structurallyValid;
  }

  const medianClose = median(structurallyValid.map((candle) => candle.close));
  if (!medianClose || !Number.isFinite(medianClose) || medianClose <= 0) {
    return structurallyValid;
  }

  const lowerBound = medianClose * 0.2;
  const upperBound = medianClose * 5;

  const withoutPriceSpikes = structurallyValid.filter((candle) => {
    if (
      candle.open < lowerBound ||
      candle.open > upperBound ||
      candle.high < lowerBound ||
      candle.high > upperBound ||
      candle.low < lowerBound ||
      candle.low > upperBound ||
      candle.close < lowerBound ||
      candle.close > upperBound
    ) {
      return false;
    }

    // If a bar spans more than 100% of price in one step, it's almost certainly junk.
    return (candle.high - candle.low) / candle.close <= 1;
  });

  return withoutPriceSpikes.length > 0 ? withoutPriceSpikes : structurallyValid;
}

export default function PriceChart(props: Props) {
  let container!: HTMLDivElement;
  let chart: IChartApi | undefined;
  let candleSeries: ISeriesApi<"Candlestick"> | undefined;
  let markersPlugin: ISeriesMarkersPluginApi<Time> | null = null;
  const [hoveredTime, setHoveredTime] = createSignal<Time | undefined>();
  const [isFollowingLatest, setIsFollowingLatest] = createSignal(true);
  const indicatorSettings = createMemo(() =>
    normalizePriceChartIndicatorSettings(props.indicators),
  );
  const sanitizedCandles = createMemo(() => sanitizeCandles(props.candles));
  const indicatorSeries = createMemo(() => buildPriceChartIndicatorSeries(sanitizedCandles()));
  const indicatorLegendMode = createMemo(() => props.indicatorLegend ?? "compact");
  const visibleCandles = createMemo(() => {
    const candles = sanitizedCandles();
    const totalCandles = candles.length;
    if (totalCandles === 0) {
      return [];
    }

    const endIndex =
      props.visibleIndex === undefined
        ? totalCandles - 1
        : Math.min(Math.max(props.visibleIndex, 0), totalCandles - 1);

    return candles.slice(0, endIndex + 1);
  });
  const activeCandle = createMemo(() => {
    const candles = visibleCandles();
    if (candles.length === 0) {
      return undefined;
    }

    const time = hoveredTime();
    if (time !== undefined) {
      const targetTime = Number(time);
      const hoveredCandle = candles.find((candle) => Number(candle.time) === targetTime);
      if (hoveredCandle) {
        return hoveredCandle;
      }
    }

    return candles[candles.length - 1];
  });
  const indicatorValueMaps = createMemo(() => {
    const series = indicatorSeries();

    return {
      ema9: buildValueMap(series.ema9),
      ema20: buildValueMap(series.ema20),
      ema50: buildValueMap(series.ema50),
      vwap: buildValueMap(series.vwap),
      sessionHigh: buildValueMap(series.sessionHigh),
      sessionLow: buildValueMap(series.sessionLow),
      previousDayHigh: buildValueMap(series.previousDayHigh),
      previousDayLow: buildValueMap(series.previousDayLow),
      volume: buildVolumeValueMap(series.volume),
    };
  });
  const indicatorLegendRows = createMemo<IndicatorLegendRow[]>(() => {
    const candle = activeCandle();
    if (!candle) {
      return [];
    }

    const time = Number(candle.time);
    const settings = indicatorSettings();
    const maps = indicatorValueMaps();
    const rows: IndicatorLegendRow[] = [];
    const pushPriceRow = (
      enabled: boolean,
      label: string,
      color: string,
      value: number | undefined,
    ) => {
      if (!enabled || value === undefined || !Number.isFinite(value)) {
        return;
      }

      rows.push({
        label,
        color,
        value: formatPrice(value),
      });
    };

    pushPriceRow(settings.ema9, "EMA 9", INDICATOR_COLORS.ema9, maps.ema9.get(time));
    pushPriceRow(settings.ema20, "EMA 20", INDICATOR_COLORS.ema20, maps.ema20.get(time));
    pushPriceRow(settings.ema50, "EMA 50", INDICATOR_COLORS.ema50, maps.ema50.get(time));
    pushPriceRow(settings.vwap, "VWAP", INDICATOR_COLORS.vwap, maps.vwap.get(time));
    pushPriceRow(
      settings.sessionHighLow,
      "Session High",
      INDICATOR_COLORS.sessionHigh,
      maps.sessionHigh.get(time),
    );
    pushPriceRow(
      settings.sessionHighLow,
      "Session Low",
      INDICATOR_COLORS.sessionLow,
      maps.sessionLow.get(time),
    );
    pushPriceRow(
      settings.previousDayHighLow,
      "Prev Day High",
      INDICATOR_COLORS.previousDayHigh,
      maps.previousDayHigh.get(time),
    );
    pushPriceRow(
      settings.previousDayHighLow,
      "Prev Day Low",
      INDICATOR_COLORS.previousDayLow,
      maps.previousDayLow.get(time),
    );

    const volume = maps.volume.get(time);
    if (settings.volume && volume !== undefined) {
      rows.push({
        label: "Volume",
        color: INDICATOR_COLORS.volume,
        value: formatVolume(volume),
      });
    }

    return rows;
  });

  let stopPriceLine: IPriceLine | undefined;
  let targetPriceLine: IPriceLine | undefined;
  let entryPriceLine: IPriceLine | undefined;
  let restingOrderLines: IPriceLine[] = [];
  let overlayContainer: HTMLDivElement | undefined;

  type BracketDragKind = "stop" | "target";
  interface BracketDragState {
    kind: BracketDragKind;
    pointerId: number;
    livePrice: number;
    committed: boolean;
  }
  const [bracketDrag, setBracketDrag] = createSignal<BracketDragState | null>(null);
  const [bracketCoords, setBracketCoords] = createSignal<{
    stopY: number | null;
    targetY: number | null;
    entryY: number | null;
  }>({ stopY: null, targetY: null, entryY: null });

  interface BracketPending {
    kind: BracketDragKind;
    price: number;
  }
  const [bracketPending, setBracketPending] = createSignal<BracketPending | null>(null);

  interface BracketMenuState {
    x: number;
    y: number;
    price: number;
  }
  const [bracketMenu, setBracketMenu] = createSignal<BracketMenuState | null>(null);
  let pendingPriceLine: IPriceLine | undefined;

  let ema9Series: ISeriesApi<"Line"> | undefined;
  let ema20Series: ISeriesApi<"Line"> | undefined;
  let ema50Series: ISeriesApi<"Line"> | undefined;
  let vwapSeries: ISeriesApi<"Line"> | undefined;
  let sessionHighSeries: ISeriesApi<"Line"> | undefined;
  let sessionLowSeries: ISeriesApi<"Line"> | undefined;
  let previousDayHighSeries: ISeriesApi<"Line"> | undefined;
  let previousDayLowSeries: ISeriesApi<"Line"> | undefined;
  let volumeSeries: ISeriesApi<"Histogram"> | undefined;
  let didInitialFit = false;
  let skipNextFollowLockUpdate = false;
  let lastFollowLatestProp = false;

  const syncFollowLock = (range?: LogicalRange | null) => {
    if (!chart) {
      return;
    }

    if (skipNextFollowLockUpdate) {
      skipNextFollowLockUpdate = false;
      return;
    }

    const scrollPosition = chart.timeScale().scrollPosition();
    if (!Number.isFinite(scrollPosition)) {
      return;
    }

    const isNearLiveEdge = scrollPosition <= 0.5;
    if (isNearLiveEdge) {
      setIsFollowingLatest(true);
      return;
    }

    if (range) {
      setIsFollowingLatest(false);
      return;
    }

    if (scrollPosition > 0.5) {
      setIsFollowingLatest(false);
    }
  };

  const filterVisibleLinePoints = (
    points: IndicatorLinePoint[],
    lastVisibleTime: Time | undefined,
  ) =>
    lastVisibleTime === undefined
      ? points
      : points.filter((point) => Number(point.time) <= Number(lastVisibleTime));

  const filterVisibleVolumePoints = (
    points: VolumeHistogramPoint[],
    lastVisibleTime: Time | undefined,
  ) =>
    lastVisibleTime === undefined
      ? points
      : points.filter((point) => Number(point.time) <= Number(lastVisibleTime));

  const latestVisibleValue = (
    points: IndicatorLinePoint[],
    lastVisibleTime: Time | undefined,
  ): number | undefined => {
    const cutoff = lastVisibleTime === undefined ? Number.POSITIVE_INFINITY : Number(lastVisibleTime);

    for (let index = points.length - 1; index >= 0; index -= 1) {
      const point = points[index];
      if (Number(point.time) <= cutoff && Number.isFinite(point.value)) {
        return point.value;
      }
    }

    return undefined;
  };

  const buildFlatLevelLine = (
    candles: Candle[],
    value: number | undefined,
  ): IndicatorLinePoint[] => {
    if (candles.length === 0 || value === undefined || !Number.isFinite(value)) {
      return [];
    }

    const firstTime = candles[0]?.time;
    const lastTime = candles[candles.length - 1]?.time;
    if (firstTime === undefined || lastTime === undefined) {
      return [];
    }

    if (Number(firstTime) === Number(lastTime)) {
      return [{ time: firstTime, value }];
    }

    return [
      { time: firstTime, value },
      { time: lastTime, value },
    ];
  };

  const renderChartState = () => {
    if (!chart || !candleSeries) return;

    const nextVisibleCandles = visibleCandles();
    if (nextVisibleCandles.length === 0) {
      candleSeries.setData([]);
      markersPlugin?.setMarkers([]);
      return;
    }

    candleSeries.setData(nextVisibleCandles);

    if (props.followLatest && isFollowingLatest()) {
      // Keep live replay pinned only while the user is already following.
      skipNextFollowLockUpdate = true;
      chart.timeScale().scrollToRealTime();
    }

    const lastVisibleTime = nextVisibleCandles[nextVisibleCandles.length - 1]?.time;
    const visibleMarkers = (props.markers ?? [])
      .filter((marker) => lastVisibleTime !== undefined && marker.time <= lastVisibleTime)
      .map((marker) => ({
        time: marker.time as Time,
        position: marker.position,
        color: marker.color,
        shape: marker.shape,
        text: marker.text,
      }));
    markersPlugin?.setMarkers(visibleMarkers);

    const settings = indicatorSettings();
    const series = indicatorSeries();

    ema9Series?.setData(
      settings.ema9 ? filterVisibleLinePoints(series.ema9, lastVisibleTime) : [],
    );
    ema20Series?.setData(
      settings.ema20 ? filterVisibleLinePoints(series.ema20, lastVisibleTime) : [],
    );
    ema50Series?.setData(
      settings.ema50 ? filterVisibleLinePoints(series.ema50, lastVisibleTime) : [],
    );
    vwapSeries?.setData(
      settings.vwap ? filterVisibleLinePoints(series.vwap, lastVisibleTime) : [],
    );
    const sessionHighData = settings.sessionHighLow
      ? settings.levelTrail
        ? filterVisibleLinePoints(series.sessionHigh, lastVisibleTime)
        : buildFlatLevelLine(
            nextVisibleCandles,
            latestVisibleValue(series.sessionHigh, lastVisibleTime),
          )
      : [];
    const sessionLowData = settings.sessionHighLow
      ? settings.levelTrail
        ? filterVisibleLinePoints(series.sessionLow, lastVisibleTime)
        : buildFlatLevelLine(
            nextVisibleCandles,
            latestVisibleValue(series.sessionLow, lastVisibleTime),
          )
      : [];
    const previousDayHighData = settings.previousDayHighLow
      ? settings.levelTrail
        ? filterVisibleLinePoints(series.previousDayHigh, lastVisibleTime)
        : buildFlatLevelLine(
            nextVisibleCandles,
            latestVisibleValue(series.previousDayHigh, lastVisibleTime),
          )
      : [];
    const previousDayLowData = settings.previousDayHighLow
      ? settings.levelTrail
        ? filterVisibleLinePoints(series.previousDayLow, lastVisibleTime)
        : buildFlatLevelLine(
            nextVisibleCandles,
            latestVisibleValue(series.previousDayLow, lastVisibleTime),
          )
      : [];

    sessionHighSeries?.setData(
      sessionHighData,
    );
    sessionLowSeries?.setData(
      sessionLowData,
    );
    previousDayHighSeries?.setData(
      previousDayHighData,
    );
    previousDayLowSeries?.setData(
      previousDayLowData,
    );
    volumeSeries?.setData(
      settings.volume ? filterVisibleVolumePoints(series.volume, lastVisibleTime) : [],
    );

    if (!didInitialFit) {
      // Fit once on first render, then leave the user's manual zoom/scroll alone.
      chart.timeScale().fitContent();
      didInitialFit = true;
    }
  };

  const formatBracketDollars = (value: number): string => {
    const sign = value >= 0 ? "+" : "-";
    return `${sign}$${Math.abs(value).toLocaleString(undefined, {
      maximumFractionDigits: 0,
    })}`;
  };

  const effectiveBracketPrices = (
    bracket: PriceChartBracket,
  ): { stopPrice: number | null; targetPrice: number | null } => {
    const drag = bracketDrag();
    const propStop =
      bracket.stopPrice !== null &&
      bracket.stopPrice !== undefined &&
      Number.isFinite(bracket.stopPrice)
        ? bracket.stopPrice
        : null;
    const propTarget =
      bracket.targetPrice !== null &&
      bracket.targetPrice !== undefined &&
      Number.isFinite(bracket.targetPrice)
        ? bracket.targetPrice
        : null;

    return {
      stopPrice: drag?.kind === "stop" ? drag.livePrice : propStop,
      targetPrice: drag?.kind === "target" ? drag.livePrice : propTarget,
    };
  };

  const renderBracketLines = () => {
    if (!candleSeries) {
      return;
    }

    const bracket = props.bracket;

    if (stopPriceLine) {
      candleSeries.removePriceLine(stopPriceLine);
      stopPriceLine = undefined;
    }
    if (targetPriceLine) {
      candleSeries.removePriceLine(targetPriceLine);
      targetPriceLine = undefined;
    }
    if (entryPriceLine) {
      candleSeries.removePriceLine(entryPriceLine);
      entryPriceLine = undefined;
    }
    if (pendingPriceLine) {
      candleSeries.removePriceLine(pendingPriceLine);
      pendingPriceLine = undefined;
    }

    if (!bracket) {
      return;
    }

    const dollarPerPoint =
      bracket.tickSize > 0 ? bracket.tickValue / bracket.tickSize : 0;
    const qty = bracket.quantity > 0 ? bracket.quantity : 1;
    const sideSign = bracket.side === "buy" ? 1 : -1;
    const { stopPrice, targetPrice } = effectiveBracketPrices(bracket);

    entryPriceLine = candleSeries.createPriceLine({
      price: bracket.entryPrice,
      color: "#a1a1aa",
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: `ENTRY ${bracket.entryPrice.toFixed(2)}`,
    });

    if (targetPrice !== null) {
      const pnl =
        (targetPrice - bracket.entryPrice) * sideSign * dollarPerPoint * qty;
      targetPriceLine = candleSeries.createPriceLine({
        price: targetPrice,
        color: "#22c55e",
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: `TP ${formatBracketDollars(pnl)}`,
      });
    }

    if (stopPrice !== null) {
      const pnl =
        (stopPrice - bracket.entryPrice) * sideSign * dollarPerPoint * qty;
      stopPriceLine = candleSeries.createPriceLine({
        price: stopPrice,
        color: "#f43f5e",
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: `SL ${formatBracketDollars(pnl)}`,
      });
    }

    const pending = bracketPending();
    if (pending) {
      const hasCommitted =
        pending.kind === "stop" ? stopPrice !== null : targetPrice !== null;
      if (!hasCommitted) {
        const pnl =
          (pending.price - bracket.entryPrice) * sideSign * dollarPerPoint * qty;
        const label = pending.kind === "stop" ? "SL?" : "TP?";
        pendingPriceLine = candleSeries.createPriceLine({
          price: pending.price,
          color: pending.kind === "stop" ? "#f43f5e" : "#22c55e",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `${label} ${formatBracketDollars(pnl)}`,
        });
      }
    }
  };

  const renderRestingOrders = () => {
    if (!candleSeries) {
      return;
    }
    for (const line of restingOrderLines) {
      candleSeries.removePriceLine(line);
    }
    restingOrderLines = [];

    const orders = props.restingOrders ?? [];
    for (const order of orders) {
      if (!Number.isFinite(order.price)) {
        continue;
      }
      const line = candleSeries.createPriceLine({
        price: order.price,
        color: order.side === "buy" ? "#22c55e" : "#f43f5e",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: order.label,
      });
      restingOrderLines.push(line);
    }
  };

  const recomputeBracketCoords = () => {
    if (!candleSeries) {
      return;
    }
    const bracket = props.bracket;
    if (!bracket) {
      setBracketCoords({ stopY: null, targetY: null, entryY: null });
      return;
    }

    const { stopPrice, targetPrice } = effectiveBracketPrices(bracket);
    setBracketCoords({
      stopY: stopPrice !== null ? candleSeries.priceToCoordinate(stopPrice) : null,
      targetY:
        targetPrice !== null ? candleSeries.priceToCoordinate(targetPrice) : null,
      entryY: candleSeries.priceToCoordinate(bracket.entryPrice),
    });
  };

  const snapToTick = (price: number, tickSize: number): number => {
    if (!Number.isFinite(price)) {
      return price;
    }
    const tick = tickSize > 0 ? tickSize : 0.25;
    return Math.round(price / tick) * tick;
  };

  const clampBracketPrice = (
    rawPrice: number,
    kind: BracketDragKind,
    bracket: PriceChartBracket,
  ): number => {
    const snap = snapToTick(rawPrice, bracket.tickSize);
    const step = bracket.tickSize > 0 ? bracket.tickSize : 0.25;
    const isLong = bracket.side === "buy";
    if (kind === "stop") {
      return isLong
        ? Math.min(snap, bracket.entryPrice - step)
        : Math.max(snap, bracket.entryPrice + step);
    }
    return isLong
      ? Math.max(snap, bracket.entryPrice + step)
      : Math.min(snap, bracket.entryPrice - step);
  };

  const setChartInteractionEnabled = (enabled: boolean) => {
    chart?.applyOptions({
      handleScroll: enabled,
      handleScale: enabled,
    });
  };

  const handleBracketPointerDown = (kind: BracketDragKind, event: PointerEvent) => {
    const bracket = props.bracket;
    if (!bracket || !candleSeries) {
      return;
    }
    const currentPrice =
      kind === "stop" ? bracket.stopPrice : bracket.targetPrice;
    if (currentPrice === null || currentPrice === undefined) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    setBracketDrag({
      kind,
      pointerId: event.pointerId,
      livePrice: currentPrice,
      committed: false,
    });
    setChartInteractionEnabled(false);
  };

  const handleBracketPointerMove = (event: PointerEvent) => {
    const drag = bracketDrag();
    const bracket = props.bracket;
    if (!drag || !bracket || !candleSeries || !overlayContainer) {
      return;
    }
    if (event.pointerId !== drag.pointerId) {
      return;
    }

    const rect = overlayContainer.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const rawPrice = candleSeries.coordinateToPrice(y);
    if (rawPrice === null || !Number.isFinite(rawPrice as number)) {
      return;
    }
    const nextPrice = clampBracketPrice(rawPrice as number, drag.kind, bracket);
    if (nextPrice === drag.livePrice) {
      return;
    }
    setBracketDrag({ ...drag, livePrice: nextPrice });
  };

  const finishBracketDrag = (commit: boolean) => {
    const drag = bracketDrag();
    const bracket = props.bracket;
    setBracketDrag(null);
    setChartInteractionEnabled(true);
    if (!drag || !bracket) {
      return;
    }
    if (!commit) {
      return;
    }
    if (
      bracket.stopPrice === null ||
      bracket.stopPrice === undefined ||
      bracket.targetPrice === null ||
      bracket.targetPrice === undefined
    ) {
      return;
    }

    const nextStop =
      drag.kind === "stop"
        ? drag.livePrice
        : (bracket.stopPrice as number);
    const nextTarget =
      drag.kind === "target"
        ? drag.livePrice
        : (bracket.targetPrice as number);

    if (
      nextStop === bracket.stopPrice &&
      nextTarget === bracket.targetPrice
    ) {
      return;
    }

    bracket.onCommit?.({ stopPrice: nextStop, targetPrice: nextTarget });
  };

  const handleBracketPointerUp = (event: PointerEvent) => {
    const drag = bracketDrag();
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
    finishBracketDrag(true);
  };

  const handleBracketPointerCancel = (event: PointerEvent) => {
    const drag = bracketDrag();
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    finishBracketDrag(false);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") {
      return;
    }
    if (bracketDrag()) {
      finishBracketDrag(false);
      return;
    }
    if (bracketMenu()) {
      setBracketMenu(null);
      return;
    }
    if (bracketPending()) {
      setBracketPending(null);
      renderBracketLines();
    }
  };

  const handleChartContextMenu = (event: MouseEvent) => {
    const bracket = props.bracket;
    if (!bracket || !candleSeries || !container) {
      return;
    }
    const rect = container.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const rawPrice = candleSeries.coordinateToPrice(y);
    if (rawPrice === null || !Number.isFinite(rawPrice as number)) {
      return;
    }
    event.preventDefault();
    setBracketMenu({
      x: event.clientX - rect.left,
      y,
      price: snapToTick(rawPrice as number, bracket.tickSize),
    });
  };

  const closeBracketMenu = () => setBracketMenu(null);

  const isPriceValidFor = (
    kind: BracketDragKind,
    price: number,
    bracket: PriceChartBracket,
  ): boolean => {
    const step = bracket.tickSize > 0 ? bracket.tickSize : 0.25;
    const isLong = bracket.side === "buy";
    if (kind === "stop") {
      return isLong ? price <= bracket.entryPrice - step : price >= bracket.entryPrice + step;
    }
    return isLong ? price >= bracket.entryPrice + step : price <= bracket.entryPrice - step;
  };

  const commitMenuPrice = (kind: BracketDragKind) => {
    const menu = bracketMenu();
    const bracket = props.bracket;
    if (!menu || !bracket) {
      return;
    }
    const price = clampBracketPrice(menu.price, kind, bracket);

    const committedStop =
      bracket.stopPrice !== null && bracket.stopPrice !== undefined && Number.isFinite(bracket.stopPrice)
        ? (bracket.stopPrice as number)
        : null;
    const committedTarget =
      bracket.targetPrice !== null &&
      bracket.targetPrice !== undefined &&
      Number.isFinite(bracket.targetPrice)
        ? (bracket.targetPrice as number)
        : null;

    closeBracketMenu();

    if (committedStop !== null && committedTarget !== null) {
      // Move one leg of an existing bracket.
      const nextStop = kind === "stop" ? price : committedStop;
      const nextTarget = kind === "target" ? price : committedTarget;
      if (nextStop === committedStop && nextTarget === committedTarget) {
        return;
      }
      bracket.onCommit?.({ stopPrice: nextStop, targetPrice: nextTarget });
      return;
    }

    // No committed bracket — building one via two right-clicks.
    const pending = bracketPending();
    if (pending && pending.kind !== kind) {
      const nextStop = kind === "stop" ? price : pending.price;
      const nextTarget = kind === "target" ? price : pending.price;
      setBracketPending(null);
      bracket.onCommit?.({ stopPrice: nextStop, targetPrice: nextTarget });
      return;
    }

    setBracketPending({ kind, price });
    renderBracketLines();
  };

  const cancelBracketFromMenu = () => {
    const bracket = props.bracket;
    closeBracketMenu();
    setBracketPending(null);
    bracket?.onCancel?.();
  };

  const clearPendingFromMenu = () => {
    closeBracketMenu();
    setBracketPending(null);
    renderBracketLines();
  };

  onMount(() => {
    chart = createChart(container, {
      autoSize: true,
      height: props.height ?? 500,
      layout: {
        background: { color: "#0a0a0c" },
        textColor: "#9f9fa9",
      },
      grid: {
        vertLines: { color: "#1f1f24" },
        horzLines: { color: "#1f1f24" },
      },
      crosshair: {
        vertLine: { color: "#3f3f46", labelBackgroundColor: "#18181b" },
        horzLine: { color: "#3f3f46", labelBackgroundColor: "#18181b" },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: "#313138",
      },
      rightPriceScale: {
        borderColor: "#313138",
      },
    });

    candleSeries = chart.addSeries(CandlestickSeries, {
      priceScaleId: "right",
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });
    candleSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.08,
        bottom: 0.24,
      },
    });
    ema9Series = chart.addSeries(LineSeries, {
      priceScaleId: "right",
      color: "#38bdf8",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    ema20Series = chart.addSeries(LineSeries, {
      priceScaleId: "right",
      color: "#f59e0b",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    ema50Series = chart.addSeries(LineSeries, {
      priceScaleId: "right",
      color: "#f97316",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    vwapSeries = chart.addSeries(LineSeries, {
      priceScaleId: "right",
      color: "#a78bfa",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    sessionHighSeries = chart.addSeries(LineSeries, {
      priceScaleId: "right",
      color: "#22c55e",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    sessionLowSeries = chart.addSeries(LineSeries, {
      priceScaleId: "right",
      color: "#f43f5e",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    previousDayHighSeries = chart.addSeries(LineSeries, {
      priceScaleId: "right",
      color: "#14b8a6",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    previousDayLowSeries = chart.addSeries(LineSeries, {
      priceScaleId: "right",
      color: "#ec4899",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.78,
        bottom: 0,
      },
    });
    markersPlugin = createSeriesMarkers(candleSeries, []);
    chart.subscribeCrosshairMove((param: MouseEventParams<Time>) => {
      setHoveredTime(param.time);
      recomputeBracketCoords();
    });
    chart.timeScale().subscribeVisibleTimeRangeChange(() => {
      recomputeBracketCoords();
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      syncFollowLock(range);
    });
    renderChartState();

    const resizeObserver = new ResizeObserver(() => {
      recomputeBracketCoords();
    });
    resizeObserver.observe(container);

    window.addEventListener("keydown", handleKeyDown);
    container.addEventListener("contextmenu", handleChartContextMenu);

    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown);
      container.removeEventListener("contextmenu", handleChartContextMenu);
      resizeObserver.disconnect();
      chart?.remove();
      chart = undefined;
      candleSeries = undefined;
      markersPlugin = null;
      stopPriceLine = undefined;
      targetPriceLine = undefined;
      entryPriceLine = undefined;
      restingOrderLines = [];
      ema9Series = undefined;
      ema20Series = undefined;
      ema50Series = undefined;
      vwapSeries = undefined;
      sessionHighSeries = undefined;
      sessionLowSeries = undefined;
      previousDayHighSeries = undefined;
      previousDayLowSeries = undefined;
      volumeSeries = undefined;
    });
  });

  createEffect(() => {
    const followLatest = props.followLatest ?? false;
    if (followLatest && !lastFollowLatestProp) {
      setIsFollowingLatest(true);
    }
    if (!followLatest) {
      setIsFollowingLatest(false);
    }
    lastFollowLatestProp = followLatest;
  });

  createEffect(() => {
    renderChartState();
    recomputeBracketCoords();
  });

  createEffect(() => {
    // Touch the bracket prop and live drag price so this reruns when either changes.
    void props.bracket;
    void bracketDrag();
    void bracketPending();
    renderBracketLines();
    recomputeBracketCoords();
  });

  createEffect(() => {
    void props.restingOrders;
    renderRestingOrders();
  });

  createEffect(() => {
    // Clear pending state once the committed bracket lands.
    const bracket = props.bracket;
    if (!bracket) {
      if (bracketPending()) {
        setBracketPending(null);
      }
      return;
    }
    const hasStop =
      bracket.stopPrice !== null && bracket.stopPrice !== undefined && Number.isFinite(bracket.stopPrice);
    const hasTarget =
      bracket.targetPrice !== null &&
      bracket.targetPrice !== undefined &&
      Number.isFinite(bracket.targetPrice);
    if (hasStop && hasTarget && bracketPending()) {
      setBracketPending(null);
    }
  });

  return (
    <div
      class={`relative w-full overflow-hidden border border-stone-700/80 bg-stone-950 ${props.class ?? ""}`}
      style={{
        "border-radius": "0",
        ...(props.height ? { height: `${props.height}px` } : {}),
      }}
    >
      <div ref={container} class="h-full w-full" />

      {indicatorLegendMode() !== "hidden" && activeCandle() ? (
        <div
          class={`pointer-events-none absolute left-3 top-3 z-10 max-w-[min(320px,calc(100%-1.5rem))] border border-stone-800/90 bg-stone-950/82 shadow-xl shadow-black/25 backdrop-blur ${
            indicatorLegendMode() === "full" ? "px-3 py-2.5" : "px-2.5 py-2"
          }`}
          style={{ "border-radius": "0" }}
        >
          <div class="flex items-center justify-between gap-4">
            <span class="text-[10px] font-medium uppercase tracking-[0.18em] text-stone-500">
              {hoveredTime() ? "Hover" : "Latest"}
            </span>
            <span class="app-data text-[10px] text-stone-500">
              {formatLegendTime(activeCandle()?.time)}
            </span>
          </div>

          {indicatorLegendMode() === "full" ? (
            <div class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 border-b border-stone-800/80 pb-2 text-[11px]">
              <span class="text-stone-500">Open</span>
              <span class="app-data text-right text-stone-200">
                {formatPrice(activeCandle()!.open)}
              </span>
              <span class="text-stone-500">High</span>
              <span class="app-data text-right text-stone-200">
                {formatPrice(activeCandle()!.high)}
              </span>
              <span class="text-stone-500">Low</span>
              <span class="app-data text-right text-stone-200">
                {formatPrice(activeCandle()!.low)}
              </span>
              <span class="text-stone-500">Close</span>
              <span class="app-data text-right text-stone-100">
                {formatPrice(activeCandle()!.close)}
              </span>
            </div>
          ) : null}

          <div class={indicatorLegendMode() === "full" ? "mt-2 space-y-1" : "mt-1.5 space-y-1"}>
            {indicatorLegendRows().map((row) => (
              <div class="grid grid-cols-[auto_minmax(5.5rem,1fr)_auto] items-center gap-2 text-[11px]">
                <span
                  class="h-2 w-2 rounded-full"
                  style={{ "background-color": row.color }}
                />
                <span class="truncate text-stone-400">{row.label}</span>
                <span class="app-data text-right font-medium text-stone-100">{row.value}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {props.bracket ? (
        <div
          ref={overlayContainer}
          class="pointer-events-none absolute inset-0 z-20"
        >
          {bracketCoords().targetY !== null &&
          props.bracket.targetPrice !== null &&
          props.bracket.targetPrice !== undefined ? (
            <div
              class="pointer-events-auto absolute left-0 right-12 -translate-y-1/2"
              style={{
                top: `${bracketCoords().targetY}px`,
                height: "14px",
                cursor: "ns-resize",
              }}
              onPointerDown={(event) => handleBracketPointerDown("target", event)}
              onPointerMove={handleBracketPointerMove}
              onPointerUp={handleBracketPointerUp}
              onPointerCancel={handleBracketPointerCancel}
            />
          ) : null}

          {bracketCoords().stopY !== null &&
          props.bracket.stopPrice !== null &&
          props.bracket.stopPrice !== undefined ? (
            <div
              class="pointer-events-auto absolute left-0 right-12 -translate-y-1/2"
              style={{
                top: `${bracketCoords().stopY}px`,
                height: "14px",
                cursor: "ns-resize",
              }}
              onPointerDown={(event) => handleBracketPointerDown("stop", event)}
              onPointerMove={handleBracketPointerMove}
              onPointerUp={handleBracketPointerUp}
              onPointerCancel={handleBracketPointerCancel}
            />
          ) : null}

          {bracketMenu() ? (
            <>
              <div
                class="pointer-events-auto absolute inset-0"
                onClick={closeBracketMenu}
                onContextMenu={(event) => {
                  event.preventDefault();
                  closeBracketMenu();
                }}
              />
              {(() => {
                const menu = bracketMenu()!;
                const bracket = props.bracket!;
                const hasStop =
                  bracket.stopPrice !== null &&
                  bracket.stopPrice !== undefined &&
                  Number.isFinite(bracket.stopPrice);
                const hasTarget =
                  bracket.targetPrice !== null &&
                  bracket.targetPrice !== undefined &&
                  Number.isFinite(bracket.targetPrice);
                const hasCommittedBracket = hasStop && hasTarget;
                const pending = bracketPending();
                const stopValid = isPriceValidFor("stop", menu.price, bracket);
                const targetValid = isPriceValidFor("target", menu.price, bracket);
                const priceLabel = menu.price.toFixed(2);

                return (
                  <div
                    class="pointer-events-auto absolute z-30 min-w-[200px] border border-stone-700 bg-stone-950/95 py-1 text-[12px] text-stone-100 shadow-xl shadow-black/40"
                    style={{
                      left: `${menu.x}px`,
                      top: `${menu.y}px`,
                      "border-radius": "0",
                    }}
                    onContextMenu={(event) => event.preventDefault()}
                  >
                    <div class="border-b border-stone-800 px-3 pb-1 pt-0.5 text-[10px] uppercase tracking-[0.18em] text-stone-500">
                      <span class="app-data text-stone-300">{priceLabel}</span>
                    </div>

                    {hasCommittedBracket ? (
                      <>
                        <button
                          type="button"
                          class="block w-full px-3 py-1.5 text-left hover:bg-stone-800/80 disabled:cursor-not-allowed disabled:text-stone-600 disabled:hover:bg-transparent"
                          disabled={!targetValid}
                          onClick={() => commitMenuPrice("target")}
                        >
                          Move TP here
                        </button>
                        <button
                          type="button"
                          class="block w-full px-3 py-1.5 text-left hover:bg-stone-800/80 disabled:cursor-not-allowed disabled:text-stone-600 disabled:hover:bg-transparent"
                          disabled={!stopValid}
                          onClick={() => commitMenuPrice("stop")}
                        >
                          Move SL here
                        </button>
                        <div class="my-1 border-t border-stone-800" />
                        <button
                          type="button"
                          class="block w-full px-3 py-1.5 text-left text-rose-300 hover:bg-stone-800/80"
                          onClick={cancelBracketFromMenu}
                        >
                          Cancel bracket
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          class="block w-full px-3 py-1.5 text-left hover:bg-stone-800/80 disabled:cursor-not-allowed disabled:text-stone-600 disabled:hover:bg-transparent"
                          disabled={!targetValid}
                          onClick={() => commitMenuPrice("target")}
                        >
                          {pending?.kind === "stop"
                            ? `Set TP here (SL @ ${pending.price.toFixed(2)})`
                            : "Set TP here"}
                        </button>
                        <button
                          type="button"
                          class="block w-full px-3 py-1.5 text-left hover:bg-stone-800/80 disabled:cursor-not-allowed disabled:text-stone-600 disabled:hover:bg-transparent"
                          disabled={!stopValid}
                          onClick={() => commitMenuPrice("stop")}
                        >
                          {pending?.kind === "target"
                            ? `Set SL here (TP @ ${pending.price.toFixed(2)})`
                            : "Set SL here"}
                        </button>
                        {pending ? (
                          <>
                            <div class="my-1 border-t border-stone-800" />
                            <button
                              type="button"
                              class="block w-full px-3 py-1.5 text-left text-stone-400 hover:bg-stone-800/80"
                              onClick={clearPendingFromMenu}
                            >
                              Clear pending {pending.kind === "stop" ? "SL" : "TP"}
                            </button>
                          </>
                        ) : null}
                      </>
                    )}
                  </div>
                );
              })()}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
