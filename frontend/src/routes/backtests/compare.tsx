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
    { label: "Backtest ID", getValue: (bt: any) => bt.backtest_id ?? "—" },
    { label: "Symbol", getValue: (bt: any) => bt.symbol ?? "—" },
    { label: "Strategy", getValue: (bt: any) => bt.strategy?.type.replace(/_/g, " ") ?? "—" },
    { label: "Total PnL", getValue: (bt: any) => `$${bt.metrics.total_pnl.toFixed(2)}` },
    { label: "Win Rate", getValue: (bt: any) => `${(bt.metrics.win_rate * 100).toFixed(1)}%` },
    { label: "Max Drawdown", getValue: (bt: any) => `${(bt.metrics.max_drawdown * 100).toFixed(1)}%` },
    { label: "Sharpe Ratio", getValue: (bt: any) => bt.metrics.sharpe_ratio.toFixed(2) },
    { label: "Profit Factor", getValue: (bt: any) => bt.metrics.profit_factor.toFixed(2) },
    { label: "Total Trades", getValue: (bt: any) => String(bt.metrics.total_trades ?? "—") },
    { label: "Best Trade", getValue: (bt: any) => `$${bt.metrics.best_trade?.toFixed(2) ?? "—"}` },
    { label: "Worst Trade", getValue: (bt: any) => `$${bt.metrics.worst_trade?.toFixed(2) ?? "—"}` },
    { label: "Created", getValue: (bt: any) => bt.created_at?.slice(0, 10) ?? "—" },
  ];

  return (
    <AppShell
      title="Compare Backtests"
      subtitle="Evaluate two saved runs side by side across returns, drawdown, and trade quality."
      actions={
        <A
          href="/backtests"
          class="rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
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

              return (
                <div class="space-y-6">
                  <section class="grid gap-4 lg:grid-cols-2">
                    {[
                      { title: "Run A", backtest: a, accent: "text-sky-300" },
                      { title: "Run B", backtest: b, accent: "text-emerald-300" },
                    ].map(({ title, backtest, accent }) => {
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
                        <div class="app-panel app-panel-section space-y-4">
                          <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                            <div class="space-y-2">
                              <p class={`text-xs uppercase tracking-[0.18em] ${accent}`}>{title}</p>
                              <h2 class="text-xl font-semibold text-zinc-100">
                                {backtest.symbol} • {backtest.strategy.type.replace(/_/g, " ")}
                              </h2>
                              <p class="font-mono text-xs text-zinc-500">{backtest.backtest_id}</p>
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
                            <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                              <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Total PnL</p>
                              <p class={`mt-2 font-mono text-lg font-semibold ${backtest.metrics.total_pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                                {formatMoney(backtest.metrics.total_pnl)}
                              </p>
                            </div>
                            <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                              <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Win Rate</p>
                              <p class="mt-2 font-mono text-lg font-semibold text-zinc-100">
                                {formatPercent(backtest.metrics.win_rate)}
                              </p>
                            </div>
                            <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                              <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Max Drawdown</p>
                              <p class="mt-2 font-mono text-sm font-semibold text-zinc-100">
                                {formatPercent(backtest.metrics.max_drawdown)}
                              </p>
                            </div>
                            <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                              <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Created</p>
                              <p class="mt-2 text-sm font-medium text-zinc-100">
                                {backtest.created_at.slice(0, 10)}
                              </p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </section>

                  <div class="app-panel app-panel-section">
                    <p class="max-w-3xl text-sm text-zinc-400">
                      Use the table below to compare both runs across returns, risk, and trade quality.
                      Once you spot the stronger candidate, jump back into the saved replay to inspect
                      where the path diverged.
                    </p>
                  </div>

                  <div class="app-panel overflow-hidden">
                    <div class="grid grid-cols-3 border-b border-zinc-800 bg-zinc-950/60">
                      <div class="p-4 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                        Metric
                      </div>
                      <div class="border-l border-zinc-800 p-4 text-sm font-semibold font-mono">
                        {a.backtest_id}
                      </div>
                      <div class="border-l border-zinc-800 p-4 text-sm font-semibold font-mono">
                        {b.backtest_id}
                      </div>
                    </div>

                    <For each={metricRows}>
                      {(row) => (
                        <div class="grid grid-cols-3 border-b border-zinc-800 last:border-b-0">
                          <div class="p-4 text-sm text-zinc-400">{row.label}</div>
                          <div class="border-l border-zinc-800 p-4 text-sm font-mono">
                            {row.getValue(a)}
                          </div>
                          <div class="border-l border-zinc-800 p-4 text-sm font-mono">
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
