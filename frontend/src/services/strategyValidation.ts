import { isSessionStrategy, STRATEGY_PARAMS, type StrategyValue } from "../constants.ts";

// Validate every combination in a sweep before loading years of market data.
export function validateSessionStrategyGrid(
  strategy: StrategyValue,
  grid: Record<string, number[]>,
  intervals: string[],
): string | null {
  if (!isSessionStrategy(strategy)) return null;
  for (const param of STRATEGY_PARAMS[strategy]) {
    const values = grid[param.key] ?? [param.default];
    if (!values.length || values.some((value) => !Number.isFinite(value) || value < (param.min ?? 0))) {
      return `${param.label} needs finite values of at least ${param.min ?? 0}.`;
    }
    if (param.step === 1 && values.some((value) => !Number.isInteger(value))) {
      return `${param.label} needs whole numbers.`;
    }
  }
  const clock = (value: number) => Math.floor(value / 100) * 60 + value % 100;
  const starts = grid.session_start ?? [930];
  const ends = grid.session_end ?? [1600];
  if ([...starts, ...ends].some((value) => value > 2359 || value % 100 >= 60)) {
    return "Session times must be valid HHMM values in New York, such as 930 or 1600.";
  }
  const sessionMinutes = Math.min(...ends.map(clock)) - Math.max(...starts.map(clock));
  if (sessionMinutes <= 0) return "Every entry cutoff must be after every session start on the same day.";
  const range = grid.opening_range_minutes ?? [15];
  const warmup = grid.warmup_minutes ?? [15];
  if (strategy === "orb" && Math.max(...range) >= sessionMinutes) {
    return "Every opening range must be shorter than the entry session.";
  }
  if (strategy === "vwap_mean_reversion" && Math.max(...warmup) >= sessionMinutes) {
    return "Every VWAP warmup must be shorter than the entry session.";
  }
  const distance = strategy === "orb" ? grid.breakout_buffer_percent : grid.entry_deviation_percent;
  if (distance?.some((value) => value > 10)) return "Buffer and VWAP distance values must not exceed 10%.";
  if ((grid.vwap_bias ?? [0]).some((value) => !Number.isInteger(value) || value < 0 || value > 1)) {
    return "VWAP bias accepts only 0 or 1.";
  }
  if (strategy === "vwap_mean_reversion" && (grid.vwap_bias ?? [0]).some((value) => value !== 0)) {
    return "VWAP alignment blocks mean-reversion entries and must be off.";
  }
  for (const interval of intervals) {
    const match = /^(\d+)(min|m|h)$/.exec(interval);
    const minutes = match ? Number(match[1]) * (match[2] === "h" ? 60 : 1) : 0;
    if (minutes <= 0 || minutes > 60 || minutes >= sessionMinutes) {
      return "ORB and VWAP mean reversion need intraday bars of at most one hour, shorter than the session.";
    }
    // UTC-aligned source buckets must also align in both New York DST offsets.
    if (starts.some((start) => (clock(start) + 240) % minutes !== 0 || (clock(start) + 300) % minutes !== 0)) {
      return `${interval} bars do not align with the session start. Choose a smaller interval or adjust the start time.`;
    }
    if (strategy === "orb" && range.some((value) => value % minutes !== 0)) {
      return `Every opening range must be a multiple of ${interval}. A 15-minute range supports 1m, 5m, and 15m.`;
    }
  }
  return null;
}
