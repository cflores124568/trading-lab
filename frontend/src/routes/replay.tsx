import { A } from "@solidjs/router";
import {
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { CircleCheck, CircleX, TriangleAlert } from "lucide-solid";
import AppShell from "../components/AppShell";
import EquityCurve from "../components/EquityCurve";
import PriceChart, { type PriceChartMarker } from "../components/PriceChart";
import ReplayControls from "../components/ReplayControls";
import {
  BACKTEST_INTERVALS,
  DATABENTO_SYMBOLS,
  getBackendInterval,
  type Interval,
} from "../constants";
import {
  fetchCandles,
  fetchPropPresets,
  fetchSymbols,
  type Candle,
  type PropFirmEvaluation,
  type PropFirmPreset,
  type SymbolInfo,
  type Trade,
} from "../services/api";
import {
  clampReplayIndex,
  findJumpTarget,
  getReplayIndexFromProgress,
  getReplayProgress,
  simulateReplaySession,
  type ReplayAction,
} from "../services/replaySimulator";

const field =
  "w-full rounded px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 " +
  "text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-500 disabled:opacity-40";
const label = "block mb-1 text-xs text-zinc-400";
const section = "app-panel app-panel-section space-y-4";
const SESSION_LIMIT = 10_000;

const tickValueBySymbol = Object.fromEntries(
  DATABENTO_SYMBOLS.map((symbol) => [symbol.key, symbol.tickValue]),
) as Record<string, number>;

type ReplayLaunchConfig = {
  symbol: SymbolInfo;
  interval: Interval;
  preset: PropFirmPreset;
  startDate?: string;
  endDate?: string;
  commission: number;
  tickValue: number;
};

function formatCurrency(value: number): string {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
}

function markerTimeFromIso(value: string): number {
  return Math.floor(new Date(value).getTime() / 1000);
}

function createReplayAction(type: ReplayAction["type"], barIndex: number): ReplayAction {
  return {
    id: `${type}_${barIndex}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    barIndex,
    createdAt: Date.now(),
  };
}

function propEvalTone(passed: boolean): string {
  return passed ? "border-green-700 bg-green-950" : "border-red-700 bg-red-950";
}

function groupPresets(presets: PropFirmPreset[]): Record<string, PropFirmPreset[]> {
  return presets.reduce<Record<string, PropFirmPreset[]>>((acc, preset) => {
    let firm = preset.name.split(/\s+\d/)[0].trim();
    firm = firm
      .replace(/^My Funded Futures (Rapid|Flex)?/i, "My Funded Futures")
      .replace(/^Lucid Trading /i, "Lucid Trading")
      .trim();
    (acc[firm] ??= []).push(preset);
    return acc;
  }, {});
}

function PropEvalPanel(props: {
  title: string;
  evaluation: PropFirmEvaluation;
}) {
  return (
    <div class={`rounded-lg border p-4 ${propEvalTone(props.evaluation.passed)}`}>
      <div class="mb-2 flex items-center gap-2">
        {props.evaluation.passed ? (
          <CircleCheck class="text-green-400" />
        ) : (
          <CircleX size={18} class="text-red-400" />
        )}
        <p class="font-semibold">
          {props.title}: {props.evaluation.passed ? "Passed" : "Failed"}
        </p>
      </div>

      <Show when={!props.evaluation.passed}>
        <ul class="mt-2 space-y-1 text-sm text-red-300">
          <Show when={props.evaluation.daily_loss_breached}>
            <li class="flex items-center gap-1.5">
              <TriangleAlert size={13} /> Daily loss limit breached
            </li>
          </Show>
          <Show when={props.evaluation.drawdown_breached}>
            <li class="flex items-center gap-1.5">
              <TriangleAlert size={13} /> Max drawdown breached
            </li>
          </Show>
          <Show when={!props.evaluation.consistency_passed}>
            <li class="flex items-center gap-1.5">
              <TriangleAlert size={13} /> Consistency rule failed
            </li>
          </Show>
          <Show when={!props.evaluation.profit_target_hit}>
            <li class="flex items-center gap-1.5">
              <TriangleAlert size={13} /> Profit target not reached
            </li>
          </Show>
        </ul>
      </Show>
    </div>
  );
}

export default function ReplayLabPage() {
  const [symbols] = createResource(fetchSymbols);
  const [presets] = createResource(fetchPropPresets);

  const defaultInterval = BACKTEST_INTERVALS.find((interval) => interval.value === "15m")!;
  const [symbol, setSymbol] = createSignal<SymbolInfo | null>(null);
  const [interval, setInterval] = createSignal(defaultInterval);
  const [preset, setPreset] = createSignal<PropFirmPreset | null>(null);
  const [startDate, setStartDate] = createSignal("");
  const [endDate, setEndDate] = createSignal("");
  const [formError, setFormError] = createSignal<string | null>(null);
  const [launchConfig, setLaunchConfig] = createSignal<ReplayLaunchConfig | null>(null);

  const [isReplayActive, setIsReplayActive] = createSignal(false);
  const [speed, setSpeed] = createSignal(8);
  const [currentIndex, setCurrentIndex] = createSignal(0);
  const [replayActions, setReplayActions] = createSignal<ReplayAction[]>([]);

  const [candles] = createResource(launchConfig, async (config) =>
    fetchCandles({
      symbol: config.symbol.symbol,
      interval: getBackendInterval(config.interval),
      startDate: config.startDate,
      endDate: config.endDate,
      limit: SESSION_LIMIT,
    }),
  );

  createEffect(() => {
    const loadedSymbols = symbols();
    if (!symbol() && loadedSymbols && loadedSymbols.length > 0) {
      setSymbol(loadedSymbols[0]);
    }
  });

  createEffect(() => {
    const loadedPresets = presets();
    if (!preset() && loadedPresets && loadedPresets.length > 0) {
      setPreset(loadedPresets[0]);
    }
  });

  createEffect(() => {
    const candleList = candles();
    if (!isReplayActive() || !candleList || candleList.length === 0) {
      return;
    }

    const intervalMs = Math.max(50, Math.round(1000 / speed()));
    const timer = window.setInterval(() => {
      setCurrentIndex((previous) => {
        const capped = clampReplayIndex(previous, candleList.length);
        if (capped >= candleList.length - 1) {
          setIsReplayActive(false);
          return candleList.length - 1;
        }
        return capped + 1;
      });
    }, intervalMs);

    onCleanup(() => window.clearInterval(timer));
  });

  const totalBars = createMemo(() => candles()?.length ?? 0);
  const replayIndex = createMemo(() => clampReplayIndex(currentIndex(), totalBars()));
  const replayProgress = createMemo(() => getReplayProgress(replayIndex(), totalBars()));
  const currentCandle = createMemo<Candle | undefined>(() => candles()?.[replayIndex()]);

  const replayTradeEntryIndices = createMemo(() =>
    Array.from(
      new Set(
        replayActions()
          .filter((action) => action.type === "buy" || action.type === "sell")
          .map((action) => action.barIndex)
          .sort((a, b) => a - b),
      ),
    ),
  );

  const replaySession = createMemo(() => {
    const config = launchConfig();
    const candleList = candles();
    if (!config || !candleList || candleList.length === 0) {
      return null;
    }

    return simulateReplaySession({
      candles: candleList,
      currentIndex: replayIndex(),
      actions: replayActions(),
      initialBalance: config.preset.account_size,
      commission: config.commission,
      tickValue: config.tickValue,
      propFirmRules: config.preset,
    });
  });

  const sessionSummary = createMemo(() => {
    const config = launchConfig();
    if (!config) {
      return [];
    }

    return [
      ["Symbol", config.symbol.symbol],
      ["Interval", config.interval.label],
      [
        "Range",
        config.startDate || config.endDate
          ? `${config.startDate || "Earliest"} to ${config.endDate || "Latest"}`
          : "Full available range",
      ],
      ["Rules", config.preset.name],
    ] as [string, string][];
  });

  const replayMetrics = createMemo(() => {
    const session = replaySession();
    if (!session) {
      return [];
    }

    return [
      ["Realized PnL", formatCurrency(session.realizedPnl)],
      ["Total PnL", formatCurrency(session.totalPnl)],
      ["Win Rate", `${(session.metrics.win_rate * 100).toFixed(1)}%`],
      ["Trades", String(session.metrics.total_trades)],
      ["Balance", `$${session.balance.toFixed(2)}`],
      ["Position", session.position ? session.position.side.toUpperCase() : "FLAT"],
    ] as [string, string][];
  });

  const currentTimeLabel = createMemo(() => {
    const candle = currentCandle();
    return candle ? new Date(Number(candle.time) * 1000).toLocaleString() : "No candle";
  });

  const currentPriceLabel = createMemo(() => {
    const candle = currentCandle();
    return candle ? `$${candle.close.toFixed(2)}` : "No price";
  });

  const positionLabel = createMemo(() => {
    const session = replaySession();
    if (!session?.position) {
      return "Flat";
    }

    return `${session.position.side.toUpperCase()} from $${session.position.entry_price.toFixed(2)} (${formatCurrency(session.position.unrealized_pnl)})`;
  });

  const chartMarkers = createMemo<PriceChartMarker[]>(() => {
    const session = replaySession();
    if (!session) {
      return [];
    }

    const markers: PriceChartMarker[] = [];

    for (const trade of session.trades) {
      markers.push({
        time: markerTimeFromIso(trade.entry_time),
        position: trade.side === "buy" ? "belowBar" : "aboveBar",
        color: trade.side === "buy" ? "#22c55e" : "#fb7185",
        shape: trade.side === "buy" ? "arrowUp" : "arrowDown",
        text: `YOU ${trade.side.toUpperCase()} @ ${trade.entry_price.toFixed(2)}`,
      });

      if (trade.exit_time) {
        markers.push({
          time: markerTimeFromIso(trade.exit_time),
          position: trade.side === "buy" ? "aboveBar" : "belowBar",
          color: "#f8fafc",
          shape: "square",
          text: `EXIT ${trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}`,
        });
      }
    }

    if (session.position && currentCandle()) {
      markers.push({
        time: Number(currentCandle()!.time),
        position: session.position.side === "buy" ? "belowBar" : "aboveBar",
        color: session.position.side === "buy" ? "#34d399" : "#f43f5e",
        shape: "circle",
        text: `OPEN ${session.position.side.toUpperCase()} ${formatCurrency(session.position.unrealized_pnl)}`,
      });
    }

    return markers;
  });

  const canLaunch = createMemo(
    () => !!symbol() && !!preset() && !symbols.loading && !presets.loading,
  );

  const seekToIndex = (nextIndex: number) => {
    batch(() => {
      setIsReplayActive(false);
      setCurrentIndex(clampReplayIndex(nextIndex, totalBars()));
    });
  };

  const recordReplayAction = (type: ReplayAction["type"]) => {
    if (!candles() || totalBars() === 0) {
      return;
    }

    setIsReplayActive(false);
    setReplayActions((previous) => [...previous, createReplayAction(type, replayIndex())]);
  };

  const jumpToTrade = (direction: "next" | "prev") => {
    const target = findJumpTarget(replayIndex(), replayTradeEntryIndices(), direction);
    if (target !== null) {
      seekToIndex(target);
    }
  };

  const launchReplay = () => {
    const selectedSymbol = symbol();
    const selectedPreset = preset();
    if (!selectedSymbol) {
      setFormError("Select a symbol to launch a standalone replay session.");
      return;
    }
    if (!selectedPreset) {
      setFormError("Select a prop-firm ruleset to evaluate the replay against.");
      return;
    }
    if (startDate() && endDate() && startDate() > endDate()) {
      setFormError("Start date must be before end date.");
      return;
    }

    setFormError(null);
    batch(() => {
      setIsReplayActive(false);
      setSpeed(8);
      setCurrentIndex(0);
      setReplayActions([]);
      setLaunchConfig({
        symbol: selectedSymbol,
        interval: interval(),
        preset: selectedPreset,
        startDate: startDate() || undefined,
        endDate: endDate() || undefined,
        commission: 5,
        tickValue: tickValueBySymbol[selectedSymbol.symbol] ?? 1,
      });
    });
  };

  return (
    <AppShell
      title="Replay Lab"
      subtitle="Launch a standalone historical replay session on any supported symbol and date range, then trade it manually against prop-firm rules."
      actions={
        <>
          <A
            href="/backtests/new"
            class="rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
          >
            New Backtest
          </A>
          <A
            href="/backtests"
            class="rounded-xl bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-white"
          >
            Saved Backtests
          </A>
        </>
      }
    >
      <div class="space-y-6">
        <Show when={formError()}>
          <div class="rounded-lg border border-red-700 bg-red-950 px-4 py-3 text-sm text-red-300">
            {formError()}
          </div>
        </Show>

        <section class={section}>
          <div class="space-y-2">
            <p class="app-kicker">Standalone Session</p>
            <h2 class="text-lg font-semibold text-zinc-100">Build a replay without a saved backtest</h2>
            <p class="max-w-3xl text-sm text-zinc-400">
              Pick a warehouse-backed symbol, choose the candle interval, and load a historical
              window straight into the manual replay simulator.
            </p>
          </div>

          <div class="grid gap-3 md:grid-cols-4">
            <For each={sessionSummary()}>
              {([key, value]) => (
                <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                  <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">{key}</p>
                  <p class="mt-2 text-sm font-medium text-zinc-100">{value}</p>
                </div>
              )}
            </For>
            <Show when={!launchConfig()}>
              <div class="rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-3 md:col-span-4">
                <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Next Move</p>
                <p class="mt-2 text-sm text-zinc-300">
                  Launch a standalone replay to load up to {SESSION_LIMIT.toLocaleString()} bars
                  from the selected historical window.
                </p>
              </div>
            </Show>
          </div>
        </section>

        <section class={section}>
          <div class="space-y-1">
            <p class="text-sm font-semibold text-zinc-100">1. Market Window</p>
            <p class="text-xs text-zinc-400">
              Choose the symbol, interval, and date range to replay from the historical warehouse.
            </p>
          </div>

          <Show
            when={!symbols.loading && symbols() && symbols()!.length > 0}
            fallback={
              <Show
                when={!symbols.loading}
                fallback={<div class="h-9 animate-pulse rounded bg-zinc-800" />}
              >
                <div class="rounded-lg border border-yellow-700 bg-yellow-950 px-4 py-3 text-sm text-yellow-300">
                  No DB-backed symbols found. Import market data first to launch a replay session.
                </div>
              </Show>
            }
          >
            <div>
              <label class={label}>Symbol</label>
              <select
                class={field}
                value={symbol()?.symbol ?? ""}
                onChange={(event) => {
                  const selected = symbols()?.find(
                    (item) => item.symbol === event.currentTarget.value,
                  );
                  setSymbol(selected ?? null);
                }}
              >
                <option value="" disabled>
                  Select a symbol…
                </option>
                <For each={symbols()}>
                  {(item) => (
                    <option value={item.symbol}>
                      {item.symbol} - {item.full_name} ({item.rows.toLocaleString()} bars)
                    </option>
                  )}
                </For>
              </select>
            </div>
          </Show>

          <div class="grid gap-3 md:grid-cols-3">
            <div>
              <label class={label}>Interval</label>
              <select
                class={field}
                value={interval().value}
                onChange={(event) => {
                  const selected = BACKTEST_INTERVALS.find(
                    (item) => item.value === event.currentTarget.value,
                  );
                  if (selected) {
                    setInterval(selected);
                  }
                }}
              >
                <For each={BACKTEST_INTERVALS}>
                  {(item) => <option value={item.value}>{item.label}</option>}
                </For>
              </select>
            </div>

            <div>
              <label class={label}>Start date (optional)</label>
              <input
                type="date"
                class={field}
                value={startDate()}
                onInput={(event) => setStartDate(event.currentTarget.value)}
              />
            </div>

            <div>
              <label class={label}>End date (optional)</label>
              <input
                type="date"
                class={field}
                value={endDate()}
                onInput={(event) => setEndDate(event.currentTarget.value)}
              />
            </div>
          </div>
        </section>

        <section class={section}>
          <div class="space-y-1">
            <p class="text-sm font-semibold text-zinc-100">2. Ruleset</p>
            <p class="text-xs text-zinc-400">
              Evaluate your manual session against the same prop-firm guardrails used in backtests.
            </p>
          </div>

          <Show
            when={presets() && presets()!.length > 0}
            fallback={<div class="h-9 animate-pulse rounded bg-zinc-800" />}
          >
            <div>
              <label class={label}>Preset</label>
              <select
                class={field}
                value={preset()?.name ?? ""}
                onChange={(event) => {
                  const selected = presets()?.find(
                    (item) => item.name === event.currentTarget.value,
                  );
                  setPreset(selected ?? null);
                }}
              >
                <option value="" disabled>
                  Select a preset…
                </option>
                <For each={Object.entries(groupPresets(presets() ?? []))}>
                  {([firm, firmPresets]) => (
                    <optgroup label={firm}>
                      <For each={firmPresets}>
                        {(item) => <option value={item.name}>{item.name}</option>}
                      </For>
                    </optgroup>
                  )}
                </For>
              </select>
            </div>

            <Show when={preset()}>
              {(selectedPreset) => (
                <div class="space-y-3">
                  <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                    <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Selected Challenge</p>
                    <p class="mt-2 text-sm font-semibold text-zinc-100">{selectedPreset().name}</p>
                    <p class="mt-1 text-sm text-zinc-400">
                      The replay session will score your manual trades against these rules as you
                      step through the chart.
                    </p>
                  </div>

                  <div class="grid grid-cols-2 gap-2 md:grid-cols-3">
                    {([
                      ["Account", `$${selectedPreset().account_size.toLocaleString()}`],
                      ["Daily loss", `${(selectedPreset().daily_loss_limit * 100).toFixed(0)}%`],
                      ["Max DD", `${(selectedPreset().max_drawdown * 100).toFixed(0)}%`],
                      ["Target", `${(selectedPreset().profit_target * 100).toFixed(0)}%`],
                      ["Min days", selectedPreset().min_trading_days ?? "—"],
                      ["Drawdown type", selectedPreset().drawdown_type ?? "eod"],
                    ] as [string, string | number][]).map(([key, value]) => (
                      <div class="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                        <p class="text-xs text-zinc-400">{key}</p>
                        <p class="text-sm font-mono text-zinc-100">{value}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Show>
          </Show>
        </section>

        <section class={section}>
          <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div class="space-y-1">
              <p class="text-sm font-semibold text-zinc-100">3. Launch Replay</p>
              <p class="text-xs text-zinc-400">
                Load the historical window and start trading it manually bar by bar.
              </p>
            </div>

            <button
              class={
                "w-full rounded-xl px-5 py-3 text-sm font-semibold transition-colors md:w-auto " +
                (canLaunch()
                  ? "bg-zinc-100 text-zinc-900 hover:bg-white"
                  : "cursor-not-allowed bg-zinc-700 text-zinc-400")
              }
              disabled={!canLaunch()}
              onClick={launchReplay}
            >
              {candles.loading ? "Loading Replay…" : "Launch Replay"}
            </button>
          </div>
        </section>

        <Show when={launchConfig()}>
          {(config) => (
            <>
              <section id="replay" class="app-panel space-y-4 p-4 scroll-mt-24">
                <div class="flex items-center justify-between gap-4">
                  <div>
                    <p class="text-sm text-zinc-400">Standalone Historical Replay</p>
                    <p class="mt-1 text-xs text-zinc-500">
                      Step, scrub, and trade the selected market window without tying it to a saved
                      strategy run.
                    </p>
                  </div>
                  <div class="text-right text-xs text-zinc-500">
                    <p>Commission: ${config().commission.toFixed(2)}</p>
                    <p>Tick value: ${config().tickValue.toFixed(2)}</p>
                  </div>
                </div>

                <Show
                  when={candles.error}
                  fallback={
                    <Show
                      when={!candles.loading && candles() && candles()!.length > 0}
                      fallback={
                        <div class="flex h-[450px] items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 px-6 text-center">
                          <p class="text-sm text-zinc-500">
                            {candles.loading
                              ? "Loading replay candles…"
                              : "No candles were returned for that historical request."}
                          </p>
                        </div>
                      }
                    >
                      <PriceChart
                        candles={candles() as Candle[]}
                        markers={chartMarkers()}
                        visibleIndex={replayIndex()}
                        height={450}
                      />
                    </Show>
                  }
                >
                  {(error) => (
                    <div class="flex h-[450px] items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 px-6 text-center">
                      <p class="text-sm text-red-400">Replay data failed to load: {error().message}</p>
                    </div>
                  )}
                </Show>

                <Show when={candles() && candles()!.length > 0}>
                  <ReplayControls
                    isPlaying={isReplayActive()}
                    speed={speed()}
                    progress={replayProgress()}
                    currentBar={totalBars() === 0 ? 0 : replayIndex() + 1}
                    totalBars={totalBars()}
                    currentTimeLabel={currentTimeLabel()}
                    currentPriceLabel={currentPriceLabel()}
                    positionLabel={positionLabel()}
                    canStepBack={replayIndex() > 0}
                    canStepForward={replayIndex() < totalBars() - 1}
                    canJumpPrevTrade={
                      findJumpTarget(replayIndex(), replayTradeEntryIndices(), "prev") !== null
                    }
                    canJumpNextTrade={
                      findJumpTarget(replayIndex(), replayTradeEntryIndices(), "next") !== null
                    }
                    canExitPosition={!!replaySession()?.position}
                    onPlayPause={() => {
                      if (isReplayActive()) {
                        setIsReplayActive(false);
                        return;
                      }

                      if (replayIndex() >= totalBars() - 1) {
                        setCurrentIndex(0);
                      }
                      setIsReplayActive(true);
                    }}
                    onSpeedChange={setSpeed}
                    onSeek={(progress) =>
                      seekToIndex(getReplayIndexFromProgress(progress, totalBars()))
                    }
                    onRestart={() => {
                      batch(() => {
                        setIsReplayActive(false);
                        setCurrentIndex(0);
                        setReplayActions([]);
                      });
                    }}
                    onStepBack={() => seekToIndex(replayIndex() - 1)}
                    onStepForward={() => seekToIndex(replayIndex() + 1)}
                    onJumpPrevTrade={() => jumpToTrade("prev")}
                    onJumpNextTrade={() => jumpToTrade("next")}
                    onLong={() => recordReplayAction("buy")}
                    onShort={() => recordReplayAction("sell")}
                    onExit={() => recordReplayAction("exit")}
                  />
                </Show>
              </section>

              <Show when={replaySession()}>
                {(session) => (
                  <>
                    <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                      <For each={replayMetrics()}>
                        {([key, value]) => (
                          <div class="app-panel p-4">
                            <p class="mb-1 text-xs text-zinc-400">{key}</p>
                            <p class="font-mono text-xl font-semibold">{value}</p>
                          </div>
                        )}
                      </For>
                    </div>

                    <div class="app-panel p-4">
                      <p class="mb-3 text-sm text-zinc-400">Replay Equity Curve</p>
                      <EquityCurve data={session().equityCurve} />
                    </div>

                    <div class="grid gap-4 lg:grid-cols-2">
                      <PropEvalPanel title="Replay Prop Eval" evaluation={session().propEvaluation} />
                      <div class="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
                        <p class="text-sm font-semibold text-zinc-100">Session Notes</p>
                        <p class="mt-2 text-sm text-zinc-400">
                          This first standalone flow keeps session state in the browser for now.
                          You can relaunch the same window anytime, but it is not persisted yet.
                        </p>
                      </div>
                    </div>

                    <div class="app-panel overflow-hidden">
                      <p class="border-b border-zinc-800 p-4 text-sm text-zinc-400">
                        Replay Trades ({session().trades.length})
                      </p>
                      <table class="w-full text-sm">
                        <thead class="text-xs text-zinc-400">
                          <tr>
                            <th class="p-3 text-left">#</th>
                            <th class="p-3 text-left">Side</th>
                            <th class="p-3 text-left">Entry Time</th>
                            <th class="p-3 text-left">Exit Time</th>
                            <th class="p-3 text-right">Entry $</th>
                            <th class="p-3 text-right">Exit $</th>
                            <th class="p-3 text-right">PnL</th>
                          </tr>
                        </thead>
                        <tbody>
                          <Show
                            when={session().trades.length > 0}
                            fallback={
                              <tr class="border-t border-zinc-800">
                                <td class="p-4 text-zinc-500" colSpan={7}>
                                  No replay trades yet. Use the controls above to place manual
                                  decisions.
                                </td>
                              </tr>
                            }
                          >
                            <For each={session().trades}>
                              {(trade: Trade) => (
                                <tr class="border-t border-zinc-800 transition-colors hover:bg-zinc-800">
                                  <td class="p-3 text-zinc-400">{trade.trade_id}</td>
                                  <td
                                    class={`p-3 font-medium ${
                                      trade.side === "buy" ? "text-green-400" : "text-red-400"
                                    }`}
                                  >
                                    {trade.side}
                                  </td>
                                  <td class="p-3 font-mono text-xs text-zinc-400">
                                    {trade.entry_time}
                                  </td>
                                  <td class="p-3 font-mono text-xs text-zinc-400">
                                    {trade.exit_time}
                                  </td>
                                  <td class="p-3 text-right font-mono">
                                    {trade.entry_price.toFixed(2)}
                                  </td>
                                  <td class="p-3 text-right font-mono">
                                    {(trade.exit_price ?? 0).toFixed(2)}
                                  </td>
                                  <td
                                    class={`p-3 text-right font-mono font-semibold ${
                                      trade.pnl >= 0 ? "text-green-400" : "text-red-400"
                                    }`}
                                  >
                                    {trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}
                                  </td>
                                </tr>
                              )}
                            </For>
                          </Show>
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </Show>
            </>
          )}
        </Show>
      </div>
    </AppShell>
  );
}
