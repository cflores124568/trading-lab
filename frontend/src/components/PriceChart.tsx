import { onMount, onCleanup, createEffect, createSignal } from "solid-js";
import { createChart, CandlestickSeries, createSeriesMarkers, type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type Time } from "lightweight-charts";
import type { Candle } from "../services/api";

interface Props {
  candles: Candle[];
  trades?: Array<{
    time: number;      // timestamp (unix seconds or lightweight-charts time)
    price: number;
    side: "buy" | "sell";
    quantity?: number;
  }>;
  isReplayActive?: boolean;
  playbackSpeed?: number;   // 1 = normal
  onProgress?: (progress: number) => void;  // 0 to 1
  onComplete?: () => void;
  height?: number;
}

export default function PriceChart(props: Props) {
  let container!: HTMLDivElement;
  let chart: IChartApi;
  let candleSeries: ISeriesApi<"Candlestick">;
  let markersPlugin: ISeriesMarkersPluginApi<Time> | null = null;
  let animationFrame: number | null = null;
  let startTime = 0;
  let currentIndex = 0;

  const [, setIsPlaying] = createSignal(false);

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

    // v5: markers live in a plugin now, created once and reused
    markersPlugin = createSeriesMarkers(candleSeries, []);
    // Initial full data load
    if (props.candles.length > 0) {
      candleSeries.setData(props.candles);
      chart.timeScale().fitContent();
    }

    onCleanup(() => {
      if (animationFrame){
        cancelAnimationFrame(animationFrame);
      }
      chart.remove();
    });
  });

  // Replay engine
  createEffect(() => {
    if (!props.isReplayActive || !candleSeries || props.candles.length === 0) {
      setIsPlaying(false);
      return;
    }

    const speed = props.playbackSpeed ?? 8;           // default feels good
    const msPerBar = Math.max(8, 1000 / speed);

    currentIndex = 0;
    startTime = performance.now();

    const step = (timestamp: number) => {
      const elapsed = timestamp - startTime;
      const targetIndex = Math.min(Math.floor(elapsed / msPerBar), props.candles.length - 1);

      if (targetIndex > currentIndex) {
        const visibleData = props.candles.slice(0, targetIndex + 1);
        candleSeries.setData(visibleData);

        // Add trade markers as they appear
        // v5: update markers via plugin instead of setMarkers()
        if (props.trades && markersPlugin) {
          const lastTime = visibleData[visibleData.length - 1].time;
          const visibleTrades = props.trades.filter((t) =>  t.time <= lastTime);

          markersPlugin.setMarkers(
            visibleTrades.map((t) => ({
              time: t.time as any,
              position: t.side === "buy" ? ("belowBar" as const) : ("aboveBar" as const),
              color: t.side === "buy" ? "#22c55e" : "#ef4444",
              shape: t.side === "buy" ? ("arrowUp" as const) : ("arrowDown" as const),
              text: `${t.side.toUpperCase()} ${t.quantity ? t.quantity + " " : ""}@ ${t.price.toFixed(2)}`,
            }))
          );
        }

        chart.timeScale().scrollToPosition(targetIndex, false);
        currentIndex = targetIndex;

        const progress = (currentIndex + 1) / props.candles.length;
        props.onProgress?.(progress);
      }

      if (currentIndex < props.candles.length - 1) {
        animationFrame = requestAnimationFrame(step);
      } else {
        setIsPlaying(false);
        props.onComplete?.();
      }
    };

    setIsPlaying(true);
    animationFrame = requestAnimationFrame(step);
  });

  // Allow external pause
  createEffect(() => {
    if (!props.isReplayActive && animationFrame) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
      setIsPlaying(false);
    }
  });

  return (
    <div 
      ref={container} 
      class="w-full rounded-xl overflow-hidden border border-zinc-800 bg-zinc-950"
    />
  );
}