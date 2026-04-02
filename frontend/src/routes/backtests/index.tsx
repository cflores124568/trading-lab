import { createResource, For, Show, createSignal } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { fetchBacktests, type BacktestSummary } from "../../services/api";

export default function BacktestList() {
  // Fetch backtests once on mount (Solid handles caching + reactivity)
  const [backtests] = createResource<BacktestSummary[]>(fetchBacktests);
  const [selected, setSelected] = createSignal<string[]>([]);
  const navigate = useNavigate();

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) {
        return prev.filter((value) => value !== id);
      }
      if (prev.length === 2) {
        return prev;
      }
      return [...prev, id];
    });
  };

  return (
    <div class="min-h-screen bg-zinc-950 text-zinc-100">
      <div class="max-w-4xl mx-auto px-6 py-10">
        {/* Header + primary CTA */}
        <div class="flex items-center justify-between mb-8">
          <h1 class="text-2xl font-bold tracking-tight">Backtests</h1>
          <div class="flex items-center gap-3">
            <Show when={selected().length === 2}>
              <A
                href={`/backtests/compare?a=${selected()[0]}&b=${selected()[1]}`}
                class="px-4 py-2 bg-purple-600 hover:bg-purple-500 rounded-lg text-sm font-semibold transition-colors"
              >
                Compare
              </A>
            </Show>

            <A
              href="/backtests/new"
              class="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-semibold transition-colors"
            >
              + New backtest
            </A>
          </div>
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
                  Run your first one
                </A>
              </div>
            }
          >
            {/* Backtest list */}
            <div class="space-y-3">
              <For each={backtests()}>
                {(bt) => {
                  const isSelected = () => selected().includes(bt.backtest_id);

                  return (
                    <div
                      onClick={() => navigate(`/backtests/${bt.backtest_id}`)}
                      class={`block rounded-xl px-5 py-4 transition-colors border cursor-pointer ${
                        isSelected()
                          ? "bg-zinc-900 border-purple-500 ring-1 ring-purple-500"
                          : "bg-zinc-900 hover:bg-zinc-800 border-transparent hover:border-zinc-700"
                      }`}
                    >
                      <div class="flex items-start justify-between gap-4">
                        <div class="flex items-start gap-3">
                          <input
                            type="checkbox"
                            checked={isSelected()}
                            onClick={(event) => event.stopPropagation()}
                            onChange={() => toggleSelected(bt.backtest_id)}
                            class="mt-1 h-4 w-4 rounded border-zinc-700 bg-zinc-950 text-purple-500 focus:ring-purple-500"
                          />
                          <div>
                            <p class="text-sm font-medium">
                              {bt.symbol} • {bt.strategy_type.replace(/_/g, " ")}
                            </p>
                            <p class="text-xs text-zinc-500 font-mono mt-0.5">
                              {bt.created_at.slice(0, 10)}
                            </p>
                          </div>
                        </div>

                        <div class="text-right">
                          <p
                            class={`text-sm font-semibold font-mono ${
                              bt.total_pnl >= 0 ? "text-green-400" : "text-red-400"
                            }`}
                          >
                            {bt.total_pnl >= 0 ? "+" : ""}${bt.total_pnl.toFixed(2)}
                          </p>
                          <p class="text-xs text-zinc-500 mt-0.5">
                            {(bt.win_rate * 100).toFixed(1)}% win rate
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}