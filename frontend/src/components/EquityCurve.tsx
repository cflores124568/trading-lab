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

export interface EquityOverlaySeries {
  data: number[];
  color: string;
  lineStyle?: LineStyle;
  lineWidth?: 1 | 2 | 3 | 4;
}

interface Props {
  data: number[];
  height?: number;
  lineColor?: string;
  referenceLines?: EquityReferenceLine[];
  overlays?: EquityOverlaySeries[];
}

export default function EquityCurve(props: Props) {
  let container!: HTMLDivElement;
  let chart: IChartApi | null = null;
  let series: ISeriesApi<"Line"> | null = null;
  let didFit = false;
  let priceLines: IPriceLine[] = [];
  let overlaySeries: ISeriesApi<"Line">[] = [];

  const setSeriesData = (points: number[]) => {
    if (!series) return;

    series.setData(points.map((value, i) => ({ time: i as UTCTimestamp, value })));
    if (!didFit && points.length > 0) {
      chart?.timeScale().fitContent();
      didFit = true;
    }
  };

  const setOverlays = (overlays: EquityOverlaySeries[]) => {
    if (!chart) return;

    while (overlaySeries.length > overlays.length) chart.removeSeries(overlaySeries.pop()!);
    overlays.forEach((overlay, index) => {
      const options = {
        color: overlay.color,
        lineWidth: overlay.lineWidth ?? 1,
        lineStyle: overlay.lineStyle ?? LineStyle.Dotted,
        priceLineVisible: false,
        lastValueVisible: false,
      } as const;
      const target = overlaySeries[index] ?? chart!.addSeries(LineSeries, options);
      overlaySeries[index] = target;
      target.applyOptions(options);
      target.setData(overlay.data.map((value, i) => ({ time: i as UTCTimestamp, value })));
    });
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
      autoSize: true,
      kineticScroll: { mouse: true, touch: true },
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
      color: props.lineColor ?? "#a7c4bc",
      lineWidth: 2,
    });

    setSeriesData(props.data);
    setReferenceLines(props.referenceLines ?? []);
    setOverlays(props.overlays ?? []);

    onCleanup(() => {
      chart?.remove();
      chart = null;
      series = null;
      priceLines = [];
      overlaySeries = [];
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

  createEffect(() => {
    const overlays = props.overlays ?? [];
    setOverlays(overlays);
  });

  createEffect(() => {
    series?.applyOptions({ color: props.lineColor ?? "#a7c4bc" });
  });

  return <div ref={container} class="min-w-0 w-full overflow-hidden" style={{ height: `${props.height ?? 200}px` }} />;
}
