import { A, useNavigate, useParams } from "@solidjs/router";
import { batch, createResource, createSignal, For, Show } from "solid-js";
import AppShell from "../../components/AppShell";
import {
  addCandidateNote,
  createCandidatePaperSession,
  createCandidatePaperBot,
  fetchCandidate,
  updateCandidatePaperBotStatus,
  updateCandidateStatus,
  type CandidateLifecycleStatus,
  type CandidateResult,
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

function metricCard(label: string, value: string, note: string, tone = "border-stone-800 bg-stone-950/60") {
  return (
    <div class={`rounded-md border px-4 py-3 ${tone}`}>
      <p class="app-kicker">{label}</p>
      <p class="mt-2 text-sm font-semibold text-stone-100">{value}</p>
      <p class="mt-1 text-xs text-stone-500">{note}</p>
    </div>
  );
}

export default function CandidateDetailPage() {
  const params = useParams();
  const navigate = useNavigate();
  const candidateId = () => params.id ?? "";
  const [candidate, { mutate, refetch }] = createResource(candidateId, fetchCandidate);
  const [error, setError] = createSignal<string | null>(null);
  const [busyAction, setBusyAction] = createSignal<string | null>(null);
  const [noteDraft, setNoteDraft] = createSignal("");

  const applyCandidate = (nextCandidate: CandidateResult) => {
    mutate(() => nextCandidate);
  };

  const runAction = async (key: string, work: () => Promise<CandidateResult>) => {
    batch(() => {
      setBusyAction(key);
      setError(null);
    });

    try {
      const nextCandidate = await work();
      applyCandidate(nextCandidate);
      await refetch();
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : "Candidate action failed.");
    } finally {
      setBusyAction(null);
    }
  };

  const handleApprove = () =>
    runAction("approve", () => updateCandidateStatus(candidateId(), "approved"));

  const handleReject = () =>
    runAction("reject", () => updateCandidateStatus(candidateId(), "rejected"));

  const handleCreatePaperBot = () =>
    runAction("paper-create", () => createCandidatePaperBot(candidateId()));

  const handlePaperReady = () =>
    runAction("paper-ready", () => updateCandidatePaperBotStatus(candidateId(), "ready"));

  const handlePaperRun = () =>
    runAction("paper-run", () => updateCandidatePaperBotStatus(candidateId(), "paper_running"));

  const handlePaperStop = () =>
    runAction("paper-stop", () => updateCandidatePaperBotStatus(candidateId(), "stopped"));

  const handleCreatePaperSession = async () => {
    batch(() => {
      setBusyAction("session-create");
      setError(null);
    });

    try {
      const session = await createCandidatePaperSession(candidateId());
      await refetch();
      navigate(`/paper-sessions/${session.paper_session_id}`);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : "Paper session create failed.");
    } finally {
      setBusyAction(null);
    }
  };

  const handleNoteSave = async () => {
    const body = noteDraft().trim();
    if (!body) {
      setError("Write a real review note first.");
      return;
    }

    await runAction("note", () => addCandidateNote(candidateId(), body));
    setNoteDraft("");
  };

  return (
    <AppShell
      title={
        candidate()
          ? `${candidate()!.symbol} ${candidate()!.interval} candidate`
          : "Candidate"
      }
      subtitle={
        candidate()
          ? candidate()!.promotion_reason
          : "Candidate detail."
      }
      actions={
        <>
          <A
            href="/candidates"
            class="rounded-sm border border-stone-700 px-4 py-2 text-sm font-medium text-stone-200 transition-colors hover:border-stone-500 hover:bg-stone-900"
          >
            Back to Candidates
          </A>
          <A
            href="/paper-sessions"
            class="rounded-sm border border-stone-700 px-4 py-2 text-sm font-medium text-stone-200 transition-colors hover:border-stone-500 hover:bg-stone-900"
          >
            Paper Sessions
          </A>
          <Show when={candidate()}>
            {(entry) => (
              <>
                <A
                  href={`/experiments/${entry().experiment_id}`}
                  class="rounded-sm border border-stone-700 px-4 py-2 text-sm font-medium text-stone-200 transition-colors hover:border-stone-500 hover:bg-stone-900"
                >
                  Source Experiment
                </A>
                <A
                  href={`/backtests/${entry().backtest_id}`}
                  class="rounded-sm border border-stone-700 px-4 py-2 text-sm font-medium text-stone-200 transition-colors hover:border-stone-500 hover:bg-stone-900"
                >
                  Source Backtest
                </A>
              </>
            )}
          </Show>
        </>
      }
    >
      <Show
        when={candidate()}
        fallback={
          <section class="app-panel app-panel-section flex min-h-60 items-center justify-center">
            <p class="text-stone-400">Loading candidate...</p>
          </section>
        }
      >
        {(entry) => (
          <div class="space-y-6">
            <Show when={error()}>
              <div class="rounded-md border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-200">
                {error()}
              </div>
            </Show>

            <section class="app-panel app-panel-section space-y-5">
              <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div class="space-y-3">
                  <div class="flex flex-wrap items-center gap-2">
                    <p class="app-kicker">Lifecycle</p>
                    <span
                      class={`rounded-sm border px-2.5 py-1 text-xs font-medium uppercase tracking-[0.18em] ${statusTone(
                        entry().lifecycle_status,
                      )}`}
                    >
                      {describeStatus(entry().lifecycle_status)}
                    </span>
                  </div>
                  <p class="max-w-3xl text-sm text-stone-400">{entry().promotion_reason}</p>
                  <div class="flex flex-wrap gap-2">
                    <Show when={entry().lifecycle_status === "candidate"}>
                      <button
                        type="button"
                        disabled={busyAction() === "approve"}
                        onClick={handleApprove}
                        class="rounded-sm bg-stone-100 px-4 py-2 text-sm font-semibold text-stone-950 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-stone-800 disabled:text-stone-500"
                      >
                        {busyAction() === "approve" ? "Approving..." : "Approve"}
                      </button>
                    </Show>
                    <Show when={entry().lifecycle_status !== "rejected"}>
                      <button
                        type="button"
                        disabled={busyAction() === "reject"}
                        onClick={handleReject}
                        class="rounded-sm border border-red-700 bg-red-950/40 px-4 py-2 text-sm font-medium text-red-200 transition-colors hover:bg-red-950/60 disabled:cursor-not-allowed disabled:border-stone-800 disabled:bg-stone-900 disabled:text-stone-500"
                      >
                        {busyAction() === "reject" ? "Rejecting..." : "Reject"}
                      </button>
                    </Show>
                  </div>
                </div>

                <div class="rounded-md border border-stone-800 bg-stone-950/60 px-4 py-4 text-sm text-stone-300">
                  <p>Promoted by {entry().promoted_by}</p>
                  <p class="mt-1 text-stone-500">{formatTimestamp(entry().promoted_at)}</p>
                  <Show when={entry().approved_at}>
                    <p class="mt-3">
                      Approved by {entry().approved_by ?? "local-user"} on{" "}
                      {formatTimestamp(entry().approved_at)}
                    </p>
                  </Show>
                </div>
              </div>

              <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                {metricCard(
                  "PnL",
                  formatCurrency(entry().total_pnl),
                  `Win rate ${formatPercent(entry().win_rate)}`,
                  (entry().total_pnl ?? 0) >= 0
                    ? "border-green-800 bg-green-950/30"
                    : "border-red-800 bg-red-950/30",
                )}
                {metricCard(
                  "Drawdown",
                  formatPercent(entry().max_drawdown, 2),
                  "Lower is better when this leaves research mode.",
                )}
                {metricCard(
                  "Profit Factor",
                  formatProfitFactor(entry().profit_factor),
                  `Score ${formatNumber(entry().score, 2)}`,
                )}
                {metricCard(
                  "Prop Result",
                  entry().passed ? "Pass" : "Fail",
                  `Rank ${entry().rank ?? "n/a"} in the source run set`,
                  entry().passed
                    ? "border-green-800 bg-green-950/30"
                    : "border-red-800 bg-red-950/30",
                )}
                {metricCard(
                  "Paper Bot",
                  entry().paper_bot?.status.replace(/_/g, " ") ?? "Not created",
                  entry().paper_bot
                    ? `Updated ${formatTimestamp(entry().paper_bot?.updated_at)}`
                    : "Create a draft when the review is headed somewhere real.",
                )}
              </div>
            </section>

            <section class="grid gap-6 xl:grid-cols-[1.25fr_0.95fr]">
              <div class="space-y-6">
                <section class="app-panel app-panel-section space-y-4">
                  <div class="space-y-2">
                    <p class="app-kicker">Provenance</p>
                  </div>
                  <div class="grid gap-4 md:grid-cols-2">
                    <div class="app-subpanel px-4 py-4 text-sm text-stone-300">
                      <p class="font-medium text-stone-100">{entry().experiment_name}</p>
                      <p class="mt-2">Run id: {entry().experiment_run_id}</p>
                      <p class="mt-1">Scoring: {entry().experiment_snapshot.scoring_rule ?? "n/a"}</p>
                      <p class="mt-1">
                        Range: {entry().experiment_snapshot.start_date ?? "start open"} to{" "}
                        {entry().experiment_snapshot.end_date ?? "end open"}
                      </p>
                    </div>
                    <div class="app-subpanel px-4 py-4 text-sm text-stone-300">
                      <p class="font-medium text-stone-100">Strategy snapshot</p>
                      <p class="mt-2">{entry().strategy_type.replace(/_/g, " ")}</p>
                      <p class="mt-1 text-xs text-stone-500">{formatParams(entry().strategy_params)}</p>
                      <p class="mt-3">Prop preset: {entry().prop_firm_rules.name}</p>
                    </div>
                  </div>
                </section>

                <section class="app-panel app-panel-section space-y-4">
                  <div class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                    <div class="space-y-2">
                      <p class="app-kicker">Review Notes</p>
                    </div>
                  </div>
                  <div class="space-y-3">
                    <textarea
                      value={noteDraft()}
                      onInput={(event) => setNoteDraft(event.currentTarget.value)}
                      rows={4}
                      placeholder="Add a real review note..."
                      class="w-full rounded-sm border border-stone-700 bg-stone-950 px-4 py-3 text-sm text-stone-100 outline-none transition-colors focus:border-stone-500"
                    />
                    <button
                      type="button"
                      disabled={busyAction() === "note"}
                      onClick={handleNoteSave}
                      class="rounded-sm border border-stone-700 px-4 py-2 text-sm font-medium text-stone-100 transition-colors hover:border-stone-500 hover:bg-stone-900 disabled:cursor-not-allowed disabled:border-stone-800 disabled:bg-stone-900 disabled:text-stone-500"
                    >
                      {busyAction() === "note" ? "Saving note..." : "Save Note"}
                    </button>
                  </div>

                  <div class="space-y-3">
                    <Show
                      when={entry().notes.length > 0}
                      fallback={
                        <div class="rounded-md border border-stone-800 bg-stone-950/60 px-4 py-6 text-sm text-stone-500">
                          No notes yet.
                        </div>
                      }
                    >
                      <For each={[...entry().notes].reverse()}>
                        {(note) => (
                          <article class="rounded-md border border-stone-800 bg-stone-950/60 px-4 py-4">
                            <p class="text-sm text-stone-200">{note.body}</p>
                            <p class="mt-3 text-xs text-stone-500">
                              {note.author} · {formatTimestamp(note.created_at)}
                            </p>
                          </article>
                        )}
                      </For>
                    </Show>
                  </div>
                </section>
              </div>

              <div class="space-y-6">
                <section class="app-panel app-panel-section space-y-4">
                  <div class="space-y-2">
                    <p class="app-kicker">Paper Handoff Stub</p>
                    <p class="text-sm text-stone-400">
                      Durable config seam for paper trading.
                    </p>
                  </div>
                  <Show
                    when={entry().paper_bot}
                    fallback={
                      <div class="space-y-3">
                        <div class="rounded-md border border-stone-800 bg-stone-950/60 px-4 py-6 text-sm text-stone-500">
                          No paper bot draft yet.
                        </div>
                        <button
                          type="button"
                          disabled={busyAction() === "paper-create" || entry().lifecycle_status === "rejected"}
                          onClick={handleCreatePaperBot}
                          class="rounded-sm bg-stone-100 px-4 py-2 text-sm font-semibold text-stone-950 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-stone-800 disabled:text-stone-500"
                        >
                          {busyAction() === "paper-create"
                            ? "Creating draft..."
                            : "Create Paper Bot Draft"}
                        </button>
                      </div>
                    }
                  >
                    {(paperBot) => (
                      <div class="space-y-4">
                        <div class="rounded-md border border-stone-800 bg-stone-950/60 px-4 py-4 text-sm text-stone-300">
                          <p class="font-medium text-stone-100">
                            {paperBot().symbol} {paperBot().interval} · {paperBot().strategy_type.replace(/_/g, " ")}
                          </p>
                          <p class="mt-2 text-xs text-stone-500">
                            {formatParams(paperBot().strategy_params)}
                          </p>
                          <p class="mt-3">
                            Status:{" "}
                            <span class="rounded-sm border border-green-700 bg-green-950/30 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-green-200">
                              {paperBot().status.replace(/_/g, " ")}
                            </span>
                          </p>
                        </div>

                        <div class="rounded-md border border-stone-800 bg-stone-950/60 px-4 py-4 text-sm text-stone-300">
                          <p class="font-medium text-stone-100">Guardrails snapshot</p>
                          <p class="mt-2">Prop preset: {entry().prop_firm_rules.name}</p>
                          <p class="mt-1">
                            Required prop pass: {String(Boolean(paperBot().guardrails.required_prop_pass))}
                          </p>
                          <p class="mt-1">
                            Drawdown seen: {formatPercent(entry().max_drawdown, 2)}
                          </p>
                          <Show when={paperBot().paper_session_id}>
                            <p class="mt-3">
                              Session linked:{" "}
                              <code>{paperBot().paper_session_id?.slice(0, 8)}</code>
                            </p>
                            <p class="mt-1 text-stone-500">
                              Last event {formatTimestamp(paperBot().last_event_at)}
                            </p>
                          </Show>
                        </div>

                        <div class="flex flex-wrap gap-2">
                          <Show when={paperBot().status === "draft" || paperBot().status === "stopped"}>
                            <button
                              type="button"
                              disabled={busyAction() === "paper-ready"}
                              onClick={handlePaperReady}
                              class="rounded-sm border border-stone-700 px-4 py-2 text-sm font-medium text-stone-100 transition-colors hover:border-stone-500 hover:bg-stone-900 disabled:cursor-not-allowed disabled:border-stone-800 disabled:bg-stone-900 disabled:text-stone-500"
                            >
                              {busyAction() === "paper-ready" ? "Updating..." : "Mark Ready"}
                            </button>
                          </Show>
                          <Show when={paperBot().status === "ready" || paperBot().status === "stopped"}>
                            <button
                              type="button"
                              disabled={busyAction() === "paper-run"}
                              onClick={handlePaperRun}
                              class="rounded-sm bg-stone-100 px-4 py-2 text-sm font-semibold text-stone-950 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-stone-800 disabled:text-stone-500"
                            >
                              {busyAction() === "paper-run" ? "Starting..." : "Start Paper Bot"}
                            </button>
                          </Show>
                          <Show when={paperBot().status === "ready" || paperBot().status === "paper_running"}>
                            <button
                              type="button"
                              disabled={busyAction() === "paper-stop"}
                              onClick={handlePaperStop}
                              class="rounded-sm border border-red-700 bg-red-950/40 px-4 py-2 text-sm font-medium text-red-200 transition-colors hover:bg-red-950/60 disabled:cursor-not-allowed disabled:border-stone-800 disabled:bg-stone-900 disabled:text-stone-500"
                            >
                              {busyAction() === "paper-stop" ? "Stopping..." : "Stop / Pause"}
                            </button>
                          </Show>
                          <Show
                            when={paperBot().paper_session_id}
                            fallback={
                              <button
                                type="button"
                                disabled={busyAction() === "session-create"}
                                onClick={handleCreatePaperSession}
                                class="rounded-sm border border-stone-700 px-4 py-2 text-sm font-medium text-stone-100 transition-colors hover:border-stone-500 hover:bg-stone-900 disabled:cursor-not-allowed disabled:border-stone-800 disabled:bg-stone-900 disabled:text-stone-500"
                              >
                                {busyAction() === "session-create"
                                  ? "Creating session..."
                                  : "Create Paper Session"}
                              </button>
                            }
                          >
                            {(paperSessionId) => (
                              <A
                                href={`/paper-sessions/${paperSessionId()}`}
                                class="rounded-sm border border-stone-700 px-4 py-2 text-sm font-medium text-stone-100 transition-colors hover:border-stone-500 hover:bg-stone-900"
                              >
                                Open Paper Session
                              </A>
                            )}
                          </Show>
                        </div>
                      </div>
                    )}
                  </Show>
                </section>

                <section class="app-panel app-panel-section space-y-4">
                  <div class="space-y-2">
                    <p class="app-kicker">Audit Trail</p>
                  </div>
                  <div class="space-y-3">
                    <For each={[...entry().audit_log].reverse()}>
                      {(event) => (
                        <article class="rounded-md border border-stone-800 bg-stone-950/60 px-4 py-4">
                          <div class="flex flex-wrap items-center gap-2">
                            <span class="rounded-sm border border-stone-700 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-stone-300">
                              {event.event_type.replace(/_/g, " ")}
                            </span>
                            <span class="text-xs text-stone-500">{event.actor}</span>
                          </div>
                          <p class="mt-3 text-sm text-stone-200">{event.summary}</p>
                          <p class="mt-2 text-xs text-stone-500">{formatTimestamp(event.created_at)}</p>
                        </article>
                      )}
                    </For>
                  </div>
                </section>
              </div>
            </section>
          </div>
        )}
      </Show>
    </AppShell>
  );
}
