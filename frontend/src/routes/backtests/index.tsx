import { createResource, For, Show, createSignal } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import AppShell from "../../components/AppShell";
import WorkspaceLaunchControl from "../../components/workspace/WorkspaceLaunchControl";
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
              class="app-button-primary"
            >
              Compare Selected
            </A>
          </Show>

          <A
            href="/replay"
            class="app-button-secondary"
          >
            Replay Lab
          </A>

          <A
            href="/replay-sessions"
            class="app-button-secondary"
          >
            Replay Sessions
          </A>

          <A
            href="/experiments"
            class="app-button-secondary"
          >
            Experiments
          </A>

          <A
            href="/backtests/new"
            class="app-button-primary"
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
                <A href="/backtests/new" class="app-link-accent">
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
                  const launchSimHref = `/replay?backtestId=${bt.backtest_id}`;
                  const workspaceIntent =
                    bt.symbol && bt.replay_context?.interval
                      ? {
                          source: "backtest" as const,
                          symbol: bt.symbol,
                          interval: bt.replay_context.interval,
                          startDate: bt.replay_context.start_date ?? undefined,
                          endDate: bt.replay_context.end_date ?? undefined,
                        }
                      : null;

                  return (
                    <div
                      onClick={() => navigate(detailHref)}
                      class={`app-panel block cursor-pointer px-5 py-4 transition-colors ${
                        isSelected()
                          ? "app-card-selected"
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
                            class="mt-1 h-4 w-4 rounded border-zinc-700 bg-zinc-950 text-sky-400 focus:ring-sky-400"
                          />
                          <div>
                            <p class="text-sm font-medium">
                              {bt.symbol} • {bt.strategy_type.replace(/_/g, " ")}
                            </p>
                            <p class="mt-0.5 font-mono text-xs text-zinc-500">
                              {bt.created_at.slice(0, 10)}
                            </p>
                            <p class="mt-2 text-xs text-zinc-400">
                              Launch a simulated-live run from this backtest or open the detail page for the old flexible replay view.
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
                          <Show when={workspaceIntent}>
                            {(intent) => (
                              <div onClick={(event) => event.stopPropagation()}>
                                <WorkspaceLaunchControl
                                  intent={intent()}
                                  compact
                                />
                              </div>
                            )}
                          </Show>
                          <A
                            href={detailHref}
                            class="app-button-compact-secondary"
                            onClick={(event) => event.stopPropagation()}
                          >
                            View
                          </A>
                          <A
                            href={`/experiments?fromBacktestId=${bt.backtest_id}`}
                            class="app-button-compact-secondary"
                            onClick={(event) => event.stopPropagation()}
                          >
                            Sweep This
                          </A>
                          <A
                            href={launchSimHref}
                            class="app-button-compact-primary"
                            onClick={(event) => event.stopPropagation()}
                          >
                            Launch Sim
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
