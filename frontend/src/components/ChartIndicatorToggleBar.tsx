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
                ? "border-[rgba(232,223,209,0.78)] bg-[rgba(235,227,213,0.1)] text-stone-50"
                : "border-white/10 bg-white/[0.04] text-stone-400 hover:border-white/18 hover:text-stone-200"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div class="app-surface-muted p-4">
      <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <p class="text-xs uppercase tracking-[0.18em] text-stone-500">Indicators</p>

        <div class="flex flex-wrap gap-2">
          {indicatorOptions.map((option) => (
          <button
            type="button"
            onClick={() => props.onToggle(option.key)}
            class={`rounded-sm border px-3 py-2 text-xs font-medium uppercase tracking-[0.16em] transition-colors ${
              props.settings[option.key]
                ? "border-[rgba(232,223,209,0.78)] bg-[rgba(235,227,213,0.1)] text-stone-50"
                : "border-white/10 bg-white/[0.04] text-stone-400 hover:border-white/18 hover:text-stone-200"
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
