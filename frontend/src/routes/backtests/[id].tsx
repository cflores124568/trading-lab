import { A, useParams } from "@solidjs/router";
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
import {
  fetchBacktest,
  fetchBacktestCandles,
  type Candle,
  type PropFirmEvaluation,
  type Trade,
} from "../../services/api";
import { DATABENTO_SYMBOLS } from "../../constants";
import EquityCurve from "../../components/EquityCurve";
import PriceChart, { type PriceChartMarker } from "../../components/PriceChart";
import ReplayControls from "../../components/ReplayControls";
import {
  clampReplayIndex,
  findJumpTarget,
  getReplayIndexFromProgress,
  getReplayProgress,
  getTradeEntryIndices,
  simulateReplaySession,
  type ReplayAction,
} from "../../services/replaySimulator";
import { CircleCheck, CircleX, TriangleAlert } from "lucide-solid";
import AppShell from "../../components/AppShell";

const tickValueBySymbol = Object.fromEntries(
  DATABENTO_SYMBOLS.map((symbol) => [symbol.key, symbol.tickValue]),
) as Record<string, number>;

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
  return passed ? "bg-green-950 border-green-700" : "bg-red-950 border-red-700";
}

function PropEvalPanel(props: {
  title: string;
  evaluation: PropFirmEvaluation;
}) {
  const minTradingDaysPassed = () => props.evaluation.min_trading_days_passed ?? true;

  return (
    <div class={`rounded-lg p-4 border ${propEvalTone(props.evaluation.passed)}`}>
      <div class="flex items-center gap-2 mb-2">
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
        <ul class="mt-2 text-sm text-red-300 space-y-1">
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
          <Show when={!minTradingDaysPassed()}>
            <li class="flex items-center gap-1.5">
              <TriangleAlert size={13} /> Minimum trading days not reached
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

export default function BacktestDetail() {
  const params = useParams<{ id: string }>();
  const [result] = createResource(() => params.id, fetchBacktest);
  const [candles] = createResource(
    () => result()?.backtest_id,
    (backtestId) => fetchBacktestCandles(backtestId),
  );

  const [isReplayActive, setIsReplayActive] = createSignal(false);
  const [speed, setSpeed] = createSignal(8);
  const [currentIndex, setCurrentIndex] = createSignal(0);
  const [replayActions, setReplayActions] = createSignal<ReplayAction[]>([]);

  let lastResetKey: string | null = null;

  createEffect(() => {
    const backtestId = result()?.backtest_id;
    const totalBars = candles()?.length ?? 0;
    const resetKey = backtestId ? `${backtestId}:${totalBars}` : null;

    if (!resetKey || resetKey === lastResetKey || totalBars === 0) {
      return;
    }

    lastResetKey = resetKey;
    batch(() => {
      setIsReplayActive(false);
      setSpeed(8);
      setCurrentIndex(0);
      setReplayActions([]);
    });
  });

  createEffect(() => {
    const candleList = candles();
    if (!isReplayActive() || !candleList || candleList.length === 0) {
      return;
    }

    const intervalMs = Math.max(50, Math.round(1000 / speed()));
    const timer = setInterval(() => {
      setCurrentIndex((previous) => {
        const capped = clampReplayIndex(previous, candleList.length);
        if (capped >= candleList.length - 1) {
          setIsReplayActive(false);
          return candleList.length - 1;
        }
        return capped + 1;
      });
    }, intervalMs);

    onCleanup(() => clearInterval(timer));
  });

  const totalBars = createMemo(() => candles()?.length ?? 0);
  const replayIndex = createMemo(() => clampReplayIndex(currentIndex(), totalBars()));
  const replayProgress = createMemo(() => getReplayProgress(replayIndex(), totalBars()));
  const currentCandle = createMemo<Candle | undefined>(() => candles()?.[replayIndex()]);
  const commission = createMemo(() => result()?.trades[0]?.commission ?? 5);
  const tickValue = createMemo(() => tickValueBySymbol[result()?.symbol ?? ""] ?? 1);
  const tradeEntryIndices = createMemo(() =>
    candles() && result() ? getTradeEntryIndices(candles() ?? [], result()?.trades ?? []) : [],
  );

  const replaySession = createMemo(() => {
    const backtest = result();
    const candleList = candles();
    if (!backtest || !candleList || candleList.length === 0) {
      return null;
    }

    return simulateReplaySession({
      candles: candleList,
      currentIndex: replayIndex(),
      actions: replayActions(),
      initialBalance: backtest.prop_firm_rules.account_size,
      commission: commission(),
      tickValue: tickValue(),
      propFirmRules: backtest.prop_firm_rules,
    });
  });

  const chartMarkers = createMemo<PriceChartMarker[]>(() => {
    const backtest = result();
    const session = replaySession();
    if (!backtest) {
      return [];
    }

    const baselineMarkers: PriceChartMarker[] = backtest.trades.map((trade) => ({
      time: markerTimeFromIso(trade.entry_time),
      position: trade.side === "buy" ? "belowBar" : "aboveBar",
      color: trade.side === "buy" ? "#38bdf8" : "#f59e0b",
      shape: trade.side === "buy" ? "arrowUp" : "arrowDown",
      text: `SYS ${trade.side.toUpperCase()} @ ${trade.entry_price.toFixed(2)}`,
    }));

    const replayMarkers: PriceChartMarker[] = [];
    for (const trade of session?.trades ?? []) {
      replayMarkers.push({
        time: markerTimeFromIso(trade.entry_time),
        position: trade.side === "buy" ? "belowBar" : "aboveBar",
        color: trade.side === "buy" ? "#22c55e" : "#fb7185",
        shape: trade.side === "buy" ? "arrowUp" : "arrowDown",
        text: `YOU ${trade.side.toUpperCase()} @ ${trade.entry_price.toFixed(2)}`,
      });

      if (trade.exit_time) {
        replayMarkers.push({
          time: markerTimeFromIso(trade.exit_time),
          position: trade.side === "buy" ? "aboveBar" : "belowBar",
          color: "#f8fafc",
          shape: "square",
          text: `EXIT ${trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}`,
        });
      }
    }

    if (session?.position && currentCandle()) {
      replayMarkers.push({
        time: Number(currentCandle()!.time),
        position: session.position.side === "buy" ? "belowBar" : "aboveBar",
        color: session.position.side === "buy" ? "#34d399" : "#f43f5e",
        shape: "circle",
        text: `OPEN ${session.position.side.toUpperCase()} ${formatCurrency(session.position.unrealized_pnl)}`,
      });
    }

    return [...baselineMarkers, ...replayMarkers];
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

  const replayMetrics = createMemo(() => {
    const session = replaySession();
    if (!session) {
      return null;
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
    const target = findJumpTarget(replayIndex(), tradeEntryIndices(), direction);
    if (target !== null) {
      seekToIndex(target);
    }
  };

  return (
    <AppShell
      title={result() ? `${result()!.symbol} • ${result()!.strategy.type}` : "Backtest"}
      subtitle={
        result()?.backtest_id ??
        "Review summary metrics, inspect prop firm outcomes, and replay the run candle by candle."
      }
      actions={
        <>
          <a
            href="#replay"
            class="rounded-xl bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-white"
          >
            Jump to Replay
          </a>
          <A
            href="/backtests"
            class="rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
          >
            Back to Backtests
          </A>
        </>
      }
    >
      <Show
        when={result()}
        fallback={
          <section class="app-panel app-panel-section flex min-h-60 items-center justify-center">
            <p class="text-zinc-400">Loading backtest…</p>
          </section>
        }
      >
        {(bt) => {
          const { metrics, prop_firm_eval, trades, equity_curve } = bt();

          return (
            <div class="space-y-6">
              <section class="app-panel app-panel-section">
                <div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                  <div class="space-y-2">
                    <p class="app-kicker">Replay First</p>
                    <p class="max-w-3xl text-sm text-zinc-300">
                      Step through the saved run bar by bar, compare your manual decisions against
                      the system trades, and see how the replay changes your prop evaluation.
                    </p>
                  </div>

                  <div class="flex flex-wrap items-center gap-3">
                    <a
                      href="#replay"
                      class="rounded-xl bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-white"
                    >
                      Start Replay
                    </a>
                    <A
                      href="/backtests"
                      class="rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
                    >
                      All Backtests
                    </A>
                  </div>
                </div>
              </section>

              <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {([
                  ["Total PnL", `$${metrics.total_pnl.toFixed(2)}`],
                  ["Win Rate", `${(metrics.win_rate * 100).toFixed(1)}%`],
                  ["Max Drawdown", `${(metrics.max_drawdown * 100).toFixed(1)}%`],
                  ["Sharpe", metrics.sharpe_ratio.toFixed(2)],
                  ["Profit Factor", metrics.profit_factor.toFixed(2)],
                  ["Total Trades", String(metrics.total_trades)],
                ] as [string, string][]).map(([label, value]) => (
                  <div class="app-panel p-4">
                    <p class="mb-1 text-xs text-zinc-400">{label}</p>
                    <p class="font-mono text-xl font-semibold">{value}</p>
                  </div>
                ))}
              </div>

              <section id="replay" class="app-panel p-4 space-y-4 scroll-mt-24">
                <div class="flex items-center justify-between gap-4">
                  <div>
                    <p class="text-sm text-zinc-400">Interactive Replay Simulator</p>
                    <p class="mt-1 text-xs text-zinc-500">
                      Scrub, step, jump between system trades, and place your own manual
                      long/short/exit decisions.
                    </p>
                  </div>
                  <div class="text-right text-xs text-zinc-500">
                    <p>Commission: ${commission().toFixed(2)}</p>
                    <p>Tick value: ${tickValue().toFixed(2)}</p>
                  </div>
                </div>

                <Show
                  when={candles.error}
                  fallback={
                    <Show
                      when={!candles.loading && candles() && candles()!.length > 0}
                      fallback={
                        <div class="flex h-[450px] items-center justify-center rounded-lg bg-zinc-800 animate-pulse">
                          <p class="text-sm text-zinc-500">
                            {candles.loading
                              ? "Loading chart data…"
                              : "No candles available for this backtest."}
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
                      <p class="text-sm text-red-400">
                        Replay data failed to load: {error().message}
                      </p>
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
                      findJumpTarget(replayIndex(), tradeEntryIndices(), "prev") !== null
                    }
                    canJumpNextTrade={
                      findJumpTarget(replayIndex(), tradeEntryIndices(), "next") !== null
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
                      <For each={replayMetrics() ?? []}>
                        {([label, value]) => (
                          <div class="app-panel p-4">
                            <p class="mb-1 text-xs text-zinc-400">{label}</p>
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
                      <PropEvalPanel title="System Prop Eval" evaluation={prop_firm_eval} />
                      <PropEvalPanel
                        title="Replay Prop Eval"
                        evaluation={session().propEvaluation}
                      />
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
                              {(trade) => (
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

              <div class="app-panel p-4">
                <p class="mb-3 text-sm text-zinc-400">Strategy Equity Curve</p>
                <EquityCurve data={equity_curve} />
              </div>

              <div class="app-panel overflow-hidden">
                <p class="border-b border-zinc-800 p-4 text-sm text-zinc-400">
                  System Trades ({trades.length})
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
                    <For each={trades}>
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
                          <td class="p-3 font-mono text-xs text-zinc-400">{trade.entry_time}</td>
                          <td class="p-3 font-mono text-xs text-zinc-400">{trade.exit_time}</td>
                          <td class="p-3 text-right font-mono">{trade.entry_price.toFixed(2)}</td>
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
                  </tbody>
                </table>
              </div>
            </div>
          );
        }}
      </Show>
    </AppShell>
  );
}
