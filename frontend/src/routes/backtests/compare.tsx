// frontend/src/routes/backtests/compare.tsx
import { A, useSearchParams } from "@solidjs/router";
import { createResource, Show, For } from "solid-js";
import AppShell from "../../components/AppShell";
import WorkspaceLaunchControl from "../../components/workspace/WorkspaceLaunchControl";
import { compareBacktests, type BacktestCompare } from "../../services/api";

function formatMoney(value: number | undefined): string {
  if (typeof value !== "number") {
    return "—";
  }

  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
}

function formatPercent(value: number | undefined): string {
  if (typeof value !== "number") {
    return "—";
  }

  return `${(value * 100).toFixed(1)}%`;
}

function winnerTone(isWinner: boolean): string {
  return isWinner ? "app-panel-selected border-sky-400/85" : "border-zinc-700/80 bg-zinc-950/70";
}

function formatExecutionMode(value: "bar" | "synthetic_quotes" | undefined): string {
  if (value === "synthetic_quotes") {
    return "Synthetic Quotes";
  }
  return "Bar";
}

function formatMaybeTicks(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "off";
  }
  return `${value}t`;
}

type CompareBacktest = BacktestCompare["backtest_a"];

export default function BacktestComparePage() {
  const [params] = useSearchParams<{ a?: string; b?: string }>();

  const [comparison] = createResource(
    () => {
      const a = params.a;
      const b = params.b;
      if (!a || !b) return null;
      return { a, b };
    },
    async ({ a, b }) => compareBacktests(a, b),
  );

  const metricRows = [
    { label: "Backtest ID", getValue: (bt: CompareBacktest) => bt.backtest_id ?? "—" },
    { label: "Symbol", getValue: (bt: CompareBacktest) => bt.symbol ?? "—" },
    {
      label: "Strategy",
      getValue: (bt: CompareBacktest) => bt.strategy?.type.replace(/_/g, " ") ?? "—",
    },
    { label: "Total PnL", getValue: (bt: CompareBacktest) => `$${bt.metrics.total_pnl.toFixed(2)}` },
    {
      label: "Win Rate",
      getValue: (bt: CompareBacktest) => `${(bt.metrics.win_rate * 100).toFixed(1)}%`,
    },
    {
      label: "Max Drawdown",
      getValue: (bt: CompareBacktest) => `${(bt.metrics.max_drawdown * 100).toFixed(1)}%`,
    },
    { label: "Sharpe Ratio", getValue: (bt: CompareBacktest) => bt.metrics.sharpe_ratio.toFixed(2) },
    { label: "Profit Factor", getValue: (bt: CompareBacktest) => bt.metrics.profit_factor.toFixed(2) },
    { label: "Total Trades", getValue: (bt: CompareBacktest) => String(bt.metrics.total_trades ?? "—") },
    {
      label: "Best Trade",
      getValue: (bt: CompareBacktest) => `$${bt.metrics.best_trade?.toFixed(2) ?? "—"}`,
    },
    {
      label: "Worst Trade",
      getValue: (bt: CompareBacktest) => `$${bt.metrics.worst_trade?.toFixed(2) ?? "—"}`,
    },
    { label: "Created", getValue: (bt: CompareBacktest) => bt.created_at?.slice(0, 10) ?? "—" },
  ];

  return (
    <AppShell
      title="Compare Backtests"
      subtitle="Two saved runs, side by side."
      actions={
        <A
          href="/backtests"
          class="app-button-secondary"
        >
          Back to Backtests
        </A>
      }
    >
      <div class="mx-auto w-full max-w-6xl">
        <Show
          when={!comparison.loading}
          fallback={<div class="app-panel h-40 animate-pulse" />}
        >
          <Show
            when={comparison()}
            fallback={
              <div class="app-panel app-panel-section text-sm text-zinc-400">
                Missing compare params (a and b). Go back and select two backtests.
              </div>
            }
          >
            {(result) => {
              const data: BacktestCompare = result();
              const a = data.backtest_a;
              const b = data.backtest_b;
              const executionRows = [
                {
                  label: "Execution Mode",
                  valueA: formatExecutionMode(a.run_config.execution_mode),
                  valueB: formatExecutionMode(b.run_config.execution_mode),
                },
                {
                  label: "Spread",
                  valueA: formatMaybeTicks(a.run_config.spread_ticks),
                  valueB: formatMaybeTicks(b.run_config.spread_ticks),
                },
                {
                  label: "Volatility Trigger",
                  valueA: formatMaybeTicks(a.run_config.volatile_bar_threshold_ticks),
                  valueB: formatMaybeTicks(b.run_config.volatile_bar_threshold_ticks),
                },
                {
                  label: "Volatility Extra",
                  valueA: formatMaybeTicks(a.run_config.volatile_bar_extra_ticks),
                  valueB: formatMaybeTicks(b.run_config.volatile_bar_extra_ticks),
                },
                {
                  label: "Slippage",
                  valueA: formatMaybeTicks(a.run_config.slippage_ticks),
                  valueB: formatMaybeTicks(b.run_config.slippage_ticks),
                },
                {
                  label: "Stop Loss",
                  valueA: formatMaybeTicks(a.run_config.stop_loss_ticks),
                  valueB: formatMaybeTicks(b.run_config.stop_loss_ticks),
                },
                {
                  label: "Take Profit",
                  valueA: formatMaybeTicks(a.run_config.take_profit_ticks),
                  valueB: formatMaybeTicks(b.run_config.take_profit_ticks),
                },
              ];
              const totalPnlWinner =
                (a.metrics.total_pnl ?? Number.NEGATIVE_INFINITY) >=
                (b.metrics.total_pnl ?? Number.NEGATIVE_INFINITY)
                  ? "a"
                  : "b";
              const winRateWinner =
                (a.metrics.win_rate ?? Number.NEGATIVE_INFINITY) >=
                (b.metrics.win_rate ?? Number.NEGATIVE_INFINITY)
                  ? "a"
                  : "b";
              const drawdownWinner =
                (a.metrics.max_drawdown ?? Number.POSITIVE_INFINITY) <=
                (b.metrics.max_drawdown ?? Number.POSITIVE_INFINITY)
                  ? "a"
                  : "b";

              return (
                <div class="space-y-6">
                  <section class="grid gap-4 md:grid-cols-3">
                    <div class="app-panel rounded-md px-4 py-4">
                      <p class="app-metric-label">PnL Delta</p>
                      <p class="app-metric-value">
                        {formatMoney((a.metrics.total_pnl ?? 0) - (b.metrics.total_pnl ?? 0))}
                      </p>
                    </div>
                    <div class="app-panel rounded-md px-4 py-4">
                      <p class="app-metric-label">Win Rate Delta</p>
                      <p class="app-metric-value">
                        {formatPercent((a.metrics.win_rate ?? 0) - (b.metrics.win_rate ?? 0))}
                      </p>
                    </div>
                    <div class="app-panel rounded-md px-4 py-4">
                      <p class="app-metric-label">Drawdown Delta</p>
                      <p class="app-metric-value">
                        {formatPercent((a.metrics.max_drawdown ?? 0) - (b.metrics.max_drawdown ?? 0))}
                      </p>
                    </div>
                  </section>

                  <section class="app-panel overflow-x-auto">
                    <div class="min-w-[720px]">
                      <div class="grid grid-cols-[minmax(0,1fr)_180px_180px_120px] border-b border-zinc-700/80 bg-zinc-950/80">
                      <div class="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                        Execution Assumption
                      </div>
                      <div class="app-data border-l border-zinc-700/80 px-3 py-2.5 text-sm font-semibold text-zinc-200">
                        {a.backtest_id}
                      </div>
                      <div class="app-data border-l border-zinc-700/80 px-3 py-2.5 text-sm font-semibold text-zinc-200">
                        {b.backtest_id}
                      </div>
                      <div class="border-l border-zinc-700/80 px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                        Diff
                      </div>
                      </div>

                      <For each={executionRows}>
                        {(row) => {
                          const isSame = row.valueA === row.valueB;
                          return (
                            <div class="grid grid-cols-[minmax(0,1fr)_180px_180px_120px] border-b border-zinc-800/90 last:border-b-0 hover:bg-zinc-900/70">
                              <div class="px-3 py-2.5 text-sm text-zinc-400">{row.label}</div>
                              <div class="app-data border-l border-zinc-700/80 px-3 py-2.5 text-sm text-zinc-200">
                                {row.valueA}
                              </div>
                              <div class="app-data border-l border-zinc-700/80 px-3 py-2.5 text-sm text-zinc-200">
                                {row.valueB}
                              </div>
                              <div class="border-l border-zinc-700/80 px-3 py-2.5">
                                <span
                                  class={`rounded-full px-2 py-1 text-[11px] font-semibold uppercase tracking-wide ${
                                    isSame
                                      ? "border border-emerald-900/80 bg-emerald-950/40 text-emerald-300"
                                      : "border border-amber-900/80 bg-amber-950/40 text-amber-300"
                                  }`}
                                >
                                  {isSame ? "same" : "different"}
                                </span>
                              </div>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </section>

                  <section class="grid gap-4 lg:grid-cols-2">
                    {[
                      { title: "Run A", backtest: a, accent: "text-sky-300", key: "a" },
                      { title: "Run B", backtest: b, accent: "text-zinc-300", key: "b" },
                    ].map(({ title, backtest, accent, key }) => {
                      const workspaceIntent =
                        backtest.symbol && backtest.replay_context?.interval
                          ? {
                              source: "backtest" as const,
                              symbol: backtest.symbol,
                              interval: backtest.replay_context.interval,
                              startDate: backtest.replay_context.start_date ?? undefined,
                              endDate: backtest.replay_context.end_date ?? undefined,
                            }
                          : null;

                      return (
                        <div class={`app-panel app-panel-section space-y-4 ${winnerTone(
                          totalPnlWinner === key || winRateWinner === key || drawdownWinner === key,
                        )}`}>
                          <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                            <div class="space-y-2">
                              <p class={`text-xs uppercase tracking-[0.18em] ${accent}`}>{title}</p>
                              <h2 class="text-xl font-semibold text-zinc-100">
                                {backtest.symbol} • {backtest.strategy.type.replace(/_/g, " ")}
                              </h2>
                              <p class="app-data text-xs text-zinc-500">{backtest.backtest_id}</p>
                            </div>

                            <Show when={workspaceIntent}>
                              {(intent) => (
                                <WorkspaceLaunchControl
                                  intent={intent()}
                                  compact
                                  buttonLabel={`Open ${title} in Workspace`}
                                />
                              )}
                            </Show>
                          </div>

                          <div class="grid grid-cols-2 gap-3">
                            <div class={`rounded-md border px-4 py-3 ${winnerTone(totalPnlWinner === key)}`}>
                              <p class="app-metric-label">Total PnL</p>
                              <p class={`app-data mt-2 text-2xl font-semibold ${backtest.metrics.total_pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                                {formatMoney(backtest.metrics.total_pnl)}
                              </p>
                            </div>
                            <div class={`rounded-md border px-4 py-3 ${winnerTone(winRateWinner === key)}`}>
                              <p class="app-metric-label">Win Rate</p>
                              <p class="app-data mt-2 text-2xl font-semibold text-zinc-100">
                                {formatPercent(backtest.metrics.win_rate)}
                              </p>
                            </div>
                            <div class={`rounded-md border px-4 py-3 ${winnerTone(drawdownWinner === key)}`}>
                              <p class="app-metric-label">Max Drawdown</p>
                              <p class="app-data mt-2 text-xl font-semibold text-zinc-100">
                                {formatPercent(backtest.metrics.max_drawdown)}
                              </p>
                            </div>
                            <div class="rounded-md border border-zinc-700/80 bg-zinc-950/60 px-4 py-3">
                              <p class="app-metric-label">Created</p>
                              <p class="mt-2 text-sm font-medium text-zinc-200">
                                {backtest.created_at.slice(0, 10)}
                              </p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </section>

                  <div class="app-panel overflow-hidden">
                    <div class="grid grid-cols-3 border-b border-zinc-700/80 bg-zinc-950/80">
                      <div class="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                        Metric
                      </div>
                      <div class="app-data border-l border-zinc-700/80 px-3 py-2.5 text-sm font-semibold text-zinc-200">
                        {a.backtest_id}
                      </div>
                      <div class="app-data border-l border-zinc-700/80 px-3 py-2.5 text-sm font-semibold text-zinc-200">
                        {b.backtest_id}
                      </div>
                    </div>

                    <For each={metricRows}>
                      {(row) => (
                        <div class="grid grid-cols-3 border-b border-zinc-800/90 last:border-b-0 hover:bg-zinc-900/70">
                          <div class="px-3 py-2.5 text-sm text-zinc-400">{row.label}</div>
                          <div class="app-data border-l border-zinc-700/80 px-3 py-2.5 text-sm text-zinc-200">
                            {row.getValue(a)}
                          </div>
                          <div class="app-data border-l border-zinc-700/80 px-3 py-2.5 text-sm text-zinc-200">
                            {row.getValue(b)}
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              );
            }}
          </Show>
        </Show>
      </div>
    </AppShell>
  );
}
