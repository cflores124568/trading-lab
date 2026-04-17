import { A, useParams } from "@solidjs/router";
import { batch, createMemo, createResource, createSignal, For, Show } from "solid-js";
import AppShell from "../../components/AppShell";
import {
  createPaperSessionEvent,
  executePaperSessionAction,
  fetchCandidate,
  fetchPaperSession,
  fetchPaperSessionEvents,
  updatePaperSessionStatus,
} from "../../services/api";
import type { PaperSessionStatus, PaperSessionTradeAction, Trade } from "../../services/api";

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

function formatTimestamp(value?: string | null): string {
  if (!value) {
    return "n/a";
  }

  return new Date(value).toLocaleString();
}

function formatCurrency(value?: number | null, signed = false): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "n/a";
  }

  const abs = Math.abs(value).toFixed(2);
  if (signed) {
    return `${value >= 0 ? "+" : "-"}$${abs}`;
  }

  return `${value < 0 ? "-" : ""}$${abs}`;
}

function formatNumber(value?: number | null, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "n/a";
  }

  return value.toFixed(digits);
}

function formatPercent(value?: number | null, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "n/a";
  }

  return `${(value * 100).toFixed(digits)}%`;
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function nowLocalInputValue(): string {
  const now = new Date();
  const adjusted = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return adjusted.toISOString().slice(0, 16);
}

function localInputToIso(value: string): string {
  if (!value.trim()) {
    return new Date().toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toISOString();
}

function positionLabel(side?: string | null): string {
  if (side === "buy") {
    return "Long";
  }
  if (side === "sell") {
    return "Short";
  }
  return "Flat";
}

function formatParams(params: Record<string, unknown>): string {
  const entries = Object.entries(params);
  if (entries.length === 0) {
    return "Default params";
  }

  return entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

function formatJson(value: Record<string, unknown>): string {
  if (Object.keys(value).length === 0) {
    return "{}";
  }

  return JSON.stringify(value, null, 2);
}

function statusActions(status: PaperSessionStatus): Array<{
  label: string;
  status: PaperSessionStatus;
  tone: string;
}> {
  switch (status) {
    case "draft":
      return [
        {
          label: "Mark Ready",
          status: "ready",
          tone:
            "border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 hover:border-zinc-500 hover:bg-zinc-900",
        },
        {
          label: "Stop",
          status: "stopped",
          tone:
            "border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 hover:border-zinc-500 hover:bg-zinc-900",
        },
        {
          label: "Mark Failed",
          status: "failed",
          tone:
            "border border-red-700 bg-red-950/40 px-4 py-2 text-sm font-medium text-red-200 hover:bg-red-950/60",
        },
      ];
    case "ready":
      return [
        {
          label: "Start Running",
          status: "running",
          tone: "bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-white",
        },
        {
          label: "Pause",
          status: "paused",
          tone:
            "border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 hover:border-zinc-500 hover:bg-zinc-900",
        },
        {
          label: "Stop",
          status: "stopped",
          tone:
            "border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 hover:border-zinc-500 hover:bg-zinc-900",
        },
        {
          label: "Mark Failed",
          status: "failed",
          tone:
            "border border-red-700 bg-red-950/40 px-4 py-2 text-sm font-medium text-red-200 hover:bg-red-950/60",
        },
      ];
    case "running":
      return [
        {
          label: "Pause",
          status: "paused",
          tone:
            "border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 hover:border-zinc-500 hover:bg-zinc-900",
        },
        {
          label: "Stop",
          status: "stopped",
          tone:
            "border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 hover:border-zinc-500 hover:bg-zinc-900",
        },
        {
          label: "Mark Failed",
          status: "failed",
          tone:
            "border border-red-700 bg-red-950/40 px-4 py-2 text-sm font-medium text-red-200 hover:bg-red-950/60",
        },
      ];
    case "paused":
      return [
        {
          label: "Move to Ready",
          status: "ready",
          tone:
            "border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 hover:border-zinc-500 hover:bg-zinc-900",
        },
        {
          label: "Resume",
          status: "running",
          tone: "bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-white",
        },
        {
          label: "Stop",
          status: "stopped",
          tone:
            "border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 hover:border-zinc-500 hover:bg-zinc-900",
        },
        {
          label: "Mark Failed",
          status: "failed",
          tone:
            "border border-red-700 bg-red-950/40 px-4 py-2 text-sm font-medium text-red-200 hover:bg-red-950/60",
        },
      ];
    case "stopped":
      return [
        {
          label: "Reopen Ready",
          status: "ready",
          tone:
            "border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 hover:border-zinc-500 hover:bg-zinc-900",
        },
        {
          label: "Resume",
          status: "running",
          tone: "bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-white",
        },
      ];
    case "failed":
      return [
        {
          label: "Recover to Ready",
          status: "ready",
          tone:
            "border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 hover:border-zinc-500 hover:bg-zinc-900",
        },
        {
          label: "Stop",
          status: "stopped",
          tone:
            "border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 hover:border-zinc-500 hover:bg-zinc-900",
        },
      ];
    default:
      return [];
  }
}

export default function PaperSessionDetailPage() {
  const params = useParams();
  const paperSessionId = () => params.id ?? "";
  const [session, { mutate: mutateSession, refetch: refetchSession }] = createResource(
    paperSessionId,
    fetchPaperSession,
  );
  const [events, { refetch: refetchEvents }] = createResource(
    paperSessionId,
    fetchPaperSessionEvents,
  );
  const [candidate] = createResource(
    () => session()?.candidate_id ?? undefined,
    async (candidateId) => (candidateId ? fetchCandidate(candidateId) : null),
  );
  const [busyAction, setBusyAction] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [eventType, setEventType] = createSignal("operator_note");
  const [eventSummary, setEventSummary] = createSignal("");
  const [executionAction, setExecutionAction] = createSignal<PaperSessionTradeAction>("buy");
  const [executionPrice, setExecutionPrice] = createSignal("");
  const [executionTime, setExecutionTime] = createSignal(nowLocalInputValue());
  const [executionNote, setExecutionNote] = createSignal("");

  const availableActions = createMemo(() =>
    session() ? statusActions(session()!.status) : [],
  );
  const currentPosition = createMemo(() => (session()?.current_position ?? {}) as Record<string, unknown>);
  const hasOpenPosition = createMemo(() => Boolean(stringFromUnknown(currentPosition().entry_time)));
  const metricsSnapshot = createMemo(
    () => (session()?.metrics_snapshot ?? {}) as Record<string, unknown>,
  );
  const guardrailState = createMemo(
    () => (session()?.guardrail_state ?? {}) as Record<string, unknown>,
  );
  const tradeLog = createMemo(() => session()?.trade_log ?? []);

  const runSessionAction = async (key: string, work: () => Promise<void>) => {
    batch(() => {
      setBusyAction(key);
      setError(null);
    });

    try {
      await work();
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : "Paper session action failed.");
    } finally {
      setBusyAction(null);
    }
  };

  const handleStatusChange = (nextStatus: PaperSessionStatus) =>
    runSessionAction(`status-${nextStatus}`, async () => {
      const nextSession = await updatePaperSessionStatus(paperSessionId(), nextStatus);
      mutateSession(() => nextSession);
      await Promise.all([refetchSession(), refetchEvents()]);
    });

  const handleEventSave = async () => {
    const summary = eventSummary().trim();
    if (!summary) {
      setError("Write a real paper session note first.");
      return;
    }

    await runSessionAction("event-save", async () => {
      await createPaperSessionEvent(paperSessionId(), {
        eventType: eventType().trim(),
        summary,
      });
      setEventSummary("");
      await Promise.all([refetchSession(), refetchEvents()]);
    });
  };

  const handleExecution = async () => {
    const price = Number(executionPrice().trim());
    if (!Number.isFinite(price) || price <= 0) {
      setError("Use a real fill price first.");
      return;
    }

    await runSessionAction("execute", async () => {
      const nextSession = await executePaperSessionAction(paperSessionId(), {
        action: executionAction(),
        price,
        filledAt: localInputToIso(executionTime()),
        note: executionNote().trim() || undefined,
      });
      mutateSession(() => nextSession);
      setExecutionNote("");
      setExecutionPrice("");
      setExecutionTime(nowLocalInputValue());
      if (executionAction() === "exit") {
        setExecutionAction("buy");
      } else if (executionAction() === "buy" || executionAction() === "sell") {
        setExecutionAction("mark");
      }
      await Promise.all([refetchSession(), refetchEvents()]);
    });
  };

  return (
    <AppShell
      title={session()?.name ?? "Paper Session"}
      subtitle={
        session()
          ? "Track the runtime shell, operator notes, and state changes without losing the candidate context that produced it."
          : "Loading paper session..."
      }
      actions={
        <>
          <A
            href="/paper-sessions"
            class="rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
          >
            All Paper Sessions
          </A>
          <Show when={session()}>
            {(entry) => (
              <A
                href={`/candidates/${entry().candidate_id}`}
                class="rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
              >
                Open Candidate
              </A>
            )}
          </Show>
          <Show when={candidate()}>
            {(entry) => (
              <A
                href={`/backtests/${entry()!.backtest_id}`}
                class="rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
              >
                Source Backtest
              </A>
            )}
          </Show>
        </>
      }
    >
      <Show
        when={session()}
        fallback={
          <section class="app-panel app-panel-section flex min-h-60 items-center justify-center">
            <p class="text-zinc-400">Loading paper session...</p>
          </section>
        }
      >
        {(entry) => (
          <div class="space-y-6">
            <Show when={error()}>
              <div class="rounded-2xl border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-200">
                {error()}
              </div>
            </Show>

            <section class="app-panel app-panel-section space-y-5">
              <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div class="space-y-3">
                  <div class="flex flex-wrap items-center gap-2">
                    <p class="app-kicker">Runtime Status</p>
                    <span
                      class={`rounded-full border px-2.5 py-1 text-xs font-medium uppercase tracking-[0.18em] ${statusTone(
                        entry().status,
                      )}`}
                    >
                      {describeStatus(entry().status)}
                    </span>
                  </div>
                  <p class="text-sm text-zinc-400">
                    {entry().symbol} {entry().interval} · {entry().strategy_type.replace(/_/g, " ")}
                  </p>
                  <p class="text-xs text-zinc-500">{formatParams(entry().strategy_params)}</p>
                </div>

                <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-4 text-sm text-zinc-300">
                  <p>Created by {entry().created_by}</p>
                  <p class="mt-1 text-zinc-500">{formatTimestamp(entry().created_at)}</p>
                  <p class="mt-3">Last event: {formatTimestamp(entry().last_event_at)}</p>
                  <p class="mt-1 text-zinc-500">Last bar: {formatTimestamp(entry().last_bar_time)}</p>
                </div>
              </div>

              <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                  <p class="app-kicker">Marked Equity</p>
                  <p class="mt-2 text-sm font-semibold text-zinc-100">
                    {formatCurrency(numberFromUnknown(metricsSnapshot().marked_equity))}
                  </p>
                  <p class="mt-1 text-xs text-zinc-500">
                    Realized equity plus whatever the open position is doing right now.
                  </p>
                </div>
                <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                  <p class="app-kicker">Total PnL</p>
                  <p class="mt-2 text-sm font-semibold text-zinc-100">
                    {formatCurrency(numberFromUnknown(metricsSnapshot().total_pnl), true)}
                  </p>
                  <p class="mt-1 text-xs text-zinc-500">
                    Closed-trade performance so far in this paper session.
                  </p>
                </div>
                <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                  <p class="app-kicker">Closed Trades</p>
                  <p class="mt-2 text-sm font-semibold text-zinc-100">
                    {tradeLog().length}
                  </p>
                  <p class="mt-1 text-xs text-zinc-500">
                    Win rate {formatPercent(numberFromUnknown(metricsSnapshot().win_rate), 1)}
                  </p>
                </div>
                <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                  <p class="app-kicker">Open Position</p>
                  <p class="mt-2 text-sm font-semibold text-zinc-100">
                    {positionLabel(stringFromUnknown(currentPosition().side))}
                  </p>
                  <p class="mt-1 text-xs text-zinc-500">
                    Unrealized {formatCurrency(numberFromUnknown(metricsSnapshot().unrealized_pnl), true)}
                  </p>
                </div>
              </div>

              <div class="flex flex-wrap gap-2">
                <For each={availableActions()}>
                  {(action) => (
                    <button
                      type="button"
                      disabled={busyAction() === `status-${action.status}`}
                      onClick={() => handleStatusChange(action.status)}
                      class={`rounded-xl transition-colors disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-500 ${action.tone}`}
                    >
                      {busyAction() === `status-${action.status}` ? "Updating..." : action.label}
                    </button>
                  )}
                </For>
              </div>
            </section>

            <section class="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
              <div class="space-y-6">
                <section class="app-panel app-panel-section space-y-4">
                  <div class="space-y-2">
                    <p class="app-kicker">Paper Execution</p>
                    <p class="text-sm text-zinc-400">
                      This is the first real paper loop: open a position, mark it as price moves, and flatten it into the session trade log.
                    </p>
                  </div>

                  <div class="grid gap-3 md:grid-cols-2">
                    <div class="app-subpanel px-4 py-4">
                      <p class="text-sm font-medium text-zinc-100">Session setup</p>
                      <p class="mt-3 text-sm text-zinc-300">
                        Prop preset: {entry().prop_firm_rules.name}
                      </p>
                      <p class="mt-1 text-sm text-zinc-300">
                        Commission: {formatCurrency(entry().commission)}
                      </p>
                      <p class="mt-1 text-sm text-zinc-300">
                        Tick value: {formatCurrency(entry().tick_value)}
                      </p>
                    </div>
                    <div class="app-subpanel px-4 py-4">
                      <p class="text-sm font-medium text-zinc-100">Current position</p>
                      <p class="mt-3 text-sm text-zinc-300">
                        {positionLabel(stringFromUnknown(currentPosition().side))}
                      </p>
                      <p class="mt-1 text-sm text-zinc-300">
                        Entry: {formatTimestamp(stringFromUnknown(currentPosition().entry_time))}
                      </p>
                      <p class="mt-1 text-sm text-zinc-300">
                        Mark: {formatNumber(numberFromUnknown(currentPosition().mark_price), 4)}
                      </p>
                      <p class="mt-1 text-sm text-zinc-300">
                        Unrealized: {formatCurrency(numberFromUnknown(currentPosition().unrealized_pnl), true)}
                      </p>
                    </div>
                  </div>

                  <div class="grid gap-3 md:grid-cols-[180px_160px_1fr]">
                    <select
                      value={executionAction()}
                      onChange={(event) => setExecutionAction(event.currentTarget.value as PaperSessionTradeAction)}
                      class="w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-500"
                    >
                      <option value="buy">Buy / Long</option>
                      <option value="sell">Sell / Short</option>
                      <option value="mark">Mark Position</option>
                      <option value="exit">Exit Position</option>
                    </select>
                    <input
                      value={executionPrice()}
                      onInput={(event) => setExecutionPrice(event.currentTarget.value)}
                      placeholder="Fill price"
                      inputmode="decimal"
                      class="w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-500"
                    />
                    <input
                      type="datetime-local"
                      value={executionTime()}
                      onInput={(event) => setExecutionTime(event.currentTarget.value)}
                      class="w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-500"
                    />
                  </div>

                  <textarea
                    value={executionNote()}
                    onInput={(event) => setExecutionNote(event.currentTarget.value)}
                    rows={2}
                    placeholder="Optional execution note..."
                    class="w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-500"
                  />

                  <div class="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={busyAction() === "execute"}
                      onClick={handleExecution}
                      class="rounded-xl bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
                    >
                      {busyAction() === "execute" ? "Submitting..." : "Submit Action"}
                    </button>
                    <Show when={hasOpenPosition()}>
                      <span class="rounded-full border border-zinc-700 px-3 py-2 text-xs text-zinc-400">
                        Position is open, so `mark` and `exit` are the useful next clicks.
                      </span>
                    </Show>
                  </div>
                </section>

                <section class="app-panel app-panel-section space-y-4">
                  <div class="space-y-2">
                    <p class="app-kicker">Manual Event Log</p>
                    <p class="text-sm text-zinc-400">
                      This is the lightweight operator journal for now. Add execution notes, handoff breadcrumbs, or whatever happened during the paper run.
                    </p>
                  </div>

                  <div class="grid gap-3 md:grid-cols-[200px_1fr]">
                    <input
                      value={eventType()}
                      onInput={(event) => setEventType(event.currentTarget.value)}
                      placeholder="operator_note"
                      class="w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-500"
                    />
                    <textarea
                      value={eventSummary()}
                      onInput={(event) => setEventSummary(event.currentTarget.value)}
                      rows={3}
                      placeholder="Add a real session note..."
                      class="w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-500"
                    />
                  </div>

                  <button
                    type="button"
                    disabled={busyAction() === "event-save"}
                    onClick={handleEventSave}
                    class="rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-500"
                  >
                    {busyAction() === "event-save" ? "Saving event..." : "Save Event"}
                  </button>

                  <div class="space-y-3">
                    <Show
                      when={(events() ?? []).length > 0}
                      fallback={
                        <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-6 text-sm text-zinc-500">
                          No events yet.
                        </div>
                      }
                    >
                      <For each={[...(events() ?? [])].reverse()}>
                        {(event) => (
                          <article class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-4">
                            <div class="flex flex-wrap items-center gap-2">
                              <span class="rounded-full border border-zinc-700 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-300">
                                {event.event_type.replace(/_/g, " ")}
                              </span>
                              <span class="text-xs text-zinc-500">{event.actor}</span>
                            </div>
                            <p class="mt-3 text-sm text-zinc-200">{event.summary}</p>
                            <Show when={Object.keys(event.payload ?? {}).length > 0}>
                              <pre class="mt-3 overflow-x-auto rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-xs text-zinc-400">
                                {formatJson(event.payload)}
                              </pre>
                            </Show>
                            <p class="mt-3 text-xs text-zinc-500">{formatTimestamp(event.created_at)}</p>
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
                    <p class="app-kicker">Runtime Snapshot</p>
                    <p class="text-sm text-zinc-400">
                      The session now keeps enough runtime state to actually behave like a paper workflow instead of just a handoff stub.
                    </p>
                  </div>
                  <div class="space-y-4">
                    <div class="grid gap-3 md:grid-cols-2">
                      <div class="app-subpanel px-4 py-4">
                        <p class="text-sm font-medium text-zinc-100">Prop state</p>
                        <p class="mt-3 text-sm text-zinc-300">
                          Passed: {String(Boolean(guardrailState().passed))}
                        </p>
                        <p class="mt-1 text-sm text-zinc-300">
                          Drawdown breached: {String(Boolean(guardrailState().drawdown_breached))}
                        </p>
                        <p class="mt-1 text-sm text-zinc-300">
                          Daily loss breached: {String(Boolean(guardrailState().daily_loss_breached))}
                        </p>
                        <p class="mt-1 text-sm text-zinc-300">
                          Profit target hit: {String(Boolean(guardrailState().profit_target_hit))}
                        </p>
                      </div>
                      <div class="app-subpanel px-4 py-4">
                        <p class="text-sm font-medium text-zinc-100">Performance</p>
                        <p class="mt-3 text-sm text-zinc-300">
                          Profit factor: {formatNumber(numberFromUnknown(metricsSnapshot().profit_factor))}
                        </p>
                        <p class="mt-1 text-sm text-zinc-300">
                          Max drawdown: {formatPercent(numberFromUnknown(metricsSnapshot().max_drawdown), 2)}
                        </p>
                        <p class="mt-1 text-sm text-zinc-300">
                          Best trade: {formatCurrency(numberFromUnknown(metricsSnapshot().best_trade), true)}
                        </p>
                        <p class="mt-1 text-sm text-zinc-300">
                          Worst trade: {formatCurrency(numberFromUnknown(metricsSnapshot().worst_trade), true)}
                        </p>
                      </div>
                    </div>

                    <div class="app-subpanel px-4 py-4">
                      <div class="flex items-center justify-between gap-3">
                        <p class="text-sm font-medium text-zinc-100">Closed trades</p>
                        <span class="text-xs text-zinc-500">{tradeLog().length} total</span>
                      </div>
                      <Show
                        when={tradeLog().length > 0}
                        fallback={<p class="mt-3 text-sm text-zinc-500">No closed paper trades yet.</p>}
                      >
                        <div class="mt-3 space-y-3">
                          <For each={[...tradeLog()].reverse().slice(0, 6)}>
                            {(trade: Trade) => (
                              <article class="rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3">
                                <div class="flex flex-wrap items-center justify-between gap-2">
                                  <span class="text-sm font-medium text-zinc-100">
                                    {positionLabel(trade.side)}
                                  </span>
                                  <span
                                    class={`text-sm font-semibold ${
                                      trade.pnl >= 0 ? "text-emerald-300" : "text-red-300"
                                    }`}
                                  >
                                    {formatCurrency(trade.pnl, true)}
                                  </span>
                                </div>
                                <p class="mt-2 text-xs text-zinc-500">
                                  {formatTimestamp(trade.entry_time)}
                                  {" -> "}
                                  {formatTimestamp(trade.exit_time)}
                                </p>
                                <p class="mt-1 text-xs text-zinc-500">
                                  {formatNumber(trade.entry_price, 4)}
                                  {" -> "}
                                  {formatNumber(trade.exit_price, 4)}
                                </p>
                              </article>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>

                    <div class="app-subpanel px-4 py-4">
                      <p class="text-sm font-medium text-zinc-100">Current position</p>
                      <pre class="mt-3 overflow-x-auto text-xs text-zinc-400">
                        {formatJson(entry().current_position)}
                      </pre>
                    </div>
                    <div class="app-subpanel px-4 py-4">
                      <p class="text-sm font-medium text-zinc-100">Trade log</p>
                      <pre class="mt-3 overflow-x-auto text-xs text-zinc-400">
                        {JSON.stringify(entry().trade_log, null, 2)}
                      </pre>
                    </div>
                    <div class="app-subpanel px-4 py-4">
                      <p class="text-sm font-medium text-zinc-100">Equity curve</p>
                      <pre class="mt-3 overflow-x-auto text-xs text-zinc-400">
                        {JSON.stringify(entry().equity_curve, null, 2)}
                      </pre>
                    </div>
                    <div class="app-subpanel px-4 py-4">
                      <p class="text-sm font-medium text-zinc-100">Metrics snapshot</p>
                      <pre class="mt-3 overflow-x-auto text-xs text-zinc-400">
                        {formatJson(entry().metrics_snapshot)}
                      </pre>
                    </div>
                    <div class="app-subpanel px-4 py-4">
                      <p class="text-sm font-medium text-zinc-100">Guardrail state</p>
                      <pre class="mt-3 overflow-x-auto text-xs text-zinc-400">
                        {formatJson(entry().guardrail_state)}
                      </pre>
                    </div>
                    <div class="app-subpanel px-4 py-4">
                      <p class="text-sm font-medium text-zinc-100">Guardrails snapshot</p>
                      <pre class="mt-3 overflow-x-auto text-xs text-zinc-400">
                        {formatJson(entry().guardrails)}
                      </pre>
                    </div>
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
