import { createEffect, createMemo, createResource, createSignal, onCleanup, Show } from "solid-js";
import {
  Copy,
  Ellipsis,
  Expand,
  GripVertical,
  History,
  Minimize2,
  Radio,
  SlidersHorizontal,
  Trash2,
} from "lucide-solid";
import ChartIndicatorToggleBar from "../ChartIndicatorToggleBar";
import PriceChart from "../PriceChart";
import {
  normalizePriceChartIndicatorSettings,
  type PriceChartIndicatorSettings,
} from "../../services/chartIndicators";
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
import {
  fetchCandles,
  fetchDbSymbolRange,
  fetchYfinanceCandles,
  type Candle,
} from "../../services/api";
import {
  MAX_PANEL_TITLE_LENGTH,
  normalizePanelTitle,
  type ChartPanelConfig,
  type ChartPanelQuery,
} from "./chartPanelTypes";

interface Props {
  panel: ChartPanelConfig;
  canRemove: boolean;
  canDuplicate: boolean;
  canReorder: boolean;
  expanded?: boolean;
  onTitleChange: (title: string) => void;
  onQueryChange: (query: ChartPanelQuery) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onToggleExpand: () => void;
  onReorderDragStart: (event: DragEvent) => void;
  onReorderDragEnd: () => void;
}

type LiveChartPanelQuery = Extract<ChartPanelQuery, { mode: "live" }>;
type HistoricalChartPanelQuery = Extract<ChartPanelQuery, { mode: "historical" }>;

const field =
  "app-input w-full text-sm";

function summarizeQuery(query: ChartPanelQuery): string {
  if (query.mode === "live") {
    return `${query.symbol} on ${query.interval} for ${query.period}`;
  }

  return `${query.symbol} on ${query.interval} from ${query.startDate || "Earliest"} to ${query.endDate || "Latest"}`;
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
    indicators: normalizePriceChartIndicatorSettings(query.indicators),
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
    indicators: normalizePriceChartIndicatorSettings(query.indicators),
  };
}

function shiftDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

// Stored futures data stops at the last Databento pull, so ranges built from
// "today" can start after the final bar and come back empty. Slide that kind of
// window back so it ends on the last bar, keeping its length.
function anchorToLatestBar(
  query: HistoricalChartPanelQuery,
  latestBarDate: string,
): HistoricalChartPanelQuery | null {
  if (!query.startDate || query.startDate <= latestBarDate) {
    return null;
  }

  const spanDays =
    query.endDate && query.endDate > query.startDate
      ? Math.round((Date.parse(query.endDate) - Date.parse(query.startDate)) / 86_400_000)
      : 30;

  return {
    ...query,
    startDate: shiftDays(latestBarDate, -spanDays),
    endDate: latestBarDate,
  };
}

function fetchKey(query: ChartPanelQuery): string {
  return query.mode === "live"
    ? `live|${query.symbol}|${query.interval}|${query.period}`
    : `historical|${query.symbol}|${query.interval}|${query.startDate ?? ""}|${query.endDate ?? ""}`;
}

export default function ChartPanel(props: Props) {
  const query = createMemo(() => props.panel.query);
  // The store merges query updates into the same object, so `query` keeps its
  // identity and never refetches on its own. Snapshot it whenever a field the
  // fetch depends on changes; indicator toggles don't reload the bars.
  const fetchQuery = createMemo((): ChartPanelQuery => ({ ...props.panel.query }), undefined, {
    equals: (prev, next) => fetchKey(prev) === fetchKey(next),
  });
  const [titleDraft, setTitleDraft] = createSignal(props.panel.title);
  const [showControls, setShowControls] = createSignal(false);
  const [showMenu, setShowMenu] = createSignal(false);
  let menuRoot: HTMLDivElement | undefined;

  createEffect(() => {
    setTitleDraft(props.panel.title);
  });

  createEffect(() => {
    if (!showMenu()) {
      return;
    }

    const closeMenu = (event: PointerEvent) => {
      if (!menuRoot?.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };

    window.addEventListener("pointerdown", closeMenu);
    onCleanup(() => window.removeEventListener("pointerdown", closeMenu));
  });

  const [candles] = createResource<Candle[], ChartPanelQuery>(fetchQuery, async (nextQuery) => {
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

    if (
      nextQuery.startDate &&
      nextQuery.endDate &&
      nextQuery.startDate > nextQuery.endDate
    ) {
      throw new Error("Start date must be before end date.");
    }

    const selectedInterval =
      BACKTEST_INTERVALS.find((interval) => interval.value === nextQuery.interval) ??
      DEFAULT_INTERVAL;

    const bars = await fetchCandles({
      symbol: nextQuery.symbol,
      interval: getBackendInterval(selectedInterval),
      startDate: nextQuery.startDate || undefined,
      endDate: nextQuery.endDate || undefined,
      limit: 50_000,
    });

    if (bars.length === 0 && nextQuery.startDate) {
      const latestBarDate = await fetchDbSymbolRange(nextQuery.symbol)
        .then((range) => range.end_date.slice(0, 10))
        .catch(() => null);
      const anchored = latestBarDate ? anchorToLatestBar(nextQuery, latestBarDate) : null;
      if (anchored) {
        // Saving the shifted dates re-runs this resource against them.
        props.onQueryChange(anchored);
      }
    }

    return bars;
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
  const indicatorSettings = createMemo(() =>
    normalizePriceChartIndicatorSettings(query().indicators),
  );
  const modeLabel = createMemo(() => (query().mode === "live" ? "Live" : "History"));
  const enabledStudyCount = createMemo(
    () => Object.values(indicatorSettings()).filter(Boolean).length,
  );
  const panelStateLabel = createMemo(() => {
    if (candles.loading) {
      return "Loading";
    }

    if (candles.error) {
      return "Issue";
    }

    const count = candles()?.length ?? 0;
    return count > 0 ? `${count.toLocaleString()} bars` : "Empty";
  });
  const panelStateTone = createMemo(() => {
    if (candles.loading) {
      return "border-amber-700/70 bg-amber-950/70 text-amber-200";
    }

    if (candles.error) {
      return "border-red-800 bg-red-950/60 text-red-200";
    }

    return "border-green-800/70 bg-green-950/40 text-green-200";
  });

  const setMode = (mode: "live" | "historical") => {
    const current = query();
    props.onQueryChange(mode === "live" ? toLiveQuery(current) : toHistoricalQuery(current));
  };

  const updateQuery = (nextQuery: ChartPanelQuery | ((current: ChartPanelQuery) => ChartPanelQuery)) => {
    const current = query();
    props.onQueryChange(typeof nextQuery === "function" ? nextQuery(current) : nextQuery);
  };
  const toggleIndicator = (key: keyof PriceChartIndicatorSettings) => {
    updateQuery((current) => {
      const settings = normalizePriceChartIndicatorSettings(current.indicators);
      return {
        ...current,
        indicators: {
          ...settings,
          [key]: !settings[key],
        },
      };
    });
  };
  const commitTitle = () => {
    const nextTitle = normalizePanelTitle(titleDraft(), props.panel.title);
    setTitleDraft(nextTitle);
    props.onTitleChange(nextTitle);
  };

  return (
    <section
      class={`app-panel app-panel-interactive flex h-full min-h-0 flex-col overflow-hidden ${
        props.expanded ? "app-panel-selected" : ""
      }`}
      style={{ "border-radius": "0" }}
    >
      <div class="border-b border-stone-700/80 bg-stone-950/92 px-4 py-3">
        <div class="flex flex-col gap-2.5 xl:flex-row xl:items-center xl:justify-between">
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 flex-wrap items-center gap-1.5">
              <Show when={props.canReorder}>
                <button
                  type="button"
                  draggable
                  title="Drag to reorder panel"
                  aria-label="Drag to reorder panel"
                  class="inline-flex h-7 w-7 cursor-grab items-center justify-center rounded-sm border border-stone-700 bg-stone-950 text-stone-500 transition-colors hover:border-stone-600 hover:text-stone-200 active:cursor-grabbing"
                  onDragStart={props.onReorderDragStart}
                  onDragEnd={props.onReorderDragEnd}
                >
                  <GripVertical size={15} />
                </button>
              </Show>
              <h3 class="truncate text-sm font-semibold text-stone-100">{props.panel.title}</h3>
              <span class="rounded-sm border border-stone-700 bg-stone-900 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-200">
                {query().symbol}
              </span>
              <span class="rounded-sm border border-stone-700/80 bg-stone-950 px-2 py-1 text-[11px] text-stone-400">
                <span class="app-data">{query().interval}</span> · {modeLabel()}
              </span>
              <span class={`rounded-sm border px-2 py-1 text-[11px] font-medium ${panelStateTone()}`}>
                {panelStateLabel()}
              </span>
              <span class="text-xs text-stone-500">
                {enabledStudyCount()} {enabledStudyCount() === 1 ? "indicator" : "indicators"}
              </span>
            </div>
            <p class="mt-1 truncate text-xs text-stone-500">{panelSummary()}</p>
          </div>

          <div class="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              title="Switch to live mode"
              class={`inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                query().mode === "live"
                  ? "app-card-selected border-stone-200/80 text-stone-50"
                  : "border-stone-700 bg-stone-900 text-stone-400 hover:border-stone-600 hover:bg-stone-800 hover:text-stone-100"
              }`}
              onClick={() => setMode("live")}
            >
              <Radio size={14} />
              Live
            </button>
            <button
              type="button"
              title="Switch to historical mode"
              class={`inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1.5 text-xs font-medium transition-colors ${
              query().mode === "historical"
                ? "app-card-selected text-stone-50"
                : "border-white/10 bg-white/[0.04] text-stone-400 hover:border-white/18 hover:bg-white/[0.06] hover:text-stone-100"
              }`}
              onClick={() => setMode("historical")}
            >
              <History size={14} />
              Historical
            </button>
            <button
              type="button"
              title={showControls() ? "Hide panel controls" : "Show panel controls"}
              class={`inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                showControls()
                  ? "border-[rgba(232,223,209,0.78)] bg-[rgba(235,227,213,0.1)] text-stone-50"
                  : "border-white/10 bg-white/[0.04] text-stone-300 hover:border-white/18 hover:text-stone-100"
              }`}
              onClick={() => setShowControls((current) => !current)}
            >
              <SlidersHorizontal size={14} />
              {showControls() ? "Hide controls" : "Controls"}
            </button>

            <div ref={menuRoot} class="relative">
              <button
                type="button"
                title="Panel actions"
                aria-label="Panel actions"
                class="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs font-medium text-stone-400 transition-colors hover:border-white/18 hover:text-stone-200"
                onClick={() => setShowMenu((current) => !current)}
              >
                <Ellipsis size={15} />
              </button>

              <Show when={showMenu()}>
                <div class="absolute right-0 top-[calc(100%+0.5rem)] z-30 w-48 rounded-sm border border-white/10 bg-[#0b0b0b]/98 p-2 shadow-2xl shadow-black/40">
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-sm text-stone-200 transition-colors hover:bg-white/[0.05]"
                    onClick={() => {
                      setShowMenu(false);
                      props.onToggleExpand();
                    }}
                  >
                    {props.expanded ? <Minimize2 size={15} /> : <Expand size={15} />}
                    {props.expanded ? "Collapse panel" : "Expand panel"}
                  </button>
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-sm text-stone-200 transition-colors hover:bg-stone-900 disabled:cursor-not-allowed disabled:text-stone-600"
                    onClick={() => {
                      setShowMenu(false);
                      props.onDuplicate();
                    }}
                    disabled={!props.canDuplicate}
                  >
                    <Copy size={15} />
                    Duplicate panel
                  </button>
                  <Show when={props.canRemove}>
                    <button
                      type="button"
                      class="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-sm text-red-300 transition-colors hover:bg-red-950/40"
                      onClick={() => {
                        setShowMenu(false);
                        props.onRemove();
                      }}
                    >
                      <Trash2 size={15} />
                      Remove panel
                    </button>
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </div>

      <Show when={showControls()}>
        <div class="border-b border-stone-700/80 bg-stone-950/78 px-4 py-3">
          <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label class="space-y-1 xl:col-span-2">
              <span class="block text-xs text-stone-500">Panel title</span>
              <input
                type="text"
                class={field}
                value={titleDraft()}
                maxLength={MAX_PANEL_TITLE_LENGTH}
                placeholder="NQ 15m"
                onInput={(event) => setTitleDraft(event.currentTarget.value)}
                onBlur={commitTitle}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    commitTitle();
                    event.currentTarget.blur();
                  }

                  if (event.key === "Escape") {
                    setTitleDraft(props.panel.title);
                    event.currentTarget.blur();
                  }
                }}
              />
            </label>

            <Show
              when={query().mode === "live"}
              fallback={
                <>
                  <label class="space-y-1">
                    <span class="block text-xs text-stone-500">Symbol</span>
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
                    <span class="block text-xs text-stone-500">Interval</span>
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
                    <span class="block text-xs text-stone-500">Start Date</span>
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
                    <span class="block text-xs text-stone-500">End Date</span>
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
                </>
              }
            >
              <>
                <label class="space-y-1">
                  <span class="block text-xs text-stone-500">Symbol</span>
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
                  <span class="block text-xs text-stone-500">Interval</span>
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
                  <span class="block text-xs text-stone-500">Lookback</span>
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
              </>
            </Show>
          </div>

          <div class="mt-3 border-t border-stone-800 pt-3">
            <ChartIndicatorToggleBar
              settings={indicatorSettings()}
              onToggle={toggleIndicator}
              compact
            />
          </div>
        </div>
      </Show>

      <Show
        when={candles.error}
        fallback={
          <Show when={!candles.loading} fallback={<div class="app-skeleton min-h-0 flex-1 rounded-none" />}>
            <div class="min-h-0 flex-1">
              <PriceChart
                candles={candles() ?? []}
                indicators={indicatorSettings()}
                indicatorLegend="compact"
                class="h-full"
              />
            </div>
          </Show>
        }
      >
        {(error) => (
          <div class="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
            <div class="space-y-2">
              <p class="text-sm font-semibold text-red-300">Chart request failed</p>
              <p class="text-sm text-red-400">{error().message}</p>
            </div>
          </div>
        )}
      </Show>

      <Show when={!candles.loading && (candles()?.length ?? 0) === 0 && !candles.error}>
        <div class="min-h-0 flex-1 px-4 py-5">
          <p class="text-sm font-semibold text-stone-100">No candles for this range</p>
          <p class="mt-1 text-sm text-stone-400">
            There's no stored market data for this symbol and window. Switch the panel to Live, widen
            the date range, or pick another interval.
          </p>
        </div>
      </Show>
    </section>
  );
}
