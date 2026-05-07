import type { UTCTimestamp } from "lightweight-charts";
import type { Candle } from "./api";

export interface PriceChartIndicatorSettings {
  ema9: boolean;
  ema20: boolean;
  ema50: boolean;
  vwap: boolean;
  sessionHighLow: boolean;
  previousDayHighLow: boolean;
  volume: boolean;
  levelTrail: boolean;
}

export interface IndicatorLinePoint {
  time: UTCTimestamp;
  value: number;
}

export interface VolumeHistogramPoint {
  time: UTCTimestamp;
  value: number;
  color: string;
}

export interface PriceChartIndicatorSeries {
  ema9: IndicatorLinePoint[];
  ema20: IndicatorLinePoint[];
  ema50: IndicatorLinePoint[];
  vwap: IndicatorLinePoint[];
  sessionHigh: IndicatorLinePoint[];
  sessionLow: IndicatorLinePoint[];
  previousDayHigh: IndicatorLinePoint[];
  previousDayLow: IndicatorLinePoint[];
  volume: VolumeHistogramPoint[];
}

const DEFAULT_INDICATOR_SETTINGS: PriceChartIndicatorSettings = {
  ema9: false,
  ema20: true,
  ema50: false,
  vwap: true,
  sessionHighLow: false,
  previousDayHighLow: false,
  volume: false,
  levelTrail: false,
};

const NEW_YORK_TIMEZONE = "America/New_York";
const SESSION_ROLLOVER_HOUR = 18;

const nyTimePartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: NEW_YORK_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function cmeSessionKey(time: number): string {
  const parts = nyTimePartsFormatter.formatToParts(new Date(time * 1000));
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((entry) => entry.type === type)?.value ?? 0);

  const year = part("year");
  const month = part("month");
  const day = part("day");
  const hour = part("hour");

  // CME ETH session rolls at 6:00 PM ET; after that we treat bars as next trading day.
  const base = new Date(Date.UTC(year, month - 1, day));
  if (hour >= SESSION_ROLLOVER_HOUR) {
    base.setUTCDate(base.getUTCDate() + 1);
  }

  return base.toISOString().slice(0, 10);
}

function pushLinePoint(
  target: IndicatorLinePoint[],
  candle: Candle,
  value: number | undefined,
): void {
  if (value === undefined || !Number.isFinite(value)) {
    return;
  }

  target.push({
    time: candle.time,
    value,
  });
}

function computeEmaSeries(candles: Candle[], period: number): IndicatorLinePoint[] {
  if (period <= 0 || candles.length < period) {
    return [];
  }

  const seed =
    candles.slice(0, period).reduce((sum, candle) => sum + candle.close, 0) / period;
  const smoothing = 2 / (period + 1);
  const points: IndicatorLinePoint[] = [
    {
      time: candles[period - 1].time,
      value: seed,
    },
  ];

  let previous = seed;
  for (let index = period; index < candles.length; index += 1) {
    const current = candles[index].close * smoothing + previous * (1 - smoothing);
    points.push({
      time: candles[index].time,
      value: current,
    });
    previous = current;
  }

  return points;
}

function computeSessionAwareVwap(candles: Candle[]): IndicatorLinePoint[] {
  const points: IndicatorLinePoint[] = [];
  let currentSession = "";
  let cumulativeTypicalPriceVolume = 0;
  let cumulativeVolume = 0;

  for (const candle of candles) {
    const sessionKey = cmeSessionKey(Number(candle.time));
    if (sessionKey !== currentSession) {
      currentSession = sessionKey;
      cumulativeTypicalPriceVolume = 0;
      cumulativeVolume = 0;
    }

    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    cumulativeTypicalPriceVolume += typicalPrice * candle.volume;
    cumulativeVolume += candle.volume;

    if (cumulativeVolume > 0) {
      points.push({
        time: candle.time,
        value: cumulativeTypicalPriceVolume / cumulativeVolume,
      });
    }
  }

  return points;
}

function computeSessionHighLow(candles: Candle[]): {
  high: IndicatorLinePoint[];
  low: IndicatorLinePoint[];
} {
  const high: IndicatorLinePoint[] = [];
  const low: IndicatorLinePoint[] = [];
  let currentSession = "";
  let sessionHigh = Number.NEGATIVE_INFINITY;
  let sessionLow = Number.POSITIVE_INFINITY;

  for (const candle of candles) {
    const sessionKey = cmeSessionKey(Number(candle.time));
    if (sessionKey !== currentSession) {
      currentSession = sessionKey;
      sessionHigh = candle.high;
      sessionLow = candle.low;
    } else {
      sessionHigh = Math.max(sessionHigh, candle.high);
      sessionLow = Math.min(sessionLow, candle.low);
    }

    pushLinePoint(high, candle, sessionHigh);
    pushLinePoint(low, candle, sessionLow);
  }

  return { high, low };
}

function computePreviousDayLevels(candles: Candle[]): {
  high: IndicatorLinePoint[];
  low: IndicatorLinePoint[];
} {
  if (candles.length === 0) {
    return { high: [], low: [] };
  }

  const dailyRanges = new Map<string, { high: number; low: number }>();
  const orderedSessions: string[] = [];

  for (const candle of candles) {
    const sessionKey = cmeSessionKey(Number(candle.time));
    const current = dailyRanges.get(sessionKey);

    if (!current) {
      dailyRanges.set(sessionKey, { high: candle.high, low: candle.low });
      orderedSessions.push(sessionKey);
      continue;
    }

    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
  }

  const previousRangeBySession = new Map<string, { high: number; low: number }>();
  for (let index = 1; index < orderedSessions.length; index += 1) {
    const previousSession = orderedSessions[index - 1];
    const currentSession = orderedSessions[index];
    previousRangeBySession.set(currentSession, dailyRanges.get(previousSession)!);
  }

  const high: IndicatorLinePoint[] = [];
  const low: IndicatorLinePoint[] = [];

  for (const candle of candles) {
    const previousRange = previousRangeBySession.get(cmeSessionKey(Number(candle.time)));
    if (!previousRange) {
      continue;
    }

    pushLinePoint(high, candle, previousRange.high);
    pushLinePoint(low, candle, previousRange.low);
  }

  return { high, low };
}

function computeVolumeSeries(candles: Candle[]): VolumeHistogramPoint[] {
  return candles.map((candle) => ({
    time: candle.time,
    value: candle.volume,
    color:
      candle.close >= candle.open
        ? "rgba(16, 185, 129, 0.55)"
        : "rgba(244, 63, 94, 0.55)",
  }));
}

export function defaultPriceChartIndicatorSettings(): PriceChartIndicatorSettings {
  return { ...DEFAULT_INDICATOR_SETTINGS };
}

export function normalizePriceChartIndicatorSettings(
  value: Partial<PriceChartIndicatorSettings> | null | undefined,
): PriceChartIndicatorSettings {
  return {
    ema9: value?.ema9 ?? DEFAULT_INDICATOR_SETTINGS.ema9,
    ema20: value?.ema20 ?? DEFAULT_INDICATOR_SETTINGS.ema20,
    ema50: value?.ema50 ?? DEFAULT_INDICATOR_SETTINGS.ema50,
    vwap: value?.vwap ?? DEFAULT_INDICATOR_SETTINGS.vwap,
    sessionHighLow: value?.sessionHighLow ?? DEFAULT_INDICATOR_SETTINGS.sessionHighLow,
    previousDayHighLow:
      value?.previousDayHighLow ?? DEFAULT_INDICATOR_SETTINGS.previousDayHighLow,
    volume: value?.volume ?? DEFAULT_INDICATOR_SETTINGS.volume,
    levelTrail: value?.levelTrail ?? DEFAULT_INDICATOR_SETTINGS.levelTrail,
  };
}

export function buildPriceChartIndicatorSeries(candles: Candle[]): PriceChartIndicatorSeries {
  const sessionHighLow = computeSessionHighLow(candles);
  const previousDayLevels = computePreviousDayLevels(candles);

  return {
    ema9: computeEmaSeries(candles, 9),
    ema20: computeEmaSeries(candles, 20),
    ema50: computeEmaSeries(candles, 50),
    vwap: computeSessionAwareVwap(candles),
    sessionHigh: sessionHighLow.high,
    sessionLow: sessionHighLow.low,
    previousDayHigh: previousDayLevels.high,
    previousDayLow: previousDayLevels.low,
    volume: computeVolumeSeries(candles),
  };
}
