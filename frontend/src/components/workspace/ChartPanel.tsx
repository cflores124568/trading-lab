import { createMemo, createResource, Show } from "solid-js";
import PriceChart from "../PriceChart";
import {
  BACKTEST_INTERVALS,
  DATABENTO_SYMBOLS,
  DEFAULT_INTERVAL,
  DEFAULT_PERIOD,
  getBackendInterval,
  LIVE_CHART_INTERVALS,
  PERIODS,
  YFINANCE_SYMBOLS,
} from "../../constants";
import { fetchCandles, fetchYfinanceCandles, type Candle } from "../../services/api";
import type { ChartPanelConfig, ChartPanelQuery } from "./chartPanelTypes";

interface Props {
  panel: ChartPanelConfig;
  canRemove: boolean;
  onQueryChange: (query: ChartPanelQuery) => void;
  onRemove: () => void;
}

type LiveChartPanelQuery = Extract<ChartPanelQuery, { mode: "live" }>;
type HistoricalChartPanelQuery = Extract<ChartPanelQuery, { mode: "historical" }>;

const field =
  "w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 " +
  "focus:outline-none focus:ring-1 focus:ring-zinc-500";

function summarizeQuery(query: ChartPanelQuery): string {
  if (query.mode === "live") {
    return `${query.symbol} on ${query.interval} for ${query.period}`;
  }

  return `${query.symbol} on ${query.interval} from ${query.startDate} to ${query.endDate}`;
}

function getLiveInterval(value: string): string {
  return LIVE_CHART_INTERVALS.find((interval) => interval.value === value)?.value ?? DEFAULT_INTERVAL.value;
}

function toLiveQuery(query: ChartPanelQuery): ChartPanelQuery {
  return {
    mode: "live",
    symbol: query.symbol,
    interval: getLiveInterval(query.interval),
    period: DEFAULT_PERIOD.value,
  };
}

function toHistoricalQuery(query: ChartPanelQuery): ChartPanelQuery {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  return {
    mode: "historical",
    symbol: query.symbol,
    interval: query.interval,
    startDate: monthStart,
    endDate: today,
  };
}

export default function ChartPanel(props: Props) {
  const query = createMemo(() => props.panel.query);

  const [candles] = createResource<Candle[], ChartPanelQuery>(query, async (nextQuery) => {
    if (nextQuery.mode === "live") {
      const selectedInterval =
        LIVE_CHART_INTERVALS.find((interval) => interval.value === nextQuery.interval) ??
        LIVE_CHART_INTERVALS[0];
      return fetchYfinanceCandles(
        nextQuery.symbol,
        selectedInterval.yfinanceInterval,
        nextQuery.period,
      );
    }

    if (nextQuery.startDate > nextQuery.endDate) {
      throw new Error("Start date must be before end date.");
    }

    const selectedInterval =
      BACKTEST_INTERVALS.find((interval) => interval.value === nextQuery.interval) ??
      DEFAULT_INTERVAL;

    return fetchCandles({
      symbol: nextQuery.symbol,
      interval: getBackendInterval(selectedInterval),
      startDate: nextQuery.startDate,
      endDate: nextQuery.endDate,
      limit: 50_000,
    });
  });

  const panelSummary = createMemo(() => summarizeQuery(query()));
  const liveQuery = createMemo<LiveChartPanelQuery | null>(() => {
    const nextQuery = query();
    return nextQuery.mode === "live" ? nextQuery : null;
  });
  const historicalQuery = createMemo<HistoricalChartPanelQuery | null>(() => {
    const nextQuery = query();
    return nextQuery.mode === "historical" ? nextQuery : null;
  });

  const setMode = (mode: "live" | "historical") => {
    const current = query();
    props.onQueryChange(mode === "live" ? toLiveQuery(current) : toHistoricalQuery(current));
  };

  const updateQuery = (nextQuery: ChartPanelQuery | ((current: ChartPanelQuery) => ChartPanelQuery)) => {
    const current = query();
    props.onQueryChange(typeof nextQuery === "function" ? nextQuery(current) : nextQuery);
  };

  return (
    <section class="app-panel app-panel-section flex h-full min-h-[560px] flex-col space-y-4">
      <div class="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div class="space-y-1">
          <p class="app-kicker">{query().mode === "live" ? "Live Preview" : "Historical Query"}</p>
          <h3 class="text-base font-semibold text-zinc-100">{props.panel.title}</h3>
          <p class="text-sm text-zinc-400">{panelSummary()}</p>
        </div>

        <div class="flex flex-wrap justify-end gap-2">
          <Show when={props.canRemove}>
            <button
              type="button"
              class="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
              onClick={props.onRemove}
            >
              Remove
            </button>
          </Show>
          <button
            type="button"
            class={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              query().mode === "live"
                ? "bg-zinc-100 text-zinc-950"
                : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            }`}
            onClick={() => setMode("live")}
          >
            Live
          </button>
          <button
            type="button"
            class={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              query().mode === "historical"
                ? "bg-zinc-100 text-zinc-950"
                : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            }`}
            onClick={() => setMode("historical")}
          >
            Historical
          </button>
        </div>
      </div>

      <div class="app-subpanel p-4">
        <Show
          when={query().mode === "live"}
          fallback={
            <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <label class="space-y-1">
                <span class="block text-xs text-zinc-400">Symbol</span>
                <select
                  class={field}
                  value={query().symbol}
                  onChange={(event) =>
                    updateQuery((current) => ({ ...current, symbol: event.currentTarget.value }))
                  }
                >
                  {DATABENTO_SYMBOLS.map((symbol) => (
                    <option value={symbol.key}>{symbol.label}</option>
                  ))}
                </select>
              </label>

              <label class="space-y-1">
                <span class="block text-xs text-zinc-400">Interval</span>
                <select
                  class={field}
                  value={query().interval}
                  onChange={(event) =>
                    updateQuery((current) => ({ ...current, interval: event.currentTarget.value }))
                  }
                >
                  {BACKTEST_INTERVALS.map((interval) => (
                    <option value={interval.value}>{interval.label}</option>
                  ))}
                </select>
              </label>

              <label class="space-y-1">
                <span class="block text-xs text-zinc-400">Start Date</span>
                <input
                  type="date"
                  class={field}
                  value={historicalQuery()?.startDate ?? ""}
                  onInput={(event) =>
                    updateQuery((current) =>
                      current.mode === "historical"
                        ? { ...current, startDate: event.currentTarget.value }
                        : current,
                    )
                  }
                />
              </label>

              <label class="space-y-1">
                <span class="block text-xs text-zinc-400">End Date</span>
                <input
                  type="date"
                  class={field}
                  value={historicalQuery()?.endDate ?? ""}
                  onInput={(event) =>
                    updateQuery((current) =>
                      current.mode === "historical"
                        ? { ...current, endDate: event.currentTarget.value }
                        : current,
                    )
                  }
                />
              </label>
            </div>
          }
        >
          <div class="grid gap-3 md:grid-cols-3">
            <label class="space-y-1">
              <span class="block text-xs text-zinc-400">Symbol</span>
              <select
                class={field}
                value={query().symbol}
                onChange={(event) =>
                  updateQuery((current) => ({ ...current, symbol: event.currentTarget.value }))
                }
              >
                {YFINANCE_SYMBOLS.map((symbol) => (
                  <option value={symbol.key}>{symbol.label}</option>
                ))}
              </select>
            </label>

            <label class="space-y-1">
              <span class="block text-xs text-zinc-400">Interval</span>
              <select
                class={field}
                value={query().interval}
                onChange={(event) =>
                  updateQuery((current) => ({ ...current, interval: event.currentTarget.value }))
                }
              >
                {LIVE_CHART_INTERVALS.map((interval) => (
                  <option value={interval.value}>{interval.label}</option>
                ))}
              </select>
            </label>

            <label class="space-y-1">
              <span class="block text-xs text-zinc-400">Lookback</span>
              <select
                class={field}
                value={liveQuery()?.period ?? DEFAULT_PERIOD.value}
                onChange={(event) =>
                  updateQuery((current) =>
                    current.mode === "live"
                      ? { ...current, period: event.currentTarget.value }
                      : current,
                  )
                }
              >
                {PERIODS.map((period) => (
                  <option value={period.value}>{period.label}</option>
                ))}
              </select>
            </label>
          </div>
        </Show>
      </div>

      <Show
        when={candles.error}
        fallback={
          <Show when={!candles.loading} fallback={<div class="app-skeleton min-h-[320px] flex-1" />}>
            <div class="min-h-[320px] flex-1">
              <PriceChart candles={candles() ?? []} class="h-full" />
            </div>
          </Show>
        }
      >
        {(error) => (
          <div class="app-subpanel flex min-h-[320px] flex-1 items-center justify-center px-6 text-center">
            <div class="space-y-2">
              <p class="text-sm font-semibold text-red-300">Chart request failed</p>
              <p class="text-sm text-red-400">{error().message}</p>
            </div>
          </div>
        )}
      </Show>

      <Show when={!candles.loading && (candles()?.length ?? 0) === 0 && !candles.error}>
        <div class="app-subpanel min-h-[320px] flex-1 px-4 py-5">
          <p class="text-sm font-semibold text-zinc-100">No candles returned</p>
          <p class="mt-1 text-sm text-zinc-400">
            Try a wider date range or switch to another interval so the panel has something to
            work with.
          </p>
        </div>
      </Show>
    </section>
  );
}
