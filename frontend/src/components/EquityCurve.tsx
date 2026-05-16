import { onMount, onCleanup, createEffect } from "solid-js";
import {
  createChart,
  LineStyle,
  LineSeries,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

export interface EquityReferenceLine {
  value: number;
  title: string;
  color: string;
  lineStyle?: LineStyle;
}

interface Props {
  data: number[];
  height?: number;
  lineColor?: string;
  referenceLines?: EquityReferenceLine[];
}

export default function EquityCurve(props: Props) {
  let container!: HTMLDivElement;
  let chart: IChartApi | null = null;
  let series: ISeriesApi<"Line"> | null = null;
  let priceLines: IPriceLine[] = [];

  const setSeriesData = (points: number[]) => {
    if (!series) return;

    series.setData(points.map((value, i) => ({ time: i as UTCTimestamp, value })));
    chart?.timeScale().fitContent();
  };

  const setReferenceLines = (lines: EquityReferenceLine[]) => {
    if (!series) return;

    for (const line of priceLines) {
      series.removePriceLine(line);
    }

    priceLines = [];

    for (const line of lines) {
      if (!Number.isFinite(line.value)) continue;

      priceLines.push(
        series.createPriceLine({
          price: line.value,
          color: line.color,
          lineWidth: 1,
          lineStyle: line.lineStyle ?? LineStyle.Dashed,
          axisLabelVisible: true,
          title: line.title,
        }),
      );
    }
  };

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
      color: props.lineColor ?? "#3b82f6",
      lineWidth: 2,
    });

    setSeriesData(props.data);
    setReferenceLines(props.referenceLines ?? []);

    onCleanup(() => {
      chart?.remove();
      chart = null;
      series = null;
      priceLines = [];
    });
  });

  // Re-render the series whenever the equity curve gets new points so the
  // chart actually tracks the live replay instead of freezing on the first frame.
  createEffect(() => {
    const points = props.data;
    setSeriesData(points);
  });

  createEffect(() => {
    const lines = props.referenceLines ?? [];
    setReferenceLines(lines);
  });

  return <div ref={container} class="w-full overflow-hidden" style={{ "border-radius": "0" }} />;
}
