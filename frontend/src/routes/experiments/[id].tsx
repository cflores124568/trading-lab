import { A, useParams } from "@solidjs/router";
import { batch, createMemo, createResource, createSignal, For, Show } from "solid-js";
import AppShell from "../../components/AppShell";
import {
  fetchExperiment,
  fetchExperimentResults,
  promoteExperimentRun,
  runExperiment,
  type ExperimentResult,
} from "../../services/api";

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

function formatNumber(value?: number | null, digits = 2): string {
  if (value === null || value === undefined) {
    return "n/a";
  }

  if (!Number.isFinite(value)) {
    return "inf";
  }

  return value.toFixed(digits);
}

function formatProfitFactor(value?: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "∞";
  }

  return value.toFixed(2);
}

function statusTone(status: ExperimentResult["status"]): string {
  switch (status) {
    case "completed":
      return "border-green-800 bg-green-950/40 text-green-200";
    case "running":
      return "border-blue-800 bg-blue-950/40 text-blue-200";
    case "failed":
      return "border-red-800 bg-red-950/40 text-red-200";
    default:
      return "border-stone-700 bg-stone-900 text-stone-200";
  }
}

function describeStatus(status: ExperimentResult["status"]): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "running":
      return "Running";
    case "failed":
      return "Failed";
    default:
      return "Draft";
  }
}

function formatTimestamp(value?: string | null): string {
  if (!value) {
    return "Not run yet";
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

function formatExecutionMode(mode?: "bar" | "synthetic_quotes" | null): string {
  return mode === "synthetic_quotes" ? "Synthetic quotes" : "Simple bar fills";
}

function metricCardTone(tone: "default" | "good" | "bad" = "default"): string {
  if (tone === "good") {
    return "border-green-800 bg-green-950/30";
  }
  if (tone === "bad") {
    return "border-red-800 bg-red-950/30";
  }
  return "border-stone-800 bg-stone-950/60";
}

export default function ExperimentDetailPage() {
  const params = useParams();
  const experimentId = () => params.id ?? "";
  const [busy, setBusy] = createSignal(false);
  const [candidateBusyId, setCandidateBusyId] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [experiment, { mutate: mutateExperiment, refetch: refetchExperiment }] = createResource(
    experimentId,
    fetchExperiment,
  );
  const [results, { mutate: mutateResults, refetch: refetchResults }] = createResource(
    experimentId,
    fetchExperimentResults,
  );
  const completedRuns = createMemo(
    () => (results() ?? []).filter((run) => run.status === "completed"),
  );
  const failedRuns = createMemo(() => (results() ?? []).filter((run) => run.status === "failed"));
  const candidateRuns = createMemo(() =>
    completedRuns().filter((run) => run.is_candidate),
  );
  const bestRun = createMemo(() => completedRuns()[0] ?? null);

  const handleRun = async () => {
    batch(() => {
      setBusy(true);
      setError(null);
    });

    try {
      const payload = await runExperiment(experimentId());
      mutateExperiment(() => payload.experiment);
      mutateResults(() => payload.results);
      await Promise.all([refetchExperiment(), refetchResults()]);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : "Experiment run failed.");
    } finally {
      setBusy(false);
    }
  };

  const patchRun = (nextRun: Awaited<ReturnType<typeof promoteExperimentRun>>) => {
    mutateResults((current) =>
      (current ?? []).map((run) =>
        run.experiment_run_id === nextRun.experiment_run_id ? nextRun : run,
      ),
    );
  };

  const handleCandidatePromote = async (runId: string) => {
    batch(() => {
      setCandidateBusyId(runId);
      setError(null);
    });

    try {
      const nextRun = await promoteExperimentRun(experimentId(), runId);
      patchRun(nextRun);
      await refetchExperiment();
    } catch (errorValue) {
      setError(
        errorValue instanceof Error ? errorValue.message : "Candidate update failed.",
      );
    } finally {
      setCandidateBusyId(null);
    }
  };

  return (
    <AppShell
      title={experiment()?.name ?? "Experiment"}
      subtitle={
        experiment()
          ? `${experiment()!.symbols.join(", ")} | ${experiment()!.intervals.join(", ")} | ${experiment()!.strategy_type.replace(/_/g, " ")}`
          : "Ranked sweep detail."
      }
      actions={
        <>
          <Show when={experiment()?.best_backtest_id}>
            {(bestBacktestId) => (
              <A
                href={`/backtests/${bestBacktestId()}`}
                class="rounded-xl border border-stone-700 px-4 py-2 text-sm font-medium text-stone-200 transition-colors hover:border-stone-500 hover:bg-stone-900"
              >
                Best Backtest
              </A>
            )}
          </Show>
          <button
            type="button"
            disabled={busy()}
            onClick={handleRun}
            class={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
              busy()
                ? "cursor-not-allowed bg-stone-800 text-stone-500"
                : "bg-stone-100 text-stone-950 hover:bg-white"
            }`}
          >
            {busy() ? "Running batch..." : "Run Batch"}
          </button>
          <A
            href="/experiments"
            class="rounded-xl border border-stone-700 px-4 py-2 text-sm font-medium text-stone-200 transition-colors hover:border-stone-500 hover:bg-stone-900"
          >
            Back to Experiments
          </A>
        </>
      }
    >
      <Show
        when={experiment()}
        fallback={
          <section class="app-panel app-panel-section flex min-h-60 items-center justify-center">
            <p class="text-stone-400">Loading experiment...</p>
          </section>
        }
      >
        {(batchResult) => (
          <div class="space-y-6">
            <Show when={error()}>
              <div class="rounded-2xl border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-200">
                {error()}
              </div>
            </Show>

            <section class="app-panel app-panel-section space-y-5">
              <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div class="space-y-2">
                  <div class="flex flex-wrap items-center gap-2">
                    <p class="app-kicker">Experiment Snapshot</p>
                    <span
                      class={`rounded-full border px-2.5 py-1 text-xs font-medium ${statusTone(
                        batchResult().status,
                      )}`}
                    >
                      {describeStatus(batchResult().status)}
                    </span>
                  </div>
                  <p class="max-w-3xl text-sm text-stone-400">
                    {batchResult().symbols.length} symbols · {batchResult().intervals.length} intervals ·{" "}
                    {batchResult().strategy_type}
                  </p>
                </div>

                <div class="rounded-2xl border border-stone-800 bg-stone-950/60 px-4 py-3 text-right">
                  <p class="text-xs uppercase tracking-[0.18em] text-stone-500">Last Activity</p>
                  <p class="mt-2 text-sm font-medium text-stone-100">
                    {formatTimestamp(batchResult().last_run_at ?? batchResult().updated_at)}
                  </p>
                </div>
              </div>

              <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div class={`rounded-2xl border px-4 py-3 ${metricCardTone()}`}>
                  <p class="text-xs uppercase tracking-[0.18em] text-stone-500">Coverage</p>
                  <p class="mt-2 text-sm font-semibold text-stone-100">
                    {batchResult().symbols.join(", ")}
                  </p>
                  <p class="mt-1 text-xs text-stone-500">{batchResult().intervals.join(", ")}</p>
                </div>
                <div class={`rounded-2xl border px-4 py-3 ${metricCardTone()}`}>
                  <p class="text-xs uppercase tracking-[0.18em] text-stone-500">Runs</p>
                  <p class="mt-2 text-sm font-semibold text-stone-100">
                    {batchResult().completed_runs}/{batchResult().total_runs} completed
                  </p>
                  <p class="mt-1 text-xs text-stone-500">{batchResult().failed_runs} failed</p>
                </div>
                <div
                  class={`rounded-2xl border px-4 py-3 ${metricCardTone(
                    candidateRuns().length > 0 ? "good" : "default",
                  )}`}
                >
                  <p class="text-xs uppercase tracking-[0.18em] text-stone-500">Candidates</p>
                  <p class="mt-2 text-sm font-semibold text-stone-100">
                    {candidateRuns().length}
                  </p>
                  <p class="mt-1 text-xs text-stone-500">
                    {candidateRuns().length > 0
                      ? "Marked for the Phase 2 handoff"
                      : "No promoted runs yet"}
                  </p>
                </div>
                <div
                  class={`rounded-2xl border px-4 py-3 ${metricCardTone(
                    bestRun() ? "good" : "default",
                  )}`}
                >
                  <p class="text-xs uppercase tracking-[0.18em] text-stone-500">Best Score</p>
                  <p class="mt-2 text-sm font-semibold text-stone-100">
                    {formatNumber(bestRun()?.score, 2)}
                  </p>
                  <p class="mt-1 text-xs text-stone-500">
                    {bestRun() ? `${bestRun()!.symbol} ${bestRun()!.interval}` : "No completed run yet"}
                  </p>
                </div>
                <div class={`rounded-2xl border px-4 py-3 ${metricCardTone()}`}>
                  <p class="text-xs uppercase tracking-[0.18em] text-stone-500">Scoring Rule</p>
                  <p class="mt-2 text-sm font-semibold text-stone-100">
                    {batchResult().scoring_rule}
                  </p>
                  <p class="mt-1 text-xs text-stone-500">
                    Created {formatTimestamp(batchResult().created_at)}
                  </p>
                </div>
              </div>

              <div class="grid gap-4 lg:grid-cols-2">
                <div class="rounded-2xl border border-stone-800 bg-stone-950/60 px-4 py-4">
                  <p class="text-xs uppercase tracking-[0.18em] text-stone-500">Parameter Space</p>
                  <div class="mt-3 flex flex-wrap gap-2">
                    <For each={Object.entries(batchResult().parameter_space)}>
                      {([key, values]) => (
                        <span class="rounded-full border border-stone-700 bg-stone-900 px-3 py-2 text-xs text-stone-200">
                          {key}: {Array.isArray(values) ? values.join(", ") : String(values)}
                        </span>
                      )}
                    </For>
                  </div>
                </div>

                <div class="rounded-2xl border border-stone-800 bg-stone-950/60 px-4 py-4">
                  <p class="text-xs uppercase tracking-[0.18em] text-stone-500">Sizing + Dates</p>
                  <div class="mt-3 grid gap-2 text-sm text-stone-300">
                    <p>Initial balance: ${batchResult().initial_balance.toLocaleString()}</p>
                    <p>Position size: {batchResult().position_size}</p>
                    <p>Commission: ${batchResult().commission.toFixed(2)}</p>
                    <p>Slippage: {batchResult().slippage_ticks.toFixed(2)} ticks</p>
                    <p>Execution: {formatExecutionMode(batchResult().execution_mode)}</p>
                    <Show when={batchResult().execution_mode === "synthetic_quotes"}>
                      <p>
                        Spread: {batchResult().spread_ticks}t base, +{batchResult().volatile_bar_extra_ticks}t after{" "}
                        {batchResult().volatile_bar_threshold_ticks}t bar range
                      </p>
                    </Show>
                    <p>
                      Range: {batchResult().start_date ?? "Start open"} to{" "}
                      {batchResult().end_date ?? "End open"}
                    </p>
                    <p>Prop preset: {batchResult().prop_firm_rules.name}</p>
                  </div>
                </div>
              </div>
            </section>

            <section class="app-panel app-panel-section">
              <div class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div class="space-y-2">
                  <p class="app-kicker">Ranked Results</p>
                </div>
                <div class="flex flex-wrap items-center gap-2 text-xs text-stone-500">
                  <span>{completedRuns().length} completed</span>
                  <span>{candidateRuns().length} candidates</span>
                  <span>{failedRuns().length} failed</span>
                </div>
              </div>

              <Show when={!results.loading} fallback={<div class="app-skeleton mt-6 h-56" />}>
                <Show
                  when={(results() ?? []).length > 0}
                  fallback={
                    <div class="mt-6 rounded-2xl border border-stone-800 bg-stone-950/60 px-4 py-10 text-center text-sm text-stone-500">
                      No ranked runs yet. Hit `Run Batch` when you're ready.
                    </div>
                  }
                >
                  <div class="mt-6 overflow-x-auto">
                    <table class="min-w-full border-separate border-spacing-y-2 text-sm">
                      <thead>
                        <tr class="text-left text-xs uppercase tracking-[0.18em] text-stone-500">
                          <th class="px-3 py-2">Rank</th>
                          <th class="px-3 py-2">Market</th>
                          <th class="px-3 py-2">Params</th>
                          <th class="px-3 py-2">Score</th>
                          <th class="px-3 py-2">Prop</th>
                          <th class="px-3 py-2">PnL</th>
                          <th class="px-3 py-2">Drawdown</th>
                          <th class="px-3 py-2">PF</th>
                          <th class="px-3 py-2">Candidate</th>
                          <th class="px-3 py-2">Backtest</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={results()}>
                          {(run) => (
                            <tr class="rounded-2xl border border-stone-800 bg-stone-950/70 text-stone-200">
                              <td class="rounded-l-2xl px-3 py-3 font-mono text-xs text-stone-400">
                                {run.rank ?? "—"}
                              </td>
                              <td class="px-3 py-3">
                                <div class="font-medium text-stone-100">
                                  {run.symbol} {run.interval}
                                </div>
                                <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-stone-500">
                                  <span>{run.status}</span>
                                  <Show when={run.is_candidate}>
                                    <span class="rounded-full border border-green-700 bg-green-950/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-green-200">
                                      Candidate
                                    </span>
                                  </Show>
                                </div>
                              </td>
                              <td class="max-w-xs px-3 py-3 text-xs text-stone-300">
                                <div>{formatParams(run.strategy_params)}</div>
                                <Show when={run.error}>
                                  <p class="mt-2 text-red-300">{run.error}</p>
                                </Show>
                              </td>
                              <td class="px-3 py-3 font-mono text-xs">
                                {formatNumber(run.score, 2)}
                              </td>
                              <td class="px-3 py-3">
                                <span
                                  class={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                                    run.passed
                                      ? "border-green-700 bg-green-950/40 text-green-200"
                                      : run.status === "failed"
                                        ? "border-stone-700 bg-stone-900 text-stone-400"
                                        : "border-red-700 bg-red-950/40 text-red-200"
                                  }`}
                                >
                                  {run.status === "failed" ? "n/a" : run.passed ? "Pass" : "Fail"}
                                </span>
                              </td>
                              <td
                                class={`px-3 py-3 font-mono text-xs ${
                                  (run.total_pnl ?? 0) >= 0 ? "text-green-300" : "text-red-300"
                                }`}
                              >
                                {formatCurrency(run.total_pnl)}
                              </td>
                              <td class="px-3 py-3 font-mono text-xs">
                                {formatPercent(run.max_drawdown, 2)}
                              </td>
                              <td class="px-3 py-3 font-mono text-xs">
                                {formatProfitFactor(run.profit_factor)}
                              </td>
                              <td class="px-3 py-3 text-xs">
                                <Show
                                  when={run.status === "completed" && run.backtest_id}
                                  fallback={<span class="text-stone-500">Unavailable</span>}
                                >
                                  <div class="space-y-2">
                                    <Show
                                      when={run.candidate_id && run.is_candidate}
                                      fallback={
                                        <button
                                          type="button"
                                          disabled={candidateBusyId() === run.experiment_run_id}
                                          onClick={() => handleCandidatePromote(run.experiment_run_id)}
                                          class={`rounded-xl px-3 py-2 font-medium transition-colors ${
                                            candidateBusyId() === run.experiment_run_id
                                              ? "cursor-not-allowed bg-stone-800 text-stone-500"
                                              : "border border-stone-700 text-stone-200 hover:border-stone-500 hover:bg-stone-900"
                                          }`}
                                        >
                                          {candidateBusyId() === run.experiment_run_id
                                            ? "Promoting..."
                                            : run.candidate_id
                                              ? "Promote Again"
                                              : "Promote"}
                                        </button>
                                      }
                                    >
                                      {(candidateId) => (
                                        <A
                                          href={`/candidates/${candidateId()}`}
                                          class="inline-flex rounded-xl border border-green-700 bg-green-950/40 px-3 py-2 font-medium text-green-200 transition-colors hover:bg-green-950/60"
                                        >
                                          Open Candidate
                                        </A>
                                      )}
                                    </Show>
                                    <Show when={run.candidate_id && !run.is_candidate}>
                                      {(candidateId) => (
                                        <A
                                          href={`/candidates/${candidateId()}`}
                                          class="inline-flex text-[11px] text-stone-500 transition-colors hover:text-stone-300"
                                        >
                                          View history
                                        </A>
                                      )}
                                    </Show>
                                  </div>
                                </Show>
                                <Show when={run.is_candidate && run.promoted_at}>
                                  {(promotedAt) => (
                                    <p class="mt-2 text-[11px] text-stone-500">
                                      {formatTimestamp(promotedAt())}
                                    </p>
                                  )}
                                </Show>
                              </td>
                              <td class="rounded-r-2xl px-3 py-3 text-xs">
                                <Show
                                  when={run.backtest_id}
                                  fallback={<span class="text-stone-500">No saved result</span>}
                                >
                                  {(backtestId) => (
                                    <A
                                      href={`/backtests/${backtestId()}`}
                                      class="rounded-xl border border-stone-700 px-3 py-2 font-medium text-stone-100 transition-colors hover:border-stone-500 hover:bg-stone-900"
                                    >
                                      Open
                                    </A>
                                  )}
                                </Show>
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
        )}
      </Show>
    </AppShell>
  );
}
