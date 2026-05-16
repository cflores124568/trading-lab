import { onMount, onCleanup, createEffect } from "solid-js";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

interface Props {
  data: number[];
  height?: number;
}

export default function EquityCurve(props: Props) {
  let container!: HTMLDivElement;
  let chart: IChartApi | null = null;
  let series: ISeriesApi<"Line"> | null = null;

  onMount(() => {
    chart = createChart(container, {
      height: props.height ?? 200,
      layout: {
        background: { color: "#09090b" },
        textColor: "#a1a1aa",
      },
      grid: {
        vertLines: { color: "#27272a" },
        horzLines: { color: "#27272a" },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { visible: false },
    });

    series = chart.addSeries(LineSeries, {
      color: "#3b82f6",
      lineWidth: 2,
    });

    onCleanup(() => {
      chart?.remove();
      chart = null;
      series = null;
    });
  });

  // Re-render the series whenever the equity curve gets new points so the
  // chart actually tracks the live replay instead of freezing on the first frame.
  createEffect(() => {
    const points = props.data;
    if (!series) return;
    series.setData(points.map((value, i) => ({ time: i as UTCTimestamp, value })));
    chart?.timeScale().fitContent();
  });

  return <div ref={container} class="w-full overflow-hidden" style={{ "border-radius": "0" }} />;
}
