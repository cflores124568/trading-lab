import { A, useParams } from "@solidjs/router";
import { createMemo, createResource, For, Show } from "solid-js";
import AppShell from "../components/AppShell";
import {
  fetchBacktest,
  fetchReplaySession,
  type Trade,
} from "../services/api";
import { compareReplayToBacktest } from "../services/replayComparison";

function formatMoney(value: number): string {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
}

function formatPercent(value: number): string {
  return `${value >= 0 ? "+" : "-"}${Math.abs(value * 100).toFixed(2)}%`;
}

function formatTradeTime(value: string | undefined): string {
  if (!value) {
    return "—";
  }

  return new Date(value).toLocaleString();
}

function tradeTone(value: number): string {
  return value >= 0 ? "text-green-400" : "text-red-400";
}

function InsightCard(props: {
  label: string;
  value: string | number;
  detail: string;
}) {
  return (
    <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
      <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">{props.label}</p>
      <p class="mt-2 font-mono text-2xl font-semibold text-zinc-100">{props.value}</p>
      <p class="mt-2 text-sm text-zinc-400">{props.detail}</p>
    </div>
  );
}

function TradeTable(props: {
  title: string;
  trades: Trade[];
  emptyLabel: string;
}) {
  return (
    <div class="app-panel overflow-hidden">
      <p class="border-b border-zinc-800 p-4 text-sm text-zinc-400">
        {props.title} ({props.trades.length})
      </p>
      <table class="w-full text-sm">
        <thead class="text-xs text-zinc-400">
          <tr>
            <th class="p-3 text-left">#</th>
            <th class="p-3 text-left">Side</th>
            <th class="p-3 text-left">Entry</th>
            <th class="p-3 text-left">Exit</th>
            <th class="p-3 text-right">PnL</th>
          </tr>
        </thead>
        <tbody>
          <Show
            when={props.trades.length > 0}
            fallback={
              <tr class="border-t border-zinc-800">
                <td class="p-4 text-zinc-500" colSpan={5}>
                  {props.emptyLabel}
                </td>
              </tr>
            }
          >
            <For each={props.trades}>
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
                  <td class="p-3 text-xs text-zinc-400">{formatTradeTime(trade.entry_time)}</td>
                  <td class="p-3 text-xs text-zinc-400">{formatTradeTime(trade.exit_time)}</td>
                  <td class={`p-3 text-right font-mono font-semibold ${tradeTone(trade.pnl)}`}>
                    {formatMoney(trade.pnl)}
                  </td>
                </tr>
              )}
            </For>
          </Show>
        </tbody>
      </table>
    </div>
  );
}

export default function ReplayComparePage() {
  const params = useParams<{ id: string }>();
  const [session] = createResource(() => params.id, fetchReplaySession);
  const sourceBacktestId = createMemo(
    () => session()?.source_backtest?.backtest_id ?? null,
  );
  const [backtest] = createResource(sourceBacktestId, fetchBacktest);

  const report = createMemo(() => {
    const replaySession = session();
    const sourceBacktest = backtest();
    if (!replaySession || !sourceBacktest) {
      return null;
    }

    return compareReplayToBacktest({
      manualTrades: replaySession.trades,
      systemTrades: sourceBacktest.trades,
      interval: replaySession.source_backtest?.interval ?? replaySession.interval,
      manualPropEvaluation: replaySession.prop_firm_eval,
      systemPropEvaluation: sourceBacktest.prop_firm_eval,
    });
  });

  return (
    <AppShell
      title="Replay Vs System"
      subtitle="See where your manual session diverged from the source backtest instead of guessing from memory."
      actions={
        <>
          <A
            href={params.id ? `/replay/${params.id}` : "/replay"}
            class="rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
          >
            Back To Replay
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
        <Show when={!session.loading} fallback={<div class="app-panel h-40 animate-pulse" />}>
          <Show
            when={session()}
            fallback={
              <div class="app-panel app-panel-section text-sm text-zinc-400">
                Replay session not found.
              </div>
            }
          >
            {(replaySession) => (
              <Show
                when={replaySession().source_backtest?.backtest_id}
                fallback={
                  <div class="app-panel app-panel-section space-y-3">
                    <p class="text-sm text-zinc-300">
                      This replay session was saved without a source backtest link, so there isn't a
                      clean manual-vs-system compare to open yet.
                    </p>
                    <p class="text-sm text-zinc-500">
                      Launch the sim from a saved backtest first, then save that replay session.
                    </p>
                  </div>
                }
              >
                <Show when={!backtest.loading} fallback={<div class="app-panel h-40 animate-pulse" />}>
                  <Show
                    when={!!backtest() && !!report()}
                    fallback={
                      <div class="app-panel app-panel-section text-sm text-zinc-400">
                        The linked backtest could not be loaded for comparison.
                      </div>
                    }
                  >
                    <div class="space-y-6">
                      {(() => {
                        const replay = replaySession();
                        const system = backtest()!;
                        const comparison = report()!;

                        return (
                          <>
                          <section class="grid gap-4 lg:grid-cols-2">
                            <div class="app-panel app-panel-section space-y-3">
                              <p class="text-xs uppercase tracking-[0.18em] text-emerald-300">
                                Manual Session
                              </p>
                              <h2 class="text-xl font-semibold text-zinc-100">{replay.name}</h2>
                              <p class="font-mono text-xs text-zinc-500">
                                {replay.replay_session_id}
                              </p>
                              <p class="text-sm text-zinc-400">
                                {replay.symbol} • {replay.interval} • {replay.trades.length} manual trades
                              </p>
                            </div>

                            <div class="app-panel app-panel-section space-y-3">
                              <p class="text-xs uppercase tracking-[0.18em] text-sky-300">
                                Source Backtest
                              </p>
                              <h2 class="text-xl font-semibold text-zinc-100">
                                {system.symbol} • {system.strategy.type.replace(/_/g, " ")}
                              </h2>
                              <p class="font-mono text-xs text-zinc-500">{system.backtest_id}</p>
                              <p class="text-sm text-zinc-400">
                                {system.trades.length} system trades in the saved run
                              </p>
                            </div>
                          </section>

                          <section class="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
                            <InsightCard
                              label="PnL Delta"
                              value={formatMoney(comparison.pnlDiff)}
                              detail="Manual realized PnL minus the system's realized PnL."
                            />
                            <InsightCard
                              label="Missed Entries"
                              value={comparison.missedEntryCount}
                              detail="System trades that never got a nearby manual entry match."
                            />
                            <InsightCard
                              label="Manual-Only"
                              value={comparison.manualOnlyCount}
                              detail="Entries you took that don't line up with the source run."
                            />
                            <InsightCard
                              label="Early Exits"
                              value={comparison.earlyExitCount}
                              detail="Matched trades where you got out before the system did."
                            />
                            <InsightCard
                              label="Better Exits"
                              value={comparison.betterExitCount}
                              detail="Matched trades where your exit beat the system on PnL."
                            />
                          </section>

                          <section class="grid gap-4 lg:grid-cols-2">
                            <div class="app-panel app-panel-section">
                              <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">
                                Prop Result
                              </p>
                              <p class="mt-2 text-lg font-semibold text-zinc-100">
                                {comparison.propComparison.passDelta === "improved"
                                  ? "Manual session improved the prop result"
                                  : comparison.propComparison.passDelta === "worse"
                                    ? "Manual session came in worse than the system"
                                    : "Manual session landed on the same prop outcome"}
                              </p>
                              <div class="mt-4 grid gap-3 md:grid-cols-2">
                                <div class="rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                                  <p class="text-xs text-zinc-500">Manual Pass</p>
                                  <p class="mt-1 text-sm font-semibold text-zinc-100">
                                    {replay.prop_firm_eval.passed ? "Passed" : "Failed"}
                                  </p>
                                </div>
                                <div class="rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                                  <p class="text-xs text-zinc-500">System Pass</p>
                                  <p class="mt-1 text-sm font-semibold text-zinc-100">
                                    {system.prop_firm_eval.passed ? "Passed" : "Failed"}
                                  </p>
                                </div>
                                <div class="rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                                  <p class="text-xs text-zinc-500">Profit % Delta</p>
                                  <p
                                    class={`mt-1 font-mono text-sm font-semibold ${tradeTone(
                                      comparison.propComparison.actualProfitPctDiff,
                                    )}`}
                                  >
                                    {formatPercent(comparison.propComparison.actualProfitPctDiff)}
                                  </p>
                                </div>
                                <div class="rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                                  <p class="text-xs text-zinc-500">Drawdown % Delta</p>
                                  <p
                                    class={`mt-1 font-mono text-sm font-semibold ${tradeTone(
                                      -comparison.propComparison.actualDrawdownPctDiff,
                                    )}`}
                                  >
                                    {formatPercent(comparison.propComparison.actualDrawdownPctDiff)}
                                  </p>
                                </div>
                              </div>
                            </div>

                            <div class="app-panel app-panel-section">
                              <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">
                                Matched Trades
                              </p>
                              <p class="mt-2 text-sm text-zinc-400">
                                These are the manual trades the matcher could line up to a system trade
                                by side and nearby entry timing.
                              </p>
                              <div class="mt-4 space-y-3">
                                <Show
                                  when={comparison.matchedTrades.length > 0}
                                  fallback={
                                    <p class="text-sm text-zinc-500">
                                      No close trade matches yet. The compare screen still tracks missed
                                      and manual-only entries.
                                    </p>
                                  }
                                >
                                  <For each={comparison.matchedTrades}>
                                    {(match) => (
                                      <div class="rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                                        <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                                          <div>
                                            <p class="text-sm font-semibold text-zinc-100">
                                              {match.systemTrade.side.toUpperCase()} system #
                                              {match.systemTrade.trade_id} vs manual #
                                              {match.manualTrade.trade_id}
                                            </p>
                                            <p class="mt-1 text-xs text-zinc-500">
                                              Entry diff {match.entryDiffMinutes} min • Exit diff{" "}
                                              {match.exitDiffMinutes} min
                                            </p>
                                          </div>
                                          <p class={`font-mono text-sm font-semibold ${tradeTone(match.pnlDiff)}`}>
                                            {formatMoney(match.pnlDiff)}
                                          </p>
                                        </div>
                                        <div class="mt-3 flex flex-wrap gap-2 text-xs">
                                          <span class="rounded-full border border-zinc-700 px-2 py-1 text-zinc-300">
                                            System {formatMoney(match.systemTrade.pnl)}
                                          </span>
                                          <span class="rounded-full border border-zinc-700 px-2 py-1 text-zinc-300">
                                            Manual {formatMoney(match.manualTrade.pnl)}
                                          </span>
                                          <Show when={match.exitedEarly}>
                                            <span class="rounded-full border border-amber-700 px-2 py-1 text-amber-300">
                                              Early exit
                                            </span>
                                          </Show>
                                          <Show when={match.betterExit}>
                                            <span class="rounded-full border border-emerald-700 px-2 py-1 text-emerald-300">
                                              Better exit
                                            </span>
                                          </Show>
                                        </div>
                                      </div>
                                    )}
                                  </For>
                                </Show>
                              </div>
                            </div>
                          </section>

                          <section class="grid gap-4 lg:grid-cols-2">
                            <TradeTable
                              title="Missed System Trades"
                              trades={comparison.missedSystemTrades}
                              emptyLabel="No missed system entries. You covered every matched setup the system took."
                            />
                            <TradeTable
                              title="Manual-Only Trades"
                              trades={comparison.extraManualTrades}
                              emptyLabel="No extra manual entries. Every manual trade found a nearby system match."
                            />
                          </section>
                          </>
                        );
                      })()}
                    </div>
                  </Show>
                </Show>
              </Show>
            )}
          </Show>
        </Show>
      </div>
    </AppShell>
  );
}
