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
import { fetchCandles, fetchYfinanceCandles, type Candle } from "../../services/api";
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

export default function ChartPanel(props: Props) {
  const query = createMemo(() => props.panel.query);
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

    return fetchCandles({
      symbol: nextQuery.symbol,
      interval: getBackendInterval(selectedInterval),
      startDate: nextQuery.startDate || undefined,
      endDate: nextQuery.endDate || undefined,
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

    return "border-emerald-800/70 bg-emerald-950/40 text-emerald-200";
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
    <section class="flex h-full min-h-[440px] flex-col overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/45 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <div class="border-b border-zinc-800 bg-zinc-950/90 px-3 py-2">
        <div class="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              <Show when={props.canReorder}>
                <button
                  type="button"
                  draggable
                  title="Drag to reorder panel"
                  aria-label="Drag to reorder panel"
                  class="inline-flex h-7 w-7 cursor-grab items-center justify-center rounded-sm border border-zinc-800 bg-zinc-950 text-zinc-500 transition-colors hover:border-zinc-700 hover:text-zinc-200 active:cursor-grabbing"
                  onDragStart={props.onReorderDragStart}
                  onDragEnd={props.onReorderDragEnd}
                >
                  <GripVertical size={15} />
                </button>
              </Show>
              <h3 class="truncate text-sm font-semibold text-zinc-100">{props.panel.title}</h3>
              <span class="rounded-sm border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-300">
                {query().symbol}
              </span>
              <span class="text-xs text-zinc-500">{query().interval}</span>
              <span class="rounded-sm border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] uppercase tracking-[0.16em] text-zinc-500">
                {modeLabel()}
              </span>
              <span class={`rounded-sm border px-2 py-1 text-[11px] font-medium ${panelStateTone()}`}>
                {panelStateLabel()}
              </span>
              <span class="rounded-sm border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] uppercase tracking-[0.16em] text-zinc-500">
                {enabledStudyCount()} studies
              </span>
            </div>
            <p class="mt-1 truncate text-xs text-zinc-500">{panelSummary()}</p>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              title="Switch to live mode"
              class={`inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1.5 text-xs font-medium transition-colors ${
                query().mode === "live"
                  ? "bg-zinc-100 text-zinc-950"
                  : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              }`}
              onClick={() => setMode("live")}
            >
              <Radio size={14} />
              Live
            </button>
            <button
              type="button"
              title="Switch to historical mode"
              class={`inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1.5 text-xs font-medium transition-colors ${
              query().mode === "historical"
                ? "bg-zinc-100 text-zinc-950"
                : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              }`}
              onClick={() => setMode("historical")}
            >
              <History size={14} />
              Historical
            </button>
            <button
              type="button"
              title={showControls() ? "Hide panel controls" : "Show panel controls"}
              class="inline-flex items-center gap-1.5 rounded-sm border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
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
                class="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-200"
                onClick={() => setShowMenu((current) => !current)}
              >
                <Ellipsis size={15} />
              </button>

              <Show when={showMenu()}>
                <div class="absolute right-0 top-[calc(100%+0.5rem)] z-30 w-48 rounded-sm border border-zinc-800 bg-zinc-950/98 p-2 shadow-2xl shadow-black/40">
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-900"
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
                    class="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-900 disabled:cursor-not-allowed disabled:text-zinc-600"
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
        <div class="border-b border-zinc-800 bg-zinc-950/75 px-3 py-3">
          <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label class="space-y-1 xl:col-span-2">
              <span class="block text-xs text-zinc-500">Panel title</span>
              <input
                type="text"
                class={field}
                value={titleDraft()}
                maxLength={MAX_PANEL_TITLE_LENGTH}
                placeholder="Higher Timeframe Bias"
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
                    <span class="block text-xs text-zinc-500">Symbol</span>
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
                    <span class="block text-xs text-zinc-500">Interval</span>
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
                    <span class="block text-xs text-zinc-500">Start Date</span>
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
                    <span class="block text-xs text-zinc-500">End Date</span>
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
                  <span class="block text-xs text-zinc-500">Symbol</span>
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
                  <span class="block text-xs text-zinc-500">Interval</span>
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
                  <span class="block text-xs text-zinc-500">Lookback</span>
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

          <div class="mt-3 border-t border-zinc-800 pt-3">
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
