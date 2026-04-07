import { A } from "@solidjs/router";
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

function summaryCard(label: string, value: string) {
  return (
    <div class="app-subpanel px-4 py-3">
      <p class="app-kicker">{label}</p>
      <p class="mt-2 text-sm font-medium text-zinc-100">{value}</p>
    </div>
  );
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
  const fieldLabel = "block text-xs text-zinc-400";
  const activeSymbolLabel = () =>
    mode() === "live" ? liveSymbol() : historicalSymbol();
  const activeIntervalLabel = () =>
    mode() === "live"
      ? LIVE_CHART_INTERVALS.find((item) => item.value === liveInterval())?.label ?? liveInterval()
      : BACKTEST_INTERVALS.find((item) => item.value === historicalInterval())?.label ??
        historicalInterval();
  const sourceLabel = () =>
    mode() === "live" ? "Yahoo Finance preview feed" : "TimescaleDB historical feed";

  return (
    <AppShell
      title="Dashboard"
      subtitle="Explore live previews or query historical futures candles from the warehouse."
      actions={
        <>
          <A
            href="/replay"
            class="rounded-xl bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-white"
          >
            Open Replay Lab
          </A>
          <A
            href="/replay-sessions"
            class="rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
          >
            Saved Replay Sessions
          </A>
          <A
            href="/backtests/new"
            class="rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
          >
            New Backtest
          </A>
        </>
      }
    >
      <section class="app-panel app-panel-section">
        <div class="space-y-6">
          <div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div class="space-y-2">
              <p class="app-kicker">Data Mode</p>
              <h2 class="text-lg font-semibold text-zinc-100">Choose the chart source first</h2>
              <p class="max-w-3xl text-sm text-zinc-400">
                Switch between fast live previews and date-bounded historical candles without
                leaving the dashboard.
              </p>
            </div>

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

          <div class="grid gap-3 md:grid-cols-3">
            {summaryCard("Source", sourceLabel())}
            {summaryCard("Symbol", activeSymbolLabel())}
            {summaryCard("Interval", activeIntervalLabel())}
          </div>

          <div class="app-subpanel p-4 lg:p-5">
            <Show
              when={mode() === "live"}
              fallback={
                <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <label class="space-y-1">
                    <span class={fieldLabel}>Symbol</span>
                    <select
                      class={`${select} min-w-0 w-full`}
                      value={historicalSymbol()}
                      onChange={(e) => setHistoricalSymbol(e.currentTarget.value)}
                    >
                      {DATABENTO_SYMBOLS.map((symbol) => (
                        <option value={symbol.key}>{symbol.label}</option>
                      ))}
                    </select>
                  </label>

                  <label class="space-y-1">
                    <span class={fieldLabel}>Interval</span>
                    <select
                      class={`${select} min-w-0 w-full`}
                      value={historicalInterval()}
                      onChange={(e) => setHistoricalInterval(e.currentTarget.value)}
                    >
                      {BACKTEST_INTERVALS.map((interval) => (
                        <option value={interval.value}>{interval.label}</option>
                      ))}
                    </select>
                  </label>

                  <label class="space-y-1">
                    <span class={fieldLabel}>Start Date</span>
                    <input
                      type="date"
                      class={`${dateInput} min-w-0 w-full`}
                      value={startDate()}
                      onInput={(e) => setStartDate(e.currentTarget.value)}
                    />
                  </label>

                  <label class="space-y-1">
                    <span class={fieldLabel}>End Date</span>
                    <input
                      type="date"
                      class={`${dateInput} min-w-0 w-full`}
                      value={endDate()}
                      onInput={(e) => setEndDate(e.currentTarget.value)}
                    />
                  </label>
                </div>
              }
            >
              <div class="grid gap-3 md:grid-cols-3">
                <label class="space-y-1">
                  <span class={fieldLabel}>Symbol</span>
                  <select
                    class={`${select} min-w-0 w-full`}
                    value={liveSymbol()}
                    onChange={(e) => setLiveSymbol(e.currentTarget.value)}
                  >
                    {YFINANCE_SYMBOLS.map((symbol) => (
                      <option value={symbol.key}>{symbol.label}</option>
                    ))}
                  </select>
                </label>

                <label class="space-y-1">
                  <span class={fieldLabel}>Interval</span>
                  <select
                    class={`${select} min-w-0 w-full`}
                    value={liveInterval()}
                    onChange={(e) => setLiveInterval(e.currentTarget.value)}
                  >
                    {LIVE_CHART_INTERVALS.map((interval) => (
                      <option value={interval.value}>{interval.label}</option>
                    ))}
                  </select>
                </label>

                <label class="space-y-1">
                  <span class={fieldLabel}>Lookback</span>
                  <select
                    class={`${select} min-w-0 w-full`}
                    value={livePeriod()}
                    onChange={(e) => setLivePeriod(e.currentTarget.value)}
                  >
                    {PERIODS.map((period) => (
                      <option value={period.value}>{period.label}</option>
                    ))}
                  </select>
                </label>
              </div>
            </Show>
          </div>
        </div>
      </section>

      <section class="app-panel app-panel-section">
        <div class="mb-4 flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
          <div class="space-y-1">
            <p class="app-kicker">
              {mode() === "live"
                ? "Live preview via Yahoo Finance"
                : "Historical candles via TimescaleDB"}
            </p>
            <h2 class="text-lg font-semibold text-zinc-100">Chart Focus</h2>
            <p class="max-w-3xl text-sm text-zinc-400">
              Use this panel to validate the price path before launching a saved backtest run.
            </p>
          </div>

          <div class="app-subpanel px-4 py-3 lg:min-w-72">
            <p class="app-kicker">Current Query</p>
            <p class="mt-2 text-sm text-zinc-300">
              {activeSymbolLabel()} on {activeIntervalLabel()}
              {mode() === "live" ? ` for ${livePeriod()}` : ""}
            </p>
            <p class="mt-1 text-xs text-zinc-500">
              {mode() === "live"
                ? "Fast preview data for idea validation."
                : `${startDate() || "Earliest available"} to ${endDate() || "latest available"}`}
            </p>
          </div>
        </div>

        <Show
          when={candles.error}
          fallback={
            <Show
              when={!candles.loading}
              fallback={<div class="app-skeleton h-96" />}
            >
              <PriceChart candles={candles() ?? []} />
            </Show>
          }
        >
          {(error) => (
            <div class="app-subpanel flex h-96 items-center justify-center px-6 text-center">
              <div class="space-y-2">
                <p class="text-sm font-semibold text-red-300">Chart request failed</p>
                <p class="text-sm text-red-400">{error().message}</p>
              </div>
            </div>
          )}
        </Show>

        <Show when={!candles.loading && (candles()?.length ?? 0) === 0 && !candles.error}>
          <div class="app-subpanel mt-4 px-4 py-5">
            <p class="text-sm font-semibold text-zinc-100">No candles returned</p>
            <p class="mt-1 text-sm text-zinc-400">
              Try a wider date range or switch to another interval to populate the chart.
            </p>
          </div>
        </Show>
      </section>

      <section class="grid gap-4 lg:grid-cols-3">
        <div class="app-panel app-panel-section">
          <p class="app-kicker">Live Preview</p>
          <p class="mt-2 text-sm font-semibold text-zinc-100">Validate the market quickly</p>
          <p class="mt-1 text-sm text-zinc-400">
            Use Yahoo Finance-backed previews to sanity-check a symbol before you commit to a saved run.
          </p>
        </div>

        <div class="app-panel app-panel-section">
          <p class="app-kicker">Historical Query</p>
          <p class="mt-2 text-sm font-semibold text-zinc-100">Inspect warehouse candles</p>
          <p class="mt-1 text-sm text-zinc-400">
            Pull date-bounded futures data from TimescaleDB to mirror the inputs your backtests use.
          </p>
        </div>

        <div class="app-panel app-panel-section">
          <p class="app-kicker">Next Step</p>
          <p class="mt-2 text-sm font-semibold text-zinc-100">Launch a standalone replay</p>
          <p class="mt-1 text-sm text-zinc-400">
            When the data window looks right, jump into Replay Lab to paper trade the same market
            history without creating a saved backtest first.
          </p>
        </div>
      </section>
    </AppShell>
  );
}
