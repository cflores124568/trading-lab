import { A, useNavigate } from "@solidjs/router";
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import {
  BarChart3,
  CalendarDays,
  Check,
  Eye,
  FlaskConical,
  GitCompareArrows,
  Play,
  Plus,
  Sparkles,
  TrendingUp,
} from "lucide-solid";
import AppShell from "../../components/AppShell";
import WorkspaceLaunchControl from "../../components/workspace/WorkspaceLaunchControl";
import WorkspaceContextBadge from "../../components/workspace/WorkspaceContextBadge";
import { fetchBacktests, type BacktestSummary } from "../../services/api";

function formatMoney(value: number): string {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatStrategy(value: string): string {
  return value.replace(/_/g, " ");
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function BacktestLoadingState() {
  return (
    <div class="space-y-3">
      <div class="app-panel overflow-hidden">
        <div class="grid divide-y divide-stone-800 lg:grid-cols-4 lg:divide-x lg:divide-y-0">
          {[0, 1, 2, 3].map(() => (
            <div class="p-4">
              <div class="h-3 w-24 rounded-full bg-stone-800" />
              <div class="mt-4 h-7 w-20 rounded-lg bg-stone-800/80" />
            </div>
          ))}
        </div>
      </div>

      {[0, 1].map(() => (
        <div class="app-panel overflow-hidden">
          <div class="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_220px] lg:p-5">
            <div>
              <div class="flex gap-2">
                <div class="h-7 w-20 rounded-full bg-stone-800" />
                <div class="h-7 w-24 rounded-full bg-stone-800/70" />
              </div>
              <div class="mt-4 h-5 w-52 rounded-lg bg-stone-800" />
              <div class="mt-3 h-3 w-72 max-w-full rounded-full bg-stone-800/70" />
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div class="h-16 rounded-xl border border-stone-800 bg-stone-950/60" />
              <div class="h-16 rounded-xl border border-stone-800 bg-stone-950/60" />
            </div>
          </div>
          <div class="border-t border-stone-800 bg-stone-950/35 px-4 py-3">
            <div class="h-8 w-full max-w-md rounded-lg bg-stone-800/70" />
          </div>
        </div>
      ))}
    </div>
  );
}

function BacktestErrorState(props: { message: string }) {
  return (
    <div class="app-panel overflow-hidden">
      <div class="app-panel-section flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div class="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-red-900/70 bg-red-950/40 text-red-300">
            <BarChart3 size={18} />
          </div>
          <p class="mt-5 text-lg font-semibold text-stone-100">Backtests could not load</p>
          <p class="mt-2 max-w-2xl text-sm leading-6 text-stone-400">
            Start the backend and refresh this view.
          </p>
        </div>

        <p class="rounded-xl border border-stone-800 bg-stone-950 px-3 py-2 font-mono text-xs text-red-200">
          {props.message}
        </p>
      </div>
    </div>
  );
}

function BacktestEmptyState() {
  return (
    <div class="app-panel overflow-hidden">
      <div class="app-panel-section grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px] lg:items-center">
        <div>
          <div class="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-stone-800 bg-stone-950 text-stone-200">
            <Sparkles size={18} />
          </div>
          <p class="mt-5 text-lg font-semibold text-stone-100">No saved backtests yet</p>
          <p class="mt-2 max-w-2xl text-sm leading-6 text-stone-400">
            Run a strategy to start building the saved run library.
          </p>
        </div>

        <div class="flex flex-col gap-2">
          <A href="/backtests/new" class="app-button-primary gap-2">
            <Plus size={16} />
            Run First Backtest
          </A>
          <A href="/experiments" class="app-button-secondary gap-2">
            <FlaskConical size={16} />
            Open Experiments
          </A>
        </div>
      </div>
    </div>
  );
}

export default function BacktestList() {
  const [backtests] = createResource<BacktestSummary[]>(fetchBacktests);
  const [selected, setSelected] = createSignal<string[]>([]);
  const navigate = useNavigate();
  const backtestList = createMemo(() => backtests() ?? []);
  const summary = createMemo(() => {
    const list = backtestList();
    const totalPnl = list.reduce((sum, backtest) => sum + backtest.total_pnl, 0);
    const averageWinRate =
      list.length > 0
        ? list.reduce((sum, backtest) => sum + backtest.win_rate, 0) / list.length
        : 0;
    const symbols = new Set(list.map((backtest) => backtest.symbol)).size;
    const profitable = list.filter((backtest) => backtest.total_pnl >= 0).length;

    return {
      totalPnl,
      averageWinRate,
      symbols,
      profitable,
    };
  });

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
      subtitle="Saved runs, replay launches, and comparisons."
      actions={
        <>
          <Show when={selected().length === 2}>
            <A
              href={`/backtests/compare?a=${selected()[0]}&b=${selected()[1]}`}
              class="app-button-secondary gap-2"
            >
              <GitCompareArrows size={16} />
              Compare Selected
            </A>
          </Show>

          <A href="/backtests/new" class="app-button-primary gap-2">
            <Plus size={16} />
            New Backtest
          </A>
        </>
      }
    >
      <div class="mx-auto w-full max-w-6xl space-y-4">
        <WorkspaceContextBadge />

        <Show when={!backtests.loading} fallback={<BacktestLoadingState />}>
          <Show
            when={!backtests.error}
            fallback={<BacktestErrorState message={backtests.error?.message ?? "Unknown error"} />}
          >
            <Show when={backtestList().length > 0} fallback={<BacktestEmptyState />}>
              <div class="app-panel overflow-hidden">
                <div class="grid divide-y divide-stone-800 lg:grid-cols-4 lg:divide-x lg:divide-y-0">
                  <div class="p-4">
                    <p class="app-kicker">Saved Runs</p>
                    <p class="mt-3 text-2xl font-semibold text-stone-100">{backtestList().length}</p>
                  </div>
                  <div class="p-4">
                    <p class="app-kicker">Net PnL</p>
                    <p
                      class={`mt-3 font-mono text-2xl font-semibold ${
                        summary().totalPnl >= 0 ? "text-green-300" : "text-red-300"
                      }`}
                    >
                      {formatMoney(summary().totalPnl)}
                    </p>
                  </div>
                  <div class="p-4">
                    <p class="app-kicker">Avg Win Rate</p>
                    <p class="mt-3 font-mono text-2xl font-semibold text-stone-100">
                      {formatPercent(summary().averageWinRate)}
                    </p>
                  </div>
                  <div class="p-4">
                    <p class="app-kicker">Symbols</p>
                    <p class="mt-3 text-2xl font-semibold text-stone-100">{summary().symbols}</p>
                    <p class="mt-1 text-xs text-stone-500">{summary().profitable} profitable runs</p>
                  </div>
                </div>
              </div>

              <div class="space-y-3">
                <For each={backtestList()}>
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
                        class={`app-panel group block cursor-pointer overflow-hidden transition-all duration-150 hover:-translate-y-px ${
                          isSelected()
                            ? "border-stone-200/80 bg-stone-100/8 ring-1 ring-stone-200/50"
                            : "hover:border-stone-700 hover:bg-stone-900"
                        }`}
                      >
                        <div class="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_220px] lg:p-5">
                          <div class="min-w-0">
                            <div class="flex flex-wrap items-center gap-2">
                              <span class="inline-flex items-center gap-1.5 rounded-full border border-stone-700 bg-stone-950 px-2.5 py-1 text-xs font-semibold text-stone-100">
                                <BarChart3 size={13} class="text-stone-300" />
                                {bt.symbol}
                              </span>
                              <span class="rounded-full border border-stone-800 bg-stone-950 px-2.5 py-1 text-xs uppercase tracking-[0.16em] text-stone-500">
                                {bt.status}
                              </span>
                              <span class="inline-flex items-center gap-1.5 text-xs text-stone-500">
                                <CalendarDays size={13} />
                                {formatDate(bt.created_at)}
                              </span>
                            </div>

                            <div class="mt-3 flex min-w-0 items-start justify-between gap-4">
                              <div class="min-w-0">
                                <p class="truncate text-base font-semibold text-stone-100">
                                  {formatStrategy(bt.strategy_type)}
                                </p>
                                <p class="mt-1 font-mono text-xs text-stone-500">
                                  {bt.backtest_id.slice(0, 8)} · {bt.dataset_id}
                                </p>
                              </div>

                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggleSelected(bt.backtest_id);
                                }}
                                class={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                                  isSelected()
                                    ? "border-stone-200/80 bg-stone-100 text-stone-950"
                                    : "border-stone-700 bg-stone-950 text-stone-400 hover:border-stone-500 hover:text-stone-100"
                                }`}
                              >
                                {isSelected() ? <Check size={14} /> : <GitCompareArrows size={14} />}
                                Compare
                              </button>
                            </div>
                          </div>

                          <div class="grid grid-cols-2 gap-2 lg:text-right">
                            <div class="rounded-xl border border-stone-800 bg-stone-950/60 px-3 py-2">
                              <p class="text-xs text-stone-500">Total PnL</p>
                              <p
                                class={`mt-1 font-mono text-sm font-semibold ${
                                  bt.total_pnl >= 0 ? "text-green-300" : "text-red-300"
                                }`}
                              >
                                {formatMoney(bt.total_pnl)}
                              </p>
                            </div>
                            <div class="rounded-xl border border-stone-800 bg-stone-950/60 px-3 py-2">
                              <p class="text-xs text-stone-500">Win Rate</p>
                              <p class="mt-1 font-mono text-sm font-semibold text-stone-100">
                                {formatPercent(bt.win_rate)}
                              </p>
                            </div>
                          </div>
                        </div>

                        <div class="flex flex-col gap-3 border-t border-stone-800 bg-stone-950/35 px-4 py-3 lg:flex-row lg:items-center lg:justify-between lg:px-5">
                          <div class="flex flex-wrap items-center gap-2 text-xs text-stone-500">
                            <span class="inline-flex items-center gap-1.5">
                              <TrendingUp size={13} />
                              Replay-ready context
                            </span>
                            <Show when={bt.replay_context?.interval}>
                              {(interval) => (
                                <span class="rounded-full border border-stone-800 bg-stone-950 px-2 py-1 font-mono text-[11px] text-stone-400">
                                  {interval()}
                                </span>
                              )}
                            </Show>
                          </div>

                          <div class="flex flex-wrap items-center gap-2 lg:justify-end">
                            <Show when={workspaceIntent}>
                              {(intent) => (
                                <div onClick={(event) => event.stopPropagation()}>
                                  <WorkspaceLaunchControl intent={intent()} compact />
                                </div>
                              )}
                            </Show>
                            <A
                              href={detailHref}
                              class="app-button-compact-secondary gap-1.5"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <Eye size={14} />
                              View
                            </A>
                            <A
                              href={`/experiments?fromBacktestId=${bt.backtest_id}`}
                              class="app-button-compact-secondary gap-1.5"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <FlaskConical size={14} />
                              Sweep This
                            </A>
                            <A
                              href={launchSimHref}
                              class="app-button-compact-primary gap-1.5"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <Play size={14} />
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
        </Show>
      </div>
    </AppShell>
  );
}
