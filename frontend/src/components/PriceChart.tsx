import { createEffect, createMemo, onCleanup, onMount } from "solid-js";
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
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
}

export default function PriceChart(props: Props) {
  let container!: HTMLDivElement;
  let chart: IChartApi | undefined;
  let candleSeries: ISeriesApi<"Candlestick"> | undefined;
  let markersPlugin: ISeriesMarkersPluginApi<Time> | null = null;
  const indicatorSettings = createMemo(() =>
    normalizePriceChartIndicatorSettings(props.indicators),
  );
  const indicatorSeries = createMemo(() => buildPriceChartIndicatorSeries(props.candles));

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

  const renderChartState = () => {
    if (!chart || !candleSeries) return;

    const totalCandles = props.candles.length;
    if (totalCandles === 0) {
      candleSeries.setData([]);
      markersPlugin?.setMarkers([]);
      return;
    }

    const endIndex =
      props.visibleIndex === undefined
        ? totalCandles - 1
        : Math.min(Math.max(props.visibleIndex, 0), totalCandles - 1);

    const visibleCandles = props.candles.slice(0, endIndex + 1);
    candleSeries.setData(visibleCandles);

    const lastVisibleTime = visibleCandles[visibleCandles.length - 1]?.time;
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
    sessionHighSeries?.setData(
      settings.sessionHighLow
        ? filterVisibleLinePoints(series.sessionHigh, lastVisibleTime)
        : [],
    );
    sessionLowSeries?.setData(
      settings.sessionHighLow
        ? filterVisibleLinePoints(series.sessionLow, lastVisibleTime)
        : [],
    );
    previousDayHighSeries?.setData(
      settings.previousDayHighLow
        ? filterVisibleLinePoints(series.previousDayHigh, lastVisibleTime)
        : [],
    );
    previousDayLowSeries?.setData(
      settings.previousDayHighLow
        ? filterVisibleLinePoints(series.previousDayLow, lastVisibleTime)
        : [],
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
        background: { color: "#09090b" },
        textColor: "#a1a1aa",
      },
      grid: {
        vertLines: { color: "#27272a" },
        horzLines: { color: "#27272a" },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: "#27272a",
      },
      rightPriceScale: {
        borderColor: "#27272a",
      },
    });

    candleSeries = chart.addSeries(CandlestickSeries, {
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
      color: "#38bdf8",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    ema20Series = chart.addSeries(LineSeries, {
      color: "#f59e0b",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    ema50Series = chart.addSeries(LineSeries, {
      color: "#f97316",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    vwapSeries = chart.addSeries(LineSeries, {
      color: "#a78bfa",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    sessionHighSeries = chart.addSeries(LineSeries, {
      color: "#22c55e",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    sessionLowSeries = chart.addSeries(LineSeries, {
      color: "#f43f5e",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    previousDayHighSeries = chart.addSeries(LineSeries, {
      color: "#14b8a6",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    previousDayLowSeries = chart.addSeries(LineSeries, {
      color: "#ec4899",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
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
      ref={container}
      class={`w-full overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 ${props.class ?? ""}`}
      style={props.height ? { height: `${props.height}px` } : undefined}
    />
  );
}
