import type { PriceChartIndicatorSettings } from "../services/chartIndicators";

interface Props {
  settings: PriceChartIndicatorSettings;
  onToggle: (key: keyof PriceChartIndicatorSettings) => void;
  compact?: boolean;
}

const indicatorOptions: { key: keyof PriceChartIndicatorSettings; label: string }[] = [
  { key: "ema9", label: "EMA 9" },
  { key: "ema20", label: "EMA 20" },
  { key: "ema50", label: "EMA 50" },
  { key: "vwap", label: "VWAP" },
  { key: "sessionHighLow", label: "Session H/L" },
  { key: "previousDayHighLow", label: "Prev Day H/L" },
  { key: "levelTrail", label: "Level Trail" },
  { key: "volume", label: "Volume" },
];

export default function ChartIndicatorToggleBar(props: Props) {
  if (props.compact) {
    return (
      <div class="flex flex-wrap gap-2">
        {indicatorOptions.map((option) => (
          <button
            type="button"
            onClick={() => props.onToggle(option.key)}
            class={`rounded-sm border px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em] transition-colors ${
              props.settings[option.key]
                ? "border-sky-500 bg-sky-500/15 text-sky-100"
                : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div class="rounded-md border border-zinc-800 bg-zinc-950/60 p-4">
      <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div class="space-y-1">
          <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Chart Studies</p>
          <p class="text-sm text-zinc-400">
            Keep the chart focused. Turn on only the context you actually need.
          </p>
        </div>

        <div class="flex flex-wrap gap-2">
          {indicatorOptions.map((option) => (
          <button
            type="button"
            onClick={() => props.onToggle(option.key)}
            class={`rounded-sm border px-3 py-2 text-xs font-medium uppercase tracking-[0.16em] transition-colors ${
              props.settings[option.key]
                ? "border-sky-500 bg-sky-500/15 text-sky-100"
                : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
