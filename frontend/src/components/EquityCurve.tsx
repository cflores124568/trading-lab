import { onMount, onCleanup } from "solid-js";
import { createChart, LineSeries, type UTCTimestamp } from "lightweight-charts";

interface Props {
  data: number[];
  height?: number;
}

export default function EquityCurve(props: Props) {
  let container!: HTMLDivElement;

  onMount(() => {
    const chart = createChart(container, {
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

    const series = chart.addSeries(LineSeries, {
      color: "#3b82f6",
      lineWidth: 2,
    });

    // Equity curve has no real timestamps so I use bar index as synthetic time
    // UTCTimestamp cast satisfies Lightweight Charts' branded number type
    series.setData(
      props.data.map((value, i) => ({ time: i as UTCTimestamp, value }))
    );

    onCleanup(() => chart.remove());
  });

  return <div ref={container} class="w-full overflow-hidden" style={{ "border-radius": "0" }} />;
}
