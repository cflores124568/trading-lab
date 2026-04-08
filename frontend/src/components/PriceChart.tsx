import { createEffect, onCleanup, onMount } from "solid-js";
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
} from "lightweight-charts";
import type { Candle } from "../services/api";

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
}

export default function PriceChart(props: Props) {
  let container!: HTMLDivElement;
  let chart: IChartApi | undefined;
  let candleSeries: ISeriesApi<"Candlestick"> | undefined;
  let markersPlugin: ISeriesMarkersPluginApi<Time> | null = null;

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
    markersPlugin = createSeriesMarkers(candleSeries, []);
    renderChartState();

    onCleanup(() => {
      chart?.remove();
      chart = undefined;
      candleSeries = undefined;
      markersPlugin = null;
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
