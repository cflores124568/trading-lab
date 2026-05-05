import { A } from "@solidjs/router";
import { createResource, For, Show } from "solid-js";
import AppShell from "../../components/AppShell";
import { fetchPaperSessions } from "../../services/api";

function describeStatus(status: string): string {
  return status.replace(/_/g, " ");
}

function statusTone(status: string): string {
  switch (status) {
    case "running":
      return "border-amber-700 bg-amber-950/40 text-amber-200";
    case "ready":
      return "border-sky-700 bg-sky-950/40 text-sky-200";
    case "paused":
      return "border-zinc-700 bg-zinc-900 text-zinc-200";
    case "stopped":
      return "border-zinc-800 bg-zinc-950/70 text-zinc-300";
    case "failed":
      return "border-red-700 bg-red-950/40 text-red-200";
    default:
      return "border-violet-700 bg-violet-950/40 text-violet-200";
  }
}

function runnerHealthTone(health: string): string {
  switch (health) {
    case "healthy":
      return "border-amber-700 bg-amber-950/40 text-amber-200";
    case "quiet":
      return "border-emerald-700 bg-emerald-950/40 text-emerald-200";
    case "paused":
      return "border-zinc-700 bg-zinc-900 text-zinc-200";
    case "failed":
      return "border-red-700 bg-red-950/40 text-red-200";
    case "drift":
      return "border-violet-700 bg-violet-950/40 text-violet-200";
    case "observed":
      return "border-sky-700 bg-sky-950/40 text-sky-200";
    default:
      return "border-zinc-700 bg-zinc-900 text-zinc-300";
  }
}

function runnerHealthLabel(health: string): string {
  switch (health) {
    case "healthy":
      return "healthy";
    case "quiet":
      return "quiet";
    case "paused":
      return "paused";
    case "failed":
      return "failed";
    case "drift":
      return "drift";
    case "observed":
      return "observed";
    default:
      return "idle";
  }
}

function formatTimestamp(value?: string | null): string {
  if (!value) {
    return "n/a";
  }

  return new Date(value).toLocaleString();
}

function formatRunnerAction(value?: string | null): string {
  if (!value) {
    return "none";
  }

  return value.replace(/_/g, " ");
}

function formatRunnerParity(value?: boolean | null): string {
  if (value === true) {
    return "pass";
  }
  if (value === false) {
    return "fail";
  }
  return "n/a";
}

export default function PaperSessionListPage() {
  const [sessions] = createResource(fetchPaperSessions);

  return (
    <AppShell
      title="Paper Sessions"
      subtitle="Paper runtime sessions and event trails."
      actions={
        <A
          href="/candidates"
          class="rounded-sm border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
        >
          Candidate Registry
        </A>
      }
    >
      <div class="mx-auto w-full max-w-5xl">
        <Show when={!sessions.loading} fallback={<div class="app-panel h-40 animate-pulse" />}>
          <Show
            when={(sessions() ?? []).length > 0}
            fallback={
              <div class="app-panel app-panel-section py-20 text-center text-sm text-zinc-500">
                No paper sessions yet. Start from a candidate.
              </div>
            }
          >
            <div class="space-y-3">
              <For each={sessions()}>
                {(session) => (
                  <div class="app-panel px-5 py-4">
                    <div class="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                      <div class="space-y-2">
                        <div class="flex flex-wrap items-center gap-2">
                          <p class="text-sm font-semibold text-zinc-100">{session.name}</p>
                          <span
                            class={`rounded-sm border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] ${statusTone(
                              session.status,
                            )}`}
                          >
                            {describeStatus(session.status)}
                          </span>
                        </div>
                        <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">
                          {session.symbol} · {session.interval}
                        </p>
                        <p class="text-sm text-zinc-400">
                          Last event {formatTimestamp(session.last_event_at)} · updated{" "}
                          {formatTimestamp(session.updated_at)}
                        </p>
                        <p class="text-xs text-zinc-500">
                          Candidate <code>{session.candidate_id.slice(0, 8)}</code>
                        </p>
                      </div>

                      <div class="space-y-3 xl:min-w-[520px]">
                        <div class="flex flex-wrap items-center gap-2 xl:justify-end">
                          <span
                            class={`rounded-sm border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] ${runnerHealthTone(
                              session.runner_health,
                            )}`}
                          >
                            {runnerHealthLabel(session.runner_health)}
                          </span>
                          <span
                            class={`rounded-sm border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] ${statusTone(
                              session.status,
                            )}`}
                          >
                            {describeStatus(session.status)}
                          </span>
                        </div>

                        <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                          <div class="app-subpanel px-4 py-3">
                            <p class="app-kicker">Cursor</p>
                            <p class="mt-2 text-sm font-semibold text-zinc-100">
                              {session.runner_bars_processed} bars
                            </p>
                            <p class="mt-1 text-xs text-zinc-500">
                              {formatTimestamp(session.runner_last_candle_time ?? session.last_bar_time)}
                            </p>
                          </div>
                          <div class="app-subpanel px-4 py-3">
                            <p class="app-kicker">Latest Action</p>
                            <p class="mt-2 text-sm font-semibold text-zinc-100">
                              {formatRunnerAction(session.runner_last_action)}
                            </p>
                          </div>
                          <div class="app-subpanel px-4 py-3">
                            <p class="app-kicker">Parity</p>
                            <p class="mt-2 text-sm font-semibold text-zinc-100">
                              {formatRunnerParity(session.runner_parity_passed)}
                            </p>
                          </div>
                          <div class="app-subpanel px-4 py-3">
                            <p class="app-kicker">Runner Error</p>
                            <p class="mt-2 text-sm font-semibold text-zinc-100">
                              {session.runner_last_error ?? "none"}
                            </p>
                          </div>
                        </div>
                      </div>

                      <div class="flex items-center gap-2 xl:justify-self-end">
                        <A
                          href={`/candidates/${session.candidate_id}`}
                          class="rounded-sm border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
                        >
                          Open Candidate
                        </A>
                        <A
                          href={`/paper-sessions/${session.paper_session_id}`}
                          class="rounded-sm bg-zinc-100 px-3 py-2 text-xs font-semibold text-zinc-950 transition-colors hover:bg-white"
                        >
                          Open Session
                        </A>
                      </div>
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
