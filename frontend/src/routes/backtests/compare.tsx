// frontend/src/routes/backtests/compare.tsx
import { useSearchParams } from "@solidjs/router";
import { createResource, Show, For } from "solid-js";
import { compareBacktests, type BacktestCompare } from "../../services/api";

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
    <div class="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <div class="max-w-6xl mx-auto">
        <h1 class="text-2xl font-bold tracking-tight mb-8">Compare Backtests</h1>

        <Show
          when={!comparison.loading}
          fallback={<div class="h-40 bg-zinc-900 rounded-xl animate-pulse" />}
        >
          <Show
            when={comparison()}
            fallback={
              <div class="bg-zinc-900 rounded-xl p-6 text-sm text-zinc-400">
                Missing compare params (a and b). Go back and select two backtests.
              </div>
            }
          >
            {(result) => {
              const data: BacktestCompare = result();
              const a = data.backtest_a;
              const b = data.backtest_b;

              return (
                <div class="bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden">
                  <div class="grid grid-cols-3 border-b border-zinc-800 bg-zinc-950/60">
                    <div class="p-4 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                      Metric
                    </div>
                    <div class="p-4 text-sm font-semibold border-l border-zinc-800 font-mono">
                      {a.backtest_id}
                    </div>
                    <div class="p-4 text-sm font-semibold border-l border-zinc-800 font-mono">
                      {b.backtest_id}
                    </div>
                  </div>

                  <For each={metricRows}>
                    {(row) => (
                      <div class="grid grid-cols-3 border-b border-zinc-800 last:border-b-0">
                        <div class="p-4 text-sm text-zinc-400">{row.label}</div>
                        <div class="p-4 text-sm font-mono border-l border-zinc-800">
                          {row.getValue(a)}
                        </div>
                        <div class="p-4 text-sm font-mono border-l border-zinc-800">
                          {row.getValue(b)}
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              );
            }}
          </Show>
        </Show>
      </div>
    </div>
  );
}