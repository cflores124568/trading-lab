import { createResource, For, Show, createSignal } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import AppShell from "../../components/AppShell";
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
    <AppShell
      title="Backtests"
      subtitle="Review saved runs, jump into replay, and compare strategy outcomes from one place."
      actions={
        <>
          <Show when={selected().length === 2}>
            <A
              href={`/backtests/compare?a=${selected()[0]}&b=${selected()[1]}`}
              class="rounded-xl bg-purple-600 px-4 py-2 text-sm font-semibold transition-colors hover:bg-purple-500"
            >
              Compare Selected
            </A>
          </Show>

          <A
            href="/replay"
            class="rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
          >
            Replay Lab
          </A>

          <A
            href="/replay-sessions"
            class="rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
          >
            Replay Sessions
          </A>

          <A
            href="/backtests/new"
            class="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold transition-colors hover:bg-blue-500"
          >
            + New backtest
          </A>
        </>
      }
    >
      <div class="mx-auto w-full max-w-4xl">
        <Show
          when={!backtests.loading}
          fallback={<div class="app-panel h-40 animate-pulse" />}
        >
          <Show
            when={(backtests() ?? []).length > 0}
            fallback={
              <div class="app-panel app-panel-section py-20 text-center text-sm text-zinc-500">
                No backtests yet.{" "}
                <A href="/backtests/new" class="text-blue-400 hover:underline">
                  Run your first one
                </A>
              </div>
            }
          >
            <div class="space-y-3">
              <For each={backtests()}>
                {(bt) => {
                  const isSelected = () => selected().includes(bt.backtest_id);
                  const detailHref = `/backtests/${bt.backtest_id}`;
                  const replayHref = `${detailHref}#replay`;

                  return (
                    <div
                      onClick={() => navigate(detailHref)}
                      class={`app-panel block cursor-pointer px-5 py-4 transition-colors ${
                        isSelected()
                          ? "border-purple-500 ring-1 ring-purple-500"
                          : "border-transparent hover:border-zinc-700 hover:bg-zinc-800"
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
                            <p class="mt-0.5 font-mono text-xs text-zinc-500">
                              {bt.created_at.slice(0, 10)}
                            </p>
                            <p class="mt-2 text-xs text-zinc-400">
                              Replay this saved run candle by candle from the detail page.
                            </p>
                          </div>
                        </div>

                        <div class="text-right">
                          <p
                            class={`font-mono text-sm font-semibold ${
                              bt.total_pnl >= 0 ? "text-green-400" : "text-red-400"
                            }`}
                          >
                            {bt.total_pnl >= 0 ? "+" : ""}${bt.total_pnl.toFixed(2)}
                          </p>
                          <p class="mt-0.5 text-xs text-zinc-500">
                            {(bt.win_rate * 100).toFixed(1)}% win rate
                          </p>
                        </div>
                      </div>

                      <div class="mt-4 flex items-center justify-between gap-4 border-t border-zinc-800 pt-4">
                        <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">
                          Saved replay context
                        </p>

                        <div class="flex items-center gap-2">
                          <A
                            href={detailHref}
                            class="rounded-lg border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
                            onClick={(event) => event.stopPropagation()}
                          >
                            View
                          </A>
                          <A
                            href={replayHref}
                            class="rounded-lg bg-zinc-100 px-3 py-2 text-xs font-semibold text-zinc-950 transition-colors hover:bg-white"
                            onClick={(event) => event.stopPropagation()}
                          >
                            Replay
                          </A>
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
    </AppShell>
  );
}
