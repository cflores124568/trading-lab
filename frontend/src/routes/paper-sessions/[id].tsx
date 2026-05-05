import { A, useParams } from "@solidjs/router";
import { batch, createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js";
import AppShell from "../../components/AppShell";
import {
  createPaperSessionEvent,
  executePaperSessionAction,
  fetchCandidate,
  fetchPaperSession,
  fetchPaperSessionEvents,
  pausePaperSessionRunner,
  startPaperSessionRunner,
  stepPaperSessionRunner,
  updatePaperSessionStatus,
} from "../../services/api";
import type { PaperSessionStatus, PaperSessionTradeAction, Trade } from "../../services/api";
import { buildPaperExecutionAnalytics } from "../../services/executionAnalytics";

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

function formatTicks(value?: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "n/a";
  }

  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}t`;
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

function isoToLocalInputValue(value?: string | null): string {
  if (!value) {
    return "";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  const adjusted = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000);
  return adjusted.toISOString().slice(0, 16);
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

function quoteLabel(quote: Record<string, unknown>): string {
  const bid = numberFromUnknown(quote.bid);
  const ask = numberFromUnknown(quote.ask);
  if (bid === null || ask === null) {
    return "Run or step the session to build a synthetic book.";
  }
  return `Bid ${bid.toFixed(4)} / Ask ${ask.toFixed(4)}`;
}

function formatRestingFillMode(mode?: string | null): string {
  if (mode === "penetrate") {
    return "penetrate";
  }
  if (mode === "touch_plus_1_bar") {
    return "touch + 1 bar";
  }
  return "touch";
}

function orderLabel(order: Record<string, unknown>): string {
  const side = stringFromUnknown(order.side);
  const price = numberFromUnknown(order.price);
  if (!side || price === null) {
    return "No resting order.";
  }
  const armed = numberFromUnknown(order.first_touch_bar_index) !== null ? " [armed]" : "";
  const replaceCount = numberFromUnknown(order.replace_count);
  const replaceTag = replaceCount && replaceCount > 0 ? ` [replace ${replaceCount}]` : "";
  const role = stringFromUnknown(order.bracket_role);
  const intent =
    role === "target"
      ? "TARGET"
      : role === "stop"
        ? "STOP"
        : stringFromUnknown(order.intent) === "exit"
          ? "EXIT"
          : "ENTRY";
  return `${intent} ${side.toUpperCase()} @ ${price.toFixed(4)}${armed}${replaceTag}`;
}

function runnerModeTone(mode?: string | null): string {
  switch (mode) {
    case "running":
      return "border-amber-700 bg-amber-950/40 text-amber-200";
    case "paused":
      return "border-zinc-700 bg-zinc-900 text-zinc-200";
    case "completed":
      return "border-emerald-700 bg-emerald-950/40 text-emerald-200";
    case "failed":
      return "border-red-700 bg-red-950/40 text-red-200";
    default:
      return "border-violet-700 bg-violet-950/40 text-violet-200";
  }
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
  const [executionNote, setExecutionNote] = createSignal("");
  const [bracketStopPrice, setBracketStopPrice] = createSignal("");
  const [bracketTargetPrice, setBracketTargetPrice] = createSignal("");
  const [runnerStartDate, setRunnerStartDate] = createSignal("");
  const [runnerEndDate, setRunnerEndDate] = createSignal("");
  const [runnerPollInterval, setRunnerPollInterval] = createSignal("750");
  const [runnerStepCount, setRunnerStepCount] = createSignal("1");
  const [runnerResetCursor, setRunnerResetCursor] = createSignal(false);

  const availableActions = createMemo(() =>
    session() ? statusActions(session()!.status) : [],
  );
  const currentPosition = createMemo(() => (session()?.current_position ?? {}) as Record<string, unknown>);
  const activeOrder = createMemo(() => (session()?.active_order ?? {}) as Record<string, unknown>);
  const activeOrders = createMemo(
    () =>
      ((session()?.active_orders?.length
        ? session()?.active_orders
        : stringFromUnknown(activeOrder().id)
          ? [activeOrder()]
          : []) ?? []) as Record<string, unknown>[],
  );
  const lastQuote = createMemo(() => (session()?.last_quote ?? {}) as Record<string, unknown>);
  const hasOpenPosition = createMemo(() => Boolean(stringFromUnknown(currentPosition().entry_time)));
  const hasActiveOrder = createMemo(() => activeOrders().length > 0);
  const hasSingleActiveOrder = createMemo(() => activeOrders().length === 1);
  const metricsSnapshot = createMemo(
    () => (session()?.metrics_snapshot ?? {}) as Record<string, unknown>,
  );
  const guardrailState = createMemo(
    () => (session()?.guardrail_state ?? {}) as Record<string, unknown>,
  );
  const runnerState = createMemo(
    () => (session()?.runner_state ?? {}) as Record<string, unknown>,
  );
  const tradeLog = createMemo(() => session()?.trade_log ?? []);
  const executionAnalytics = createMemo(() => {
    const liveSession = session();
    if (!liveSession) {
      return null;
    }

    return buildPaperExecutionAnalytics({
      trades: liveSession.trade_log ?? [],
      events: events() ?? [],
      tickSize: liveSession.tick_size ?? 0.25,
    });
  });

  createEffect(() => {
    const state = runnerState();
    setRunnerStartDate(isoToLocalInputValue(stringFromUnknown(state.start_date)));
    setRunnerEndDate(isoToLocalInputValue(stringFromUnknown(state.end_date)));
    const poll = numberFromUnknown(state.poll_interval_ms);
    if (poll && poll > 0) {
      setRunnerPollInterval(String(Math.round(poll)));
    }
  });

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

  const handleExecution = async (
    action: PaperSessionTradeAction,
    extra: { stopPrice?: number; targetPrice?: number } = {},
  ) => {
    await runSessionAction("execute", async () => {
      const nextSession = await executePaperSessionAction(paperSessionId(), {
        action,
        stopPrice: extra.stopPrice,
        targetPrice: extra.targetPrice,
        note: executionNote().trim() || undefined,
      });
      mutateSession(() => nextSession);
      setExecutionNote("");
      if (action === "attach_bracket") {
        setBracketStopPrice("");
        setBracketTargetPrice("");
      }
      await Promise.all([refetchSession(), refetchEvents()]);
    });
  };

  const handleAttachBracket = async () => {
    const stopPrice = Number(bracketStopPrice().trim());
    const targetPrice = Number(bracketTargetPrice().trim());
    if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
      setError("Bracket stop needs a real price.");
      return;
    }
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
      setError("Bracket target needs a real price.");
      return;
    }

    await handleExecution("attach_bracket", {
      stopPrice: Number(stopPrice.toFixed(4)),
      targetPrice: Number(targetPrice.toFixed(4)),
    });
  };

  const handleRunnerStart = async () => {
    const pollMs = Number(runnerPollInterval().trim());
    if (!Number.isFinite(pollMs) || pollMs < 100 || pollMs > 60_000) {
      setError("Runner poll interval must be between 100 and 60000 ms.");
      return;
    }

    await runSessionAction("runner-start", async () => {
      const nextSession = await startPaperSessionRunner(paperSessionId(), {
        startDate: runnerStartDate().trim() ? localInputToIso(runnerStartDate()) : undefined,
        endDate: runnerEndDate().trim() ? localInputToIso(runnerEndDate()) : undefined,
        pollIntervalMs: Math.round(pollMs),
        resetCursor: runnerResetCursor(),
      });
      mutateSession(() => nextSession);
      setRunnerResetCursor(false);
      await Promise.all([refetchSession(), refetchEvents()]);
    });
  };

  const handleRunnerPause = async () => {
    await runSessionAction("runner-pause", async () => {
      const nextSession = await pausePaperSessionRunner(paperSessionId(), {
        summary: "Paused the historical paper runner from the session UI.",
      });
      mutateSession(() => nextSession);
      await Promise.all([refetchSession(), refetchEvents()]);
    });
  };

  const handleRunnerStep = async () => {
    const steps = Number(runnerStepCount().trim());
    if (!Number.isInteger(steps) || steps < 1 || steps > 500) {
      setError("Runner step count must be a whole number between 1 and 500.");
      return;
    }

    await runSessionAction("runner-step", async () => {
      const nextSession = await stepPaperSessionRunner(paperSessionId(), { steps });
      mutateSession(() => nextSession);
      await Promise.all([refetchSession(), refetchEvents()]);
    });
  };

  return (
    <AppShell
      title={session()?.name ?? "Paper Session"}
      subtitle={
        session()
          ? "Runtime state and event trail."
          : "Loading paper session..."
      }
      actions={
        <>
          <A
            href="/paper-sessions"
            class="rounded-sm border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
          >
            All Paper Sessions
          </A>
          <Show when={session()}>
            {(entry) => (
              <A
                href={`/candidates/${entry().candidate_id}`}
                class="rounded-sm border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
              >
                Open Candidate
              </A>
            )}
          </Show>
          <Show when={candidate()}>
            {(entry) => (
              <A
                href={`/backtests/${entry()!.backtest_id}`}
                class="rounded-sm border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
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
              <div class="rounded-md border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-200">
                {error()}
              </div>
            </Show>

            <section class="app-panel app-panel-section space-y-5">
              <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div class="space-y-3">
                  <div class="flex flex-wrap items-center gap-2">
                    <p class="app-kicker">Runtime Status</p>
                    <span
                      class={`rounded-sm border px-2.5 py-1 text-xs font-medium uppercase tracking-[0.18em] ${statusTone(
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

                <div class="rounded-md border border-zinc-800 bg-zinc-950/60 px-4 py-4 text-sm text-zinc-300">
                  <p>Created by {entry().created_by}</p>
                  <p class="mt-1 text-zinc-500">{formatTimestamp(entry().created_at)}</p>
                  <p class="mt-3">Last event: {formatTimestamp(entry().last_event_at)}</p>
                  <p class="mt-1 text-zinc-500">Last bar: {formatTimestamp(entry().last_bar_time)}</p>
                </div>
              </div>

              <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div class="rounded-md border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                  <p class="app-kicker">Marked Equity</p>
                  <p class="mt-2 text-sm font-semibold text-zinc-100">
                    {formatCurrency(numberFromUnknown(metricsSnapshot().marked_equity))}
                  </p>
                </div>
                <div class="rounded-md border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                  <p class="app-kicker">Total PnL</p>
                  <p class="mt-2 text-sm font-semibold text-zinc-100">
                    {formatCurrency(numberFromUnknown(metricsSnapshot().total_pnl), true)}
                  </p>
                </div>
                <div class="rounded-md border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                  <p class="app-kicker">Closed Trades</p>
                  <p class="mt-2 text-sm font-semibold text-zinc-100">
                    {tradeLog().length}
                  </p>
                  <p class="mt-1 text-xs text-zinc-500">
                    Win rate {formatPercent(numberFromUnknown(metricsSnapshot().win_rate), 1)}
                  </p>
                </div>
                <div class="rounded-md border border-zinc-800 bg-zinc-950/60 px-4 py-3">
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
                        class={`rounded-sm transition-colors disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-500 ${action.tone}`}
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
                  </div>

                  <div class="rounded-md border border-zinc-800 bg-zinc-950/60 px-4 py-4 space-y-4">
                    <div class="flex flex-wrap items-center gap-2">
                      <p class="text-sm font-medium text-zinc-100">Historical Runner (Phase 3A)</p>
                      <span
                        class={`rounded-sm border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] ${runnerModeTone(
                          stringFromUnknown(runnerState().mode),
                        )}`}
                      >
                        {stringFromUnknown(runnerState().mode) ?? "idle"}
                      </span>
                    </div>
                    <p class="text-xs text-zinc-500">Historical DB candles as fake-live feed.</p>

                    <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                      <div class="app-subpanel px-4 py-3">
                        <p class="app-kicker">Bars Processed</p>
                        <p class="mt-2 text-sm font-semibold text-zinc-100">
                          {formatNumber(numberFromUnknown(runnerState().bars_processed), 0)}
                        </p>
                      </div>
                      <div class="app-subpanel px-4 py-3">
                        <p class="app-kicker">Last Candle</p>
                        <p class="mt-2 text-sm font-semibold text-zinc-100">
                          {formatTimestamp(stringFromUnknown(runnerState().last_candle_time))}
                        </p>
                      </div>
                      <div class="app-subpanel px-4 py-3">
                        <p class="app-kicker">Last Price</p>
                        <p class="mt-2 text-sm font-semibold text-zinc-100">
                          {formatNumber(numberFromUnknown(runnerState().last_price), 4)}
                        </p>
                      </div>
                      <div class="app-subpanel px-4 py-3">
                        <p class="app-kicker">Runner Error</p>
                        <p class="mt-2 text-sm font-semibold text-zinc-100">
                          {stringFromUnknown(runnerState().last_error) ?? "none"}
                        </p>
                      </div>
                    </div>

                    <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-[1fr_1fr_180px]">
                      <input
                        type="datetime-local"
                        value={runnerStartDate()}
                        onInput={(event) => setRunnerStartDate(event.currentTarget.value)}
                        placeholder="Runner window start"
                        class="w-full rounded-sm border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-500"
                      />
                      <input
                        type="datetime-local"
                        value={runnerEndDate()}
                        onInput={(event) => setRunnerEndDate(event.currentTarget.value)}
                        placeholder="Runner window end"
                        class="w-full rounded-sm border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-500"
                      />
                      <input
                        type="number"
                        min="100"
                        max="60000"
                        value={runnerPollInterval()}
                        onInput={(event) => setRunnerPollInterval(event.currentTarget.value)}
                        placeholder="Poll ms"
                        class="w-full rounded-sm border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-500"
                      />
                    </div>

                    <label class="inline-flex items-center gap-2 text-xs text-zinc-400">
                      <input
                        type="checkbox"
                        checked={runnerResetCursor()}
                        onChange={(event) => setRunnerResetCursor(event.currentTarget.checked)}
                        class="rounded border-zinc-700 bg-zinc-950 text-zinc-100"
                      />
                      Reset the bar cursor when starting.
                    </label>

                    <div class="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={busyAction() === "runner-start"}
                        onClick={handleRunnerStart}
                        class="rounded-sm bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
                      >
                        {busyAction() === "runner-start" ? "Starting..." : "Start Runner"}
                      </button>
                      <button
                        type="button"
                        disabled={busyAction() === "runner-pause"}
                        onClick={handleRunnerPause}
                        class="rounded-sm border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-500"
                      >
                        {busyAction() === "runner-pause" ? "Pausing..." : "Pause Runner"}
                      </button>
                      <div class="flex items-center gap-2 rounded-sm border border-zinc-700 px-2 py-1.5">
                        <input
                          type="number"
                          min="1"
                          max="500"
                          value={runnerStepCount()}
                          onInput={(event) => setRunnerStepCount(event.currentTarget.value)}
                          class="w-20 bg-transparent px-2 py-1 text-sm text-zinc-100 outline-none"
                        />
                        <button
                          type="button"
                          disabled={busyAction() === "runner-step"}
                          onClick={handleRunnerStep}
                          class="rounded-sm border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-500"
                        >
                          {busyAction() === "runner-step" ? "Stepping..." : "Step Bars"}
                        </button>
                      </div>
                    </div>
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

                  <div class="grid gap-3 md:grid-cols-3">
                    <div class="app-subpanel px-4 py-4">
                      <p class="app-kicker">Synthetic Book</p>
                      <p class="mt-2 text-sm font-semibold text-zinc-100">
                        {quoteLabel(lastQuote())}
                      </p>
                    </div>
                    <div class="app-subpanel px-4 py-4">
                      <p class="app-kicker">Resting Orders</p>
                      <div class="mt-2 space-y-2">
                        <Show
                          when={activeOrders().length > 0}
                          fallback={<p class="text-sm font-semibold text-zinc-100">No resting order.</p>}
                        >
                          <For each={activeOrders()}>
                            {(order) => (
                              <p class="rounded-sm border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-sm font-semibold text-zinc-100">
                                {orderLabel(order)}
                              </p>
                            )}
                          </For>
                        </Show>
                      </div>
                    </div>
                    <div class="app-subpanel px-4 py-4">
                      <p class="app-kicker">Model</p>
                      <p class="mt-2 text-sm font-semibold text-zinc-100">
                        {formatNumber(numberFromUnknown(entry().tick_size), 4)} tick / {formatNumber(numberFromUnknown(entry().spread_ticks), 0)} base spread / {formatNumber(numberFromUnknown(lastQuote().spread_ticks) ?? numberFromUnknown(entry().spread_ticks), 0)} live / {formatRestingFillMode(stringFromUnknown(entry().resting_fill_mode))}
                      </p>
                    </div>
                  </div>

                  <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    <div class="app-subpanel px-4 py-4">
                      <p class="app-kicker">Entry Mix</p>
                      <p class="mt-2 text-sm font-semibold text-zinc-100">
                        {executionAnalytics()
                          ? `${executionAnalytics()!.summary.makerEntries} maker / ${executionAnalytics()!.summary.takerEntries} taker`
                          : "0 / 0"}
                      </p>
                      <p class="mt-1 text-xs text-zinc-500">How the session has been getting in.</p>
                    </div>
                    <div class="app-subpanel px-4 py-4">
                      <p class="app-kicker">Exit Mix</p>
                      <p class="mt-2 text-sm font-semibold text-zinc-100">
                        {executionAnalytics()
                          ? `${executionAnalytics()!.summary.makerExits} maker / ${executionAnalytics()!.summary.takerExits} taker`
                          : "0 / 0"}
                      </p>
                      <p class="mt-1 text-xs text-zinc-500">Resting exits now count as maker closes too.</p>
                    </div>
                    <div class="app-subpanel px-4 py-4">
                      <p class="app-kicker">Avg Entry Slip</p>
                      <p
                        class={`mt-2 text-sm font-semibold ${
                          (executionAnalytics()?.summary.avgEntrySlippageTicks ?? 0) < 0
                            ? "text-emerald-300"
                            : (executionAnalytics()?.summary.avgEntrySlippageTicks ?? 0) > 0
                              ? "text-red-300"
                              : "text-zinc-100"
                        }`}
                      >
                        {formatTicks(executionAnalytics()?.summary.avgEntrySlippageTicks)}
                      </p>
                      <p class="mt-1 text-xs text-zinc-500">Versus the synthetic reference on that fill.</p>
                    </div>
                    <div class="app-subpanel px-4 py-4">
                      <p class="app-kicker">Avg Exit Slip</p>
                      <p
                        class={`mt-2 text-sm font-semibold ${
                          (executionAnalytics()?.summary.avgExitSlippageTicks ?? 0) < 0
                            ? "text-emerald-300"
                            : (executionAnalytics()?.summary.avgExitSlippageTicks ?? 0) > 0
                              ? "text-red-300"
                              : "text-zinc-100"
                        }`}
                      >
                        {formatTicks(executionAnalytics()?.summary.avgExitSlippageTicks)}
                      </p>
                      <p class="mt-1 text-xs text-zinc-500">Reversal exits count now too, not just manual flatten.</p>
                    </div>
                    <div class="app-subpanel px-4 py-4">
                      <p class="app-kicker">Closed Fills</p>
                      <p class="mt-2 text-sm font-semibold text-zinc-100">
                        {executionAnalytics()?.summary.totalExits ?? 0}
                      </p>
                      <p class="mt-1 text-xs text-zinc-500">Matched against the session trade log.</p>
                    </div>
                    <div class="app-subpanel px-4 py-4">
                      <p class="app-kicker">Tape Coverage</p>
                      <p class="mt-2 text-sm font-semibold text-zinc-100">
                        {executionAnalytics()?.summary.totalFills ?? 0} fills
                      </p>
                      <p class="mt-1 text-xs text-zinc-500">Markouts stay n/a here until we persist bar-level fill history.</p>
                    </div>
                  </div>

                  <textarea
                    value={executionNote()}
                    onInput={(event) => setExecutionNote(event.currentTarget.value)}
                    rows={2}
                    placeholder="Optional execution note..."
                    class="w-full rounded-sm border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-500"
                  />

                  <div class="grid gap-3 md:grid-cols-[1fr_1fr_180px]">
                    <input
                      type="number"
                      step="0.01"
                      value={bracketStopPrice()}
                      onInput={(event) => setBracketStopPrice(event.currentTarget.value)}
                      placeholder="Bracket stop"
                      class="w-full rounded-sm border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-500"
                    />
                    <input
                      type="number"
                      step="0.01"
                      value={bracketTargetPrice()}
                      onInput={(event) => setBracketTargetPrice(event.currentTarget.value)}
                      placeholder="Bracket target"
                      class="w-full rounded-sm border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-500"
                    />
                    <button
                      type="button"
                      disabled={busyAction() === "execute" || !hasOpenPosition() || hasActiveOrder()}
                      onClick={handleAttachBracket}
                      class="rounded-sm border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-500"
                    >
                      Attach Bracket
                    </button>
                  </div>

                  <div class="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={busyAction() === "execute"}
                      onClick={() => handleExecution("lift_ask")}
                      class="rounded-sm bg-emerald-400 px-4 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
                    >
                      Lift Ask
                    </button>
                    <button
                      type="button"
                      disabled={busyAction() === "execute"}
                      onClick={() => handleExecution("hit_bid")}
                      class="rounded-sm bg-rose-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-rose-400 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
                    >
                      Hit Bid
                    </button>
                    <button
                      type="button"
                      disabled={busyAction() === "execute" || hasOpenPosition() || hasActiveOrder()}
                      onClick={() => handleExecution("join_bid")}
                      class="rounded-sm border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-500"
                    >
                      Join Bid
                    </button>
                    <button
                      type="button"
                      disabled={busyAction() === "execute" || hasOpenPosition() || hasActiveOrder()}
                      onClick={() => handleExecution("join_ask")}
                      class="rounded-sm border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-500"
                    >
                      Join Ask
                    </button>
                    <button
                      type="button"
                      disabled={busyAction() === "execute" || !hasOpenPosition() || hasActiveOrder()}
                      onClick={() => handleExecution("rest_exit")}
                      class="rounded-sm border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-500"
                    >
                      Rest Exit
                    </button>
                    <button
                      type="button"
                      disabled={busyAction() === "execute" || !hasSingleActiveOrder()}
                      onClick={() => handleExecution("replace")}
                      class="rounded-sm border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-500"
                    >
                      Replace
                    </button>
                    <button
                      type="button"
                      disabled={busyAction() === "execute" || !hasActiveOrder()}
                      onClick={() => handleExecution("cancel")}
                      class="rounded-sm border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-500"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={busyAction() === "execute" || (!hasOpenPosition() && !hasActiveOrder())}
                      onClick={() => handleExecution("flatten")}
                      class="rounded-sm border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-500"
                    >
                      Flatten
                    </button>
                    <Show when={hasOpenPosition()}>
                    <span class="rounded-sm border border-zinc-700 px-3 py-2 text-xs text-zinc-400">
                      Position is open, so `flatten` uses the synthetic opposite side.
                    </span>
                    </Show>
                  </div>
                </section>

                <section class="app-panel app-panel-section space-y-4">
                  <div class="space-y-2">
                    <p class="app-kicker">Manual Event Log</p>
                  </div>

                  <div class="grid gap-3 md:grid-cols-[200px_1fr]">
                    <input
                      value={eventType()}
                      onInput={(event) => setEventType(event.currentTarget.value)}
                      placeholder="operator_note"
                      class="w-full rounded-sm border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-500"
                    />
                    <textarea
                      value={eventSummary()}
                      onInput={(event) => setEventSummary(event.currentTarget.value)}
                      rows={3}
                      placeholder="Add a real session note..."
                      class="w-full rounded-sm border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-500"
                    />
                  </div>

                  <button
                    type="button"
                    disabled={busyAction() === "event-save"}
                    onClick={handleEventSave}
                    class="rounded-sm border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-500"
                  >
                    {busyAction() === "event-save" ? "Saving event..." : "Save Event"}
                  </button>

                  <div class="rounded-md border border-zinc-800 bg-zinc-950/60">
                    <div class="border-b border-zinc-800 px-4 py-4">
                      <p class="app-kicker">Execution Tape</p>
                      <p class="mt-1 text-sm text-zinc-400">
                        Recent fills and order lifecycle pulled out of the paper event trail.
                      </p>
                    </div>
                    <table class="w-full text-sm">
                      <thead class="text-xs text-zinc-400">
                        <tr>
                          <th class="p-3 text-left">Time</th>
                          <th class="p-3 text-left">Action</th>
                          <th class="p-3 text-left">Role</th>
                          <th class="p-3 text-right">Price</th>
                          <th class="p-3 text-right">Slip</th>
                          <th class="p-3 text-left">Note</th>
                        </tr>
                      </thead>
                      <tbody>
                        <Show
                          when={(executionAnalytics()?.tape.length ?? 0) > 0}
                          fallback={
                            <tr class="border-t border-zinc-800">
                              <td class="p-4 text-zinc-500" colSpan={6}>
                                No paper execution events yet.
                              </td>
                            </tr>
                          }
                        >
                          <For each={[...(executionAnalytics()?.tape ?? [])].reverse().slice(0, 12)}>
                            {(row) => (
                              <tr class="border-t border-zinc-800 transition-colors hover:bg-zinc-900/70">
                                <td class="p-3 font-mono text-xs text-zinc-400">{formatTimestamp(row.time)}</td>
                                <td class="p-3 text-zinc-200">
                                  {row.action}
                                  <Show when={row.side}>
                                    <span class="ml-2 text-xs uppercase tracking-[0.18em] text-zinc-500">
                                      {row.side}
                                    </span>
                                  </Show>
                                </td>
                                <td class="p-3 text-zinc-400">
                                  {row.role === "n/a" ? row.category : `${row.role} ${row.liquidity}`}
                                </td>
                                <td class="p-3 text-right font-mono text-zinc-200">
                                  {row.price === null ? "n/a" : row.price.toFixed(2)}
                                </td>
                                <td
                                  class={`p-3 text-right font-mono ${
                                    row.slippageTicks === null
                                      ? "text-zinc-500"
                                      : row.slippageTicks < 0
                                        ? "text-emerald-300"
                                        : row.slippageTicks > 0
                                          ? "text-red-300"
                                          : "text-zinc-200"
                                  }`}
                                >
                                  {formatTicks(row.slippageTicks)}
                                </td>
                                <td class="p-3 text-zinc-400">{row.note ?? " "}</td>
                              </tr>
                            )}
                          </For>
                        </Show>
                      </tbody>
                    </table>
                  </div>

                  <div class="space-y-3">
                    <Show
                      when={(events() ?? []).length > 0}
                      fallback={
                        <div class="rounded-md border border-zinc-800 bg-zinc-950/60 px-4 py-6 text-sm text-zinc-500">
                          No events yet.
                        </div>
                      }
                    >
                      <For each={[...(events() ?? [])].reverse()}>
                        {(event) => (
                          <article class="rounded-md border border-zinc-800 bg-zinc-950/60 px-4 py-4">
                            <div class="flex flex-wrap items-center gap-2">
                              <span class="rounded-sm border border-zinc-700 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-300">
                                {event.event_type.replace(/_/g, " ")}
                              </span>
                              <span class="text-xs text-zinc-500">{event.actor}</span>
                            </div>
                            <p class="mt-3 text-sm text-zinc-200">{event.summary}</p>
                            <Show when={Object.keys(event.payload ?? {}).length > 0}>
                              <pre class="mt-3 overflow-x-auto rounded-md border border-zinc-800 bg-zinc-950 px-4 py-3 text-xs text-zinc-400">
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
                              <article class="rounded-md border border-zinc-800 bg-zinc-950 px-4 py-3">
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
