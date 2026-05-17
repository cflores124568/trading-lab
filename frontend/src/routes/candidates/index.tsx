import { A } from "@solidjs/router";
import { createMemo, createResource, For, Show } from "solid-js";
import AppShell from "../../components/AppShell";
import { fetchCandidates, type CandidateLifecycleStatus } from "../../services/api";

function formatCurrency(value?: number | null): string {
  if (value === null || value === undefined) {
    return "n/a";
  }

  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
}

function formatPercent(value?: number | null, digits = 1): string {
  if (value === null || value === undefined) {
    return "n/a";
  }

  return `${(value * 100).toFixed(digits)}%`;
}

function formatTimestamp(value?: string | null): string {
  if (!value) {
    return "n/a";
  }

  return new Date(value).toLocaleString();
}

function formatParams(params: Record<string, unknown>): string {
  const entries = Object.entries(params);
  if (entries.length === 0) {
    return "Default params";
  }

  return entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

function statusTone(status: CandidateLifecycleStatus): string {
  switch (status) {
    case "approved":
      return "border-green-700 bg-green-950/40 text-green-200";
    case "paper_ready":
      return "border-green-700 bg-green-950/40 text-green-200";
    case "paper_running":
      return "border-amber-700 bg-amber-950/40 text-amber-200";
    case "paper_paused":
      return "border-stone-700 bg-stone-900 text-stone-200";
    case "rejected":
      return "border-red-700 bg-red-950/40 text-red-200";
    default:
      return "border-violet-700 bg-violet-950/40 text-violet-200";
  }
}

function describeStatus(status: CandidateLifecycleStatus): string {
  return status.replace(/_/g, " ");
}

export default function CandidateRegistryPage() {
  const [candidates] = createResource(fetchCandidates);
  const counts = createMemo(() => {
    const source = candidates() ?? [];
    return {
      total: source.length,
      active: source.filter((candidate) => candidate.lifecycle_status !== "rejected").length,
      approved: source.filter((candidate) => candidate.lifecycle_status === "approved").length,
      paper: source.filter((candidate) => candidate.lifecycle_status.startsWith("paper_")).length,
      rejected: source.filter((candidate) => candidate.lifecycle_status === "rejected").length,
    };
  });

  return (
    <AppShell
      title="Candidate Registry"
      subtitle="Promoted runs and paper handoffs."
      actions={
        <A
          href="/experiments"
          class="app-button-secondary"
        >
          Back to Experiments
        </A>
      }
    >
      <div class="space-y-6">
        <section class="app-panel app-panel-section">
          <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <div class="app-surface-muted px-4 py-3">
              <p class="app-kicker">Total</p>
              <p class="mt-2 text-2xl font-semibold text-stone-100">{counts().total}</p>
              <p class="mt-1 text-xs text-stone-500">All promoted candidates</p>
            </div>
            <div class="rounded-md border border-violet-800 bg-violet-950/30 px-4 py-3">
              <p class="app-kicker">Active</p>
              <p class="mt-2 text-2xl font-semibold text-stone-100">{counts().active}</p>
              <p class="mt-1 text-xs text-stone-500">Still in the decision pipeline</p>
            </div>
            <div class="rounded-md border border-green-800 bg-green-950/30 px-4 py-3">
              <p class="app-kicker">Approved</p>
              <p class="mt-2 text-2xl font-semibold text-stone-100">{counts().approved}</p>
              <p class="mt-1 text-xs text-stone-500">Ready for paper prep</p>
            </div>
            <div class="rounded-md border border-green-800 bg-green-950/30 px-4 py-3">
              <p class="app-kicker">Paper Stage</p>
              <p class="mt-2 text-2xl font-semibold text-stone-100">{counts().paper}</p>
              <p class="mt-1 text-xs text-stone-500">Drafted or wired for paper</p>
            </div>
            <div class="rounded-md border border-red-800 bg-red-950/30 px-4 py-3">
              <p class="app-kicker">Rejected</p>
              <p class="mt-2 text-2xl font-semibold text-stone-100">{counts().rejected}</p>
              <p class="mt-1 text-xs text-stone-500">Kept for audit, not for action</p>
            </div>
          </div>
        </section>

        <section class="app-panel app-panel-section">
          <div class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div class="space-y-2">
              <p class="app-kicker">Registry</p>
            </div>
            <div class="text-xs text-stone-500">
              Sorted by the most recently touched candidate first.
            </div>
          </div>

          <Show when={!candidates.loading} fallback={<div class="app-skeleton mt-6 h-56" />}>
            <Show
              when={(candidates() ?? []).length > 0}
              fallback={
                <div class="app-surface-muted mt-6 px-4 py-10 text-center text-sm text-stone-500">
                  No candidates yet. Promote a run from an experiment to start the Phase 2 review flow.
                </div>
              }
            >
              <div class="mt-6 overflow-x-auto">
                <table class="min-w-full border-separate border-spacing-y-2 text-sm">
                  <thead>
                    <tr class="text-left text-xs uppercase tracking-[0.18em] text-stone-500">
                      <th class="px-3 py-2">Candidate</th>
                      <th class="px-3 py-2">Experiment</th>
                      <th class="px-3 py-2">Params</th>
                      <th class="px-3 py-2">Metrics</th>
                      <th class="px-3 py-2">Paper Bot</th>
                      <th class="px-3 py-2">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={candidates()}>
                      {(candidate) => (
                        <tr class="rounded-md border border-stone-800 bg-stone-950/70 text-stone-200">
                          <td class="rounded-l-md px-3 py-3">
                            <div class="flex flex-wrap items-center gap-2">
                              <A
                                href={`/candidates/${candidate.candidate_id}`}
                                class="font-medium text-stone-100 transition-colors hover:text-white"
                              >
                                {candidate.symbol} {candidate.interval}
                              </A>
                              <span
                                class={`rounded-sm border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] ${statusTone(
                                  candidate.lifecycle_status,
                                )}`}
                              >
                                {describeStatus(candidate.lifecycle_status)}
                              </span>
                            </div>
                            <p class="mt-2 text-xs text-stone-500">
                              Rank {candidate.rank ?? "n/a"} · score{" "}
                              {candidate.score?.toFixed(2) ?? "n/a"} · prop{" "}
                              {candidate.passed ? "pass" : "fail"}
                            </p>
                          </td>
                          <td class="px-3 py-3">
                            <div class="font-medium text-stone-100">{candidate.experiment_name}</div>
                            <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-stone-500">
                              <A href={`/experiments/${candidate.experiment_id}`}>Open experiment</A>
                              <A href={`/backtests/${candidate.backtest_id}`}>Open backtest</A>
                            </div>
                          </td>
                          <td class="max-w-xs px-3 py-3 text-xs text-stone-300">
                            {formatParams(candidate.strategy_params)}
                          </td>
                          <td class="px-3 py-3 text-xs">
                            <div class="font-mono text-stone-100">
                              {formatCurrency(candidate.total_pnl)}
                            </div>
                            <div class="mt-1 text-stone-500">
                              WR {formatPercent(candidate.win_rate)} · DD{" "}
                              {formatPercent(candidate.max_drawdown, 2)}
                            </div>
                          </td>
                          <td class="px-3 py-3 text-xs">
                            <Show
                              when={candidate.paper_bot}
                              fallback={<span class="text-stone-500">No draft yet</span>}
                            >
                              {(paperBot) => (
                                <span class="rounded-sm border border-green-700 bg-green-950/30 px-2.5 py-1 font-medium uppercase tracking-[0.18em] text-green-200">
                                  {paperBot().status.replace(/_/g, " ")}
                                </span>
                              )}
                            </Show>
                          </td>
                          <td class="rounded-r-md px-3 py-3 text-xs text-stone-500">
                            {formatTimestamp(candidate.updated_at)}
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </Show>
          </Show>
        </section>
      </div>
    </AppShell>
  );
}
