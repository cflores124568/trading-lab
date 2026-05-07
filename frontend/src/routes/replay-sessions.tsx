import { A } from "@solidjs/router";
import { createResource, For, Show } from "solid-js";
import AppShell from "../components/AppShell";
import WorkspaceLaunchControl from "../components/workspace/WorkspaceLaunchControl";
import WorkspaceContextBadge from "../components/workspace/WorkspaceContextBadge";
import { fetchReplaySessions, type ReplaySessionSummary } from "../services/api";
import { formatReplaySessionStatus } from "../services/replaySessionState";

function formatMoney(value: number): string {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
}

function formatRange(session: ReplaySessionSummary): string {
  if (!session.start_date && !session.end_date) {
    return "Full available range";
  }

  return `${session.start_date || "Earliest"} to ${session.end_date || "Latest"}`;
}

export default function ReplaySessionListPage() {
  const [sessions] = createResource(fetchReplaySessions);

  return (
    <AppShell
      title="Replay Sessions"
      subtitle="Saved replay sessions."
      actions={
        <A
          href="/replay"
          class="app-button-primary"
        >
          New Replay
        </A>
      }
    >
      <div class="mx-auto w-full max-w-5xl">
        <WorkspaceContextBadge />

        <Show when={!sessions.loading} fallback={<div class="app-panel h-40 animate-pulse" />}>
          <Show
            when={(sessions() ?? []).length > 0}
            fallback={
              <div class="app-panel app-panel-section py-20 text-center text-sm text-zinc-500">
                No replay sessions yet.{" "}
                <A href="/replay" class="text-zinc-100 hover:underline">
                  Launch your first saved session
                </A>
              </div>
            }
          >
            <div class="space-y-3">
              <For each={sessions()}>
                {(session) => (
                  <div class="app-panel px-5 py-4">
                    <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div class="space-y-2">
                        <p class="text-sm font-semibold text-zinc-100">{session.name}</p>
                        <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">
                          {session.symbol} · {session.interval} · {formatReplaySessionStatus(session.status)}
                        </p>
                        <p class="text-sm text-zinc-400">{formatRange(session)}</p>
                        <Show when={session.source_backtest}>
                          {(source) => (
                            <p class="text-xs text-zinc-500">
                              Linked to `{source().backtest_id.slice(0, 8)}`.
                            </p>
                          )}
                        </Show>
                        <p class="text-xs text-zinc-500">
                          Updated {new Date(session.updated_at).toLocaleString()}
                        </p>
                      </div>

                      <div class="grid grid-cols-3 gap-3 text-right">
                        <div class="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                          <p class="text-xs text-zinc-500">Total PnL</p>
                          <p
                            class={`mt-1 font-mono text-sm font-semibold ${
                              session.total_pnl >= 0 ? "text-green-400" : "text-red-400"
                            }`}
                          >
                            {formatMoney(session.total_pnl)}
                          </p>
                        </div>
                        <div class="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                          <p class="text-xs text-zinc-500">Trades</p>
                          <p class="mt-1 font-mono text-sm font-semibold text-zinc-100">
                            {session.total_trades}
                          </p>
                        </div>
                        <div class="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                          <p class="text-xs text-zinc-500">Saved Bar</p>
                          <p class="mt-1 font-mono text-sm font-semibold text-zinc-100">
                            {session.current_bar_index + 1}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div class="mt-4 flex items-center justify-end gap-2 border-t border-zinc-800 pt-4">
                      <WorkspaceLaunchControl
                        intent={{
                          source: "replay-session",
                          symbol: session.symbol,
                          interval: session.interval,
                          startDate: session.start_date,
                          endDate: session.end_date,
                        }}
                        compact
                      />
                      <A
                        href={`/replay/${session.replay_session_id}`}
                        class="app-button-compact-primary"
                      >
                        Resume Session
                      </A>
                      <Show when={session.source_backtest}>
                        <A
                          href={`/replay/${session.replay_session_id}/compare`}
                          class="app-button-compact-secondary"
                        >
                          Compare Vs System
                        </A>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </AppShell>
  );
}
