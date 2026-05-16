import { A } from "@solidjs/router";
import { createMemo, createResource, For, Show } from "solid-js";
import AppShell from "../components/AppShell";
import EquityCurve, { type EquityReferenceLine } from "../components/EquityCurve";
import WorkspaceLaunchControl from "../components/workspace/WorkspaceLaunchControl";
import WorkspaceContextBadge from "../components/workspace/WorkspaceContextBadge";
import { fetchReplaySessions, type ReplaySessionSummary } from "../services/api";
import { formatReplaySessionStatus } from "../services/replaySessionState";

const WORKING_SESSION_STATUSES = new Set(["draft", "active", "paused", "review"]);

type ReplayGrowthSummary = {
  data: number[];
  referenceLines: EquityReferenceLine[];
  totalPnl: number;
  finalBalance: number;
  targetBalance: number | null;
  floorBalance: number | null;
  targetGap: number | null;
  workingCount: number;
  sessionCount: number;
  mixedRules: boolean;
};

function formatMoney(value: number): string {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
}

function formatBalance(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatRange(session: ReplaySessionSummary): string {
  if (!session.start_date && !session.end_date) {
    return "Full available range";
  }

  return `${session.start_date || "Earliest"} to ${session.end_date || "Latest"}`;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function latestReplayPnl(session: ReplaySessionSummary): number {
  const latestEquity = session.equity_curve.at(-1);
  if (latestEquity !== undefined && Number.isFinite(latestEquity)) {
    return roundMoney(latestEquity - session.prop_firm_rules.account_size);
  }

  return session.total_pnl;
}

function latestReplayBalance(session: ReplaySessionSummary): number {
  return roundMoney(session.prop_firm_rules.account_size + latestReplayPnl(session));
}

function ruleSignature(session: ReplaySessionSummary): string {
  const rules = session.prop_firm_rules;
  return [
    rules.account_size,
    rules.profit_target,
    rules.max_drawdown,
    rules.drawdown_type,
  ].join(":");
}

function buildReplayGrowthSummary(sessions: ReplaySessionSummary[]): ReplayGrowthSummary | null {
  if (sessions.length === 0) {
    return null;
  }

  const sorted = [...sessions].sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
  );
  const baseRules = sorted[0].prop_firm_rules;
  const baseBalance = baseRules.account_size;
  const mixedRules = sorted.some((session) => ruleSignature(session) !== ruleSignature(sorted[0]));

  let runningPnl = 0;
  const data = [baseBalance];

  for (const session of sorted) {
    runningPnl = roundMoney(runningPnl + latestReplayPnl(session));
    data.push(roundMoney(baseBalance + runningPnl));
  }

  const targetBalance = mixedRules ? null : roundMoney(baseBalance * (1 + baseRules.profit_target));
  const floorBalance = mixedRules ? null : roundMoney(baseBalance * (1 - baseRules.max_drawdown));
  const finalBalance = data.at(-1) ?? baseBalance;
  const referenceLines: EquityReferenceLine[] = [
    { value: baseBalance, title: "Start", color: "#78716c" },
  ];

  if (targetBalance !== null) {
    referenceLines.push({ value: targetBalance, title: "Target", color: "#4ade80" });
  }

  if (floorBalance !== null) {
    referenceLines.push({ value: floorBalance, title: "DD floor", color: "#f87171" });
  }

  return {
    data,
    referenceLines,
    totalPnl: runningPnl,
    finalBalance,
    targetBalance,
    floorBalance,
    targetGap: targetBalance === null ? null : roundMoney(targetBalance - finalBalance),
    workingCount: sorted.filter((session) => WORKING_SESSION_STATUSES.has(session.status)).length,
    sessionCount: sorted.length,
    mixedRules,
  };
}

function TradingGrowthPanel(props: { summary: ReplayGrowthSummary }) {
  return (
    <div class="app-panel app-panel-section">
      <div class="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
        <div class="min-w-0">
          <p class="text-xs uppercase tracking-[0.18em] text-stone-500">Trading Growth Curve</p>
          <h2 class="mt-2 text-xl font-semibold text-stone-100">Saved replay account path</h2>
          <p class="mt-2 max-w-2xl text-sm text-stone-400">
            Active, paused, review, breached, and finished saved sessions all count here.
          </p>
        </div>

        <div class="grid w-full grid-cols-1 gap-3 sm:grid-cols-3 xl:max-w-2xl">
          <div class="border-t border-stone-700/80 pt-3">
            <p class="app-metric-label">Replay PnL</p>
            <p
              class={`app-data mt-1 text-2xl font-semibold ${
                props.summary.totalPnl >= 0 ? "text-green-400" : "text-red-400"
              }`}
            >
              {formatMoney(props.summary.totalPnl)}
            </p>
          </div>
          <div class="border-t border-stone-700/80 pt-3">
            <p class="app-metric-label">Current Balance</p>
            <p class="app-data mt-1 text-2xl font-semibold text-stone-100">
              {formatBalance(props.summary.finalBalance)}
            </p>
          </div>
          <div class="border-t border-stone-700/80 pt-3">
            <p class="app-metric-label">Open Saved</p>
            <p class="app-data mt-1 text-2xl font-semibold text-stone-100">
              {props.summary.workingCount}
              <span class="text-sm text-stone-500"> / {props.summary.sessionCount}</span>
            </p>
          </div>
        </div>
      </div>

      <div class="mt-5">
        <EquityCurve
          data={props.summary.data}
          height={260}
          lineColor="#60a5fa"
          referenceLines={props.summary.referenceLines}
        />
      </div>

      <div class="mt-4 flex flex-wrap items-center gap-3 text-xs text-stone-400">
        <span class="inline-flex items-center gap-2">
          <span class="h-0.5 w-7 bg-stone-500" /> Start
        </span>
        <Show
          when={!props.summary.mixedRules}
          fallback={<span class="text-stone-500">Mixed rule sets, so target/floor lines stay off.</span>}
        >
          <span class="inline-flex items-center gap-2">
            <span class="h-0.5 w-7 bg-green-400" /> Target{" "}
            {props.summary.targetBalance !== null ? formatBalance(props.summary.targetBalance) : ""}
          </span>
          <span class="inline-flex items-center gap-2">
            <span class="h-0.5 w-7 bg-red-400" /> Drawdown floor{" "}
            {props.summary.floorBalance !== null ? formatBalance(props.summary.floorBalance) : ""}
          </span>
          <Show when={props.summary.targetGap !== null}>
            <span class="app-data text-stone-500">
              Target gap {formatMoney(props.summary.targetGap ?? 0)}
            </span>
          </Show>
        </Show>
      </div>
    </div>
  );
}

export default function ReplaySessionListPage() {
  const [sessions] = createResource(fetchReplaySessions);
  const growthSummary = createMemo(() => buildReplayGrowthSummary(sessions() ?? []));

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
      <div class="mx-auto w-full max-w-6xl">
        <WorkspaceContextBadge />

        <Show when={!sessions.loading} fallback={<div class="app-panel h-40 animate-pulse" />}>
          <Show
            when={(sessions() ?? []).length > 0}
            fallback={
              <div class="app-panel app-panel-section py-20 text-center text-sm text-stone-500">
                No replay sessions yet.{" "}
                <A href="/replay" class="text-stone-100 hover:underline">
                  Launch your first saved session
                </A>
              </div>
            }
          >
            <div class="space-y-5">
              <Show when={growthSummary()}>
                {(summary) => <TradingGrowthPanel summary={summary()} />}
              </Show>

              <div class="space-y-3">
              <For each={sessions()}>
                {(session) => (
                  <div class="app-panel app-panel-interactive px-5 py-4">
                    <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div class="space-y-2">
                        <p class="text-sm font-semibold text-stone-100">{session.name}</p>
                        <p class="text-xs uppercase tracking-[0.18em] text-stone-500">
                          {session.symbol} · <span class="app-data">{session.interval}</span> ·{" "}
                          <span class="text-green-200">{formatReplaySessionStatus(session.status)}</span>
                        </p>
                        <p class="text-sm text-stone-400">{formatRange(session)}</p>
                        <Show when={session.source_backtest}>
                          {(source) => (
                            <p class="app-meta-text">
                              Linked to `{source().backtest_id.slice(0, 8)}`.
                            </p>
                          )}
                        </Show>
                        <p class="app-data text-xs text-stone-500">
                          Updated {new Date(session.updated_at).toLocaleString()}
                        </p>
                      </div>

                      <div class="grid grid-cols-2 gap-3 text-right sm:grid-cols-4">
                        <div class="rounded-xl border border-stone-700/80 bg-stone-950/70 px-3 py-2">
                          <p class="app-metric-label">Total PnL</p>
                          <p
                            class={`app-data mt-1 text-2xl font-semibold ${
                              session.total_pnl >= 0 ? "text-green-400" : "text-red-400"
                            }`}
                          >
                            {formatMoney(session.total_pnl)}
                          </p>
                        </div>
                        <div class="rounded-xl border border-stone-700/80 bg-stone-950/70 px-3 py-2">
                          <p class="app-metric-label">Trades</p>
                          <p class="app-data mt-1 text-xl font-semibold text-stone-100">
                            {session.total_trades}
                          </p>
                        </div>
                        <div class="rounded-xl border border-stone-700/80 bg-stone-950/70 px-3 py-2">
                          <p class="app-metric-label">Equity</p>
                          <p class="app-data mt-1 text-xl font-semibold text-stone-100">
                            {formatBalance(latestReplayBalance(session))}
                          </p>
                        </div>
                        <div class="rounded-xl border border-stone-700/80 bg-stone-950/70 px-3 py-2">
                          <p class="app-metric-label">Saved Bar</p>
                          <p class="app-data mt-1 text-xl font-semibold text-stone-100">
                            {session.current_bar_index + 1}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div class="mt-4 flex items-center justify-end gap-2 border-t border-stone-700/80 pt-4">
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
            </div>
          </Show>
        </Show>
      </div>
    </AppShell>
  );
}
