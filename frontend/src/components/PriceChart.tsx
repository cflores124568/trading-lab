import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
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

interface Props {
  candles: Candle[];
  markers?: PriceChartMarker[];
  visibleIndex?: number;
  height?: number;
  class?: string;
  indicators?: Partial<PriceChartIndicatorSettings>;
  indicatorLegend?: "hidden" | "compact" | "full";
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

  let ema9Series: ISeriesApi<"Line"> | undefined;
  let ema20Series: ISeriesApi<"Line"> | undefined;
  let ema50Series: ISeriesApi<"Line"> | undefined;
  let vwapSeries: ISeriesApi<"Line"> | undefined;
  let sessionHighSeries: ISeriesApi<"Line"> | undefined;
  let sessionLowSeries: ISeriesApi<"Line"> | undefined;
  let previousDayHighSeries: ISeriesApi<"Line"> | undefined;
  let previousDayLowSeries: ISeriesApi<"Line"> | undefined;
  let volumeSeries: ISeriesApi<"Histogram"> | undefined;

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

    chart.timeScale().fitContent();
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
    });
    renderChartState();

    onCleanup(() => {
      chart?.remove();
      chart = undefined;
      candleSeries = undefined;
      markersPlugin = null;
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
    renderChartState();
  });

  return (
    <div
      class={`relative w-full overflow-hidden rounded-sm border border-zinc-700/80 bg-zinc-950 ${props.class ?? ""}`}
      style={props.height ? { height: `${props.height}px` } : undefined}
    >
      <div ref={container} class="h-full w-full" />

      {indicatorLegendMode() !== "hidden" && activeCandle() ? (
        <div
          class={`pointer-events-none absolute left-3 top-3 z-10 max-w-[min(320px,calc(100%-1.5rem))] rounded-sm border border-zinc-800/90 bg-zinc-950/82 shadow-xl shadow-black/25 backdrop-blur ${
            indicatorLegendMode() === "full" ? "px-3 py-2.5" : "px-2.5 py-2"
          }`}
        >
          <div class="flex items-center justify-between gap-4">
            <span class="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
              {hoveredTime() ? "Hover" : "Latest"}
            </span>
            <span class="app-data text-[10px] text-zinc-500">
              {formatLegendTime(activeCandle()?.time)}
            </span>
          </div>

          {indicatorLegendMode() === "full" ? (
            <div class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 border-b border-zinc-800/80 pb-2 text-[11px]">
              <span class="text-zinc-500">Open</span>
              <span class="app-data text-right text-zinc-200">
                {formatPrice(activeCandle()!.open)}
              </span>
              <span class="text-zinc-500">High</span>
              <span class="app-data text-right text-zinc-200">
                {formatPrice(activeCandle()!.high)}
              </span>
              <span class="text-zinc-500">Low</span>
              <span class="app-data text-right text-zinc-200">
                {formatPrice(activeCandle()!.low)}
              </span>
              <span class="text-zinc-500">Close</span>
              <span class="app-data text-right text-zinc-100">
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
                <span class="truncate text-zinc-400">{row.label}</span>
                <span class="app-data text-right font-medium text-zinc-100">{row.value}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
