import { createResource, For, Show } from "solid-js";
import { A } from "@solidjs/router";
import { fetchBacktests, type BacktestSummary } from "../../services/api";

export default function BacktestList() {
  // Fetch backtests once on mount (Solid handles caching + reactivity)
  const [backtests] = createResource<BacktestSummary[]>(fetchBacktests);

  return (
    <div class="min-h-screen bg-zinc-950 text-zinc-100">
      <div class="max-w-4xl mx-auto px-6 py-10">

        {/* Header + primary CTA */}
        <div class="flex items-center justify-between mb-8">
          <h1 class="text-2xl font-bold tracking-tight">Backtests</h1>
          <A href="/backtests/new"
            class="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-semibold transition-colors"
          >
            + New backtest
          </A>
        </div>
        {/* loading/empty states */}
        <Show
          when={!backtests.loading}
          fallback={
            // Skeleton loader (prevents layout shift)
            <div class="h-40 bg-zinc-900 rounded-xl animate-pulse" />
          }
        >
          <Show
            // Guard against undefined resource result
            when={(backtests() ?? []).length > 0}
            fallback={
              // Empty state (first-time user experience)
              <div class="text-center py-20 text-zinc-500 text-sm">
                No backtests yet.{" "}
                <A href="/backtests/new" class="text-blue-400 hover:underline">
                  Run your first one:
                </A>
              </div>
            }
          >
            {/* Backtest list */}
            <div class="space-y-3">
              <For each={backtests()}>
                {bt => (
                  <A
                    href={`/backtests/${bt.backtest_id}`}
                    class="block bg-zinc-900 hover:bg-zinc-800 rounded-xl px-5 py-4
                           transition-colors border border-transparent
                           hover:border-zinc-700"
                  >
                    <div class="flex items-center justify-between">
                      <div>
                        {/* Normalize enum-style strategy names */}
                        <p class="text-sm font-medium">
                          {bt.strategy_type.replace(/_/g, " ")}
                        </p>

                        {/* Dataset + date (trim ISO for readability) */}
                        <p class="text-xs text-zinc-500 font-mono mt-0.5">
                          {bt.dataset_id} · {bt.created_at.slice(0, 10)}
                        </p>
                      </div>

                      <div class="text-right">
                        {/* PnL color-coded for quick scan */}
                        <p class={`text-sm font-semibold font-mono ${
                          bt.total_pnl >= 0 ? "text-green-400" : "text-red-400"
                        }`}>
                          {bt.total_pnl >= 0 ? "+" : ""}${bt.total_pnl.toFixed(2)}
                        </p>

                        {/* Derived metric (API returns decimal) */}
                        <p class="text-xs text-zinc-500 mt-0.5">
                          {(bt.win_rate * 100).toFixed(1)}% win rate
                        </p>
                      </div>
                    </div>
                  </A>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}