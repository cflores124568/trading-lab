import { onMount, onCleanup } from "solid-js";
import { createChart, CandlestickSeries, type IChartApi } from "lightweight-charts";
import type { Candle } from "../services/api";

interface Props {
  candles: Candle[];
  height?: number;
}

export default function PriceChart(props: Props) {
  let container!: HTMLDivElement;
  //chart lives in a plain let, not a signal since Lightweight Charts owns its DOM & manages its own state
  //So wrapping it in createSignal can cause re-renders and break the API
  let chart: IChartApi;

  onMount(() => {
    chart = createChart(container, {
      height: props.height ?? 400,
      layout: {
        background: { color: "#09090b" },
        textColor: "#a1a1aa",
      },
      grid: {
        vertLines: { color: "#27272a" },
        horzLines: { color: "#27272a" },
      },
      timeScale: { timeVisible: true, secondsVisible: false },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });

    series.setData(props.candles);
    chart.timeScale().fitContent();

    //ResizeObserver keeps the chart filling its container when the window
    //resizes since Lightweight Charts doesn't do this automatically
    const observer = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth });
    });
    observer.observe(container);

    onCleanup(() => {
      observer.disconnect();
      chart.remove(); //must explicitly destroy, since Lightweigt Charts attaches canvas/workers to  DOM
    });
  });

  return <div ref={container} class="w-full rounded-lg overflow-hidden" />;
}