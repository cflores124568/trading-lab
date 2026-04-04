import { createResource, createSignal, Show } from "solid-js";
import AppShell from "../components/AppShell";
import PriceChart from "../components/PriceChart";
import {
  BACKTEST_INTERVALS,
  DATABENTO_SYMBOLS,
  DEFAULT_DATABENTO_SYMBOL,
  DEFAULT_INTERVAL,
  DEFAULT_PERIOD,
  DEFAULT_YFINANCE_SYMBOL,
  getBackendInterval,
  LIVE_CHART_INTERVALS,
  PERIODS,
  YFINANCE_SYMBOLS,
} from "../constants";
import { fetchCandles, fetchYfinanceCandles, type Candle } from "../services/api";

type DashboardMode = "live" | "historical";

type DashboardQuery =
  | {
      mode: "live";
      symbol: string;
      interval: string;
      period: string;
    }
  | {
      mode: "historical";
      symbol: string;
      interval: string;
      startDate?: string;
      endDate?: string;
    };

function formatDate(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function tabClass(active: boolean): string {
  return [
    "rounded-lg px-4 py-2 text-sm font-medium transition-colors",
    active
      ? "bg-zinc-100 text-zinc-900"
      : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100",
  ].join(" ");
}

export default function Dashboard() {
  const defaultLiveInterval =
    LIVE_CHART_INTERVALS.find((interval) => interval.value === DEFAULT_INTERVAL.value) ??
    LIVE_CHART_INTERVALS[0];
  const defaultHistoricalInterval =
    BACKTEST_INTERVALS.find((interval) => interval.value === DEFAULT_INTERVAL.value) ??
    BACKTEST_INTERVALS[0];

  const [mode, setMode] = createSignal<DashboardMode>("live");

  const [liveSymbol, setLiveSymbol] = createSignal(DEFAULT_YFINANCE_SYMBOL.key);
  const [liveInterval, setLiveInterval] = createSignal(defaultLiveInterval.value);
  const [livePeriod, setLivePeriod] = createSignal(DEFAULT_PERIOD.value);

  const [historicalSymbol, setHistoricalSymbol] = createSignal(DEFAULT_DATABENTO_SYMBOL.key);
  const [historicalInterval, setHistoricalInterval] = createSignal(defaultHistoricalInterval.value);
  const [startDate, setStartDate] = createSignal(formatDate(30));
  const [endDate, setEndDate] = createSignal(formatDate(0));

  const [candles] = createResource<Candle[], DashboardQuery>(
    (): DashboardQuery => {
      if (mode() === "live") {
        const selectedInterval =
          LIVE_CHART_INTERVALS.find((interval) => interval.value === liveInterval()) ??
          defaultLiveInterval;
        return {
          mode: "live",
          symbol: liveSymbol(),
          interval: selectedInterval.yfinanceInterval!,
          period: livePeriod(),
        };
      }

      const selectedInterval =
        BACKTEST_INTERVALS.find((interval) => interval.value === historicalInterval()) ??
        defaultHistoricalInterval;

      return {
        mode: "historical",
        symbol: historicalSymbol(),
        interval: getBackendInterval(selectedInterval),
        startDate: startDate() || undefined,
        endDate: endDate() || undefined,
      };
    },
    async (query) => {
      if (query.mode === "live") {
        return fetchYfinanceCandles(query.symbol, query.interval, query.period);
      }

      if (query.startDate && query.endDate && query.startDate > query.endDate) {
        throw new Error("Start date must be before end date.");
      }

      return fetchCandles({
        symbol: query.symbol,
        interval: query.interval,
        startDate: query.startDate,
        endDate: query.endDate,
        limit: 50_000,
      });
    }
  );

  const select =
    "bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm " +
    "text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-500";
  const dateInput = `${select} min-w-40`;

  return (
    <AppShell
      title="Dashboard"
      subtitle="Toggle between live preview data and historical TimescaleDB candles."
    >
      <section class="app-panel app-panel-section">
        <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div class="space-y-3">
            <div class="flex gap-2">
              <button
                type="button"
                class={tabClass(mode() === "live")}
                onClick={() => setMode("live")}
              >
                Live
              </button>
              <button
                type="button"
                class={tabClass(mode() === "historical")}
                onClick={() => setMode("historical")}
              >
                Historical
              </button>
            </div>
          </div>

          <Show
            when={mode() === "live"}
            fallback={
              <div class="flex flex-wrap gap-3 lg:justify-end">
                <select
                  class={`${select} min-w-52`}
                  value={historicalSymbol()}
                  onChange={(e) => setHistoricalSymbol(e.currentTarget.value)}
                >
                  {DATABENTO_SYMBOLS.map((symbol) => (
                    <option value={symbol.key}>{symbol.label}</option>
                  ))}
                </select>

                <select
                  class={select}
                  value={historicalInterval()}
                  onChange={(e) => setHistoricalInterval(e.currentTarget.value)}
                >
                  {BACKTEST_INTERVALS.map((interval) => (
                    <option value={interval.value}>{interval.label}</option>
                  ))}
                </select>

                <input
                  type="date"
                  class={dateInput}
                  value={startDate()}
                  onInput={(e) => setStartDate(e.currentTarget.value)}
                />

                <input
                  type="date"
                  class={dateInput}
                  value={endDate()}
                  onInput={(e) => setEndDate(e.currentTarget.value)}
                />
              </div>
            }
          >
            <div class="flex flex-wrap gap-3 lg:justify-end">
              <select
                class={`${select} min-w-52`}
                value={liveSymbol()}
                onChange={(e) => setLiveSymbol(e.currentTarget.value)}
              >
                {YFINANCE_SYMBOLS.map((symbol) => (
                  <option value={symbol.key}>{symbol.label}</option>
                ))}
              </select>

              <select
                class={select}
                value={liveInterval()}
                onChange={(e) => setLiveInterval(e.currentTarget.value)}
              >
                {LIVE_CHART_INTERVALS.map((interval) => (
                  <option value={interval.value}>{interval.label}</option>
                ))}
              </select>

              <select
                class={select}
                value={livePeriod()}
                onChange={(e) => setLivePeriod(e.currentTarget.value)}
              >
                {PERIODS.map((period) => (
                  <option value={period.value}>{period.label}</option>
                ))}
              </select>
            </div>
          </Show>
        </div>
      </section>

      <section class="app-panel app-panel-section">
        <p class="app-kicker mb-4">
          {mode() === "live"
            ? "Live preview via Yahoo Finance"
            : "Historical candles via TimescaleDB"}
        </p>

        <Show
          when={candles.error}
          fallback={
            <Show
              when={!candles.loading}
              fallback={<div class="h-96 rounded-xl bg-zinc-950 animate-pulse" />}
            >
              <PriceChart candles={candles() ?? []} />
            </Show>
          }
        >
          {(error) => (
            <div class="flex h-96 items-center justify-center rounded-xl bg-zinc-950">
              <p class="text-sm text-red-400">Failed to load chart: {error().message}</p>
            </div>
          )}
        </Show>
      </section>
    </AppShell>
  );
}
