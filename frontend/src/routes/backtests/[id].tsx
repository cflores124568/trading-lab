import { A, useParams } from "@solidjs/router";
import {
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import {
  fetchBacktest,
  fetchBacktestRobustness,
  fetchBacktestCandles,
  fetchPropPresets,
  type BacktestRobustnessResult,
  type Candle,
  type PropFirmEvaluation,
  type PropFirmPreset,
  type PropFirmRules,
  type RobustnessDistribution,
  type Trade,
} from "../../services/api";
import { DATABENTO_SYMBOLS } from "../../constants";
import ChartIndicatorToggleBar from "../../components/ChartIndicatorToggleBar";
import EquityCurve from "../../components/EquityCurve";
import PriceChart, { type PriceChartMarker } from "../../components/PriceChart";
import ReplayControls from "../../components/ReplayControls";
import {
  defaultPriceChartIndicatorSettings,
  type PriceChartIndicatorSettings,
} from "../../services/chartIndicators";
import {
  clampReplayIndex,
  findJumpTarget,
  getReplayIndexFromProgress,
  getReplayProgress,
  getTradeEntryIndices,
  simulateReplaySession,
  type ReplayAction,
} from "../../services/replaySimulator";
import { defaultExecutionConfigForSymbol } from "../../services/executionModel";
import {
  estimateFirstPayout,
  evaluatePropFirmRules,
  findMatchingPresetKey,
  groupPropPresets,
  resolvePayoutPolicy,
  summarizeTrades,
  type DailyPnlEntry,
  type PayoutEstimate,
  type TradeAnalyticsSummary,
} from "../../services/backtestAnalytics";
import { CircleCheck, CircleX, TriangleAlert } from "lucide-solid";
import AppShell from "../../components/AppShell";
import WorkspaceLaunchControl from "../../components/workspace/WorkspaceLaunchControl";

type DetailTab = "overview" | "stats" | "prop-eval" | "trades" | "robustness";

interface PropEvalDetails {
  account_size?: number;
  daily_loss_limit_pct?: number | null;
  daily_loss_limit_amount?: number | null;
  daily_loss_actual_loss?: number;
  daily_loss_actual_loss_pct?: number;
  daily_loss_breach_time?: string | null;
  daily_loss_breach_equity?: number | null;
  drawdown_type?: "intraday" | "eod";
  max_drawdown_limit_pct?: number;
  actual_drawdown_pct?: number;
  drawdown_breach_time?: string | null;
  drawdown_breach_equity?: number | null;
  drawdown_peak_equity?: number | null;
  drawdown_peak_time?: string | null;
  profit_target_pct?: number;
  actual_profit_pct?: number;
  best_day_profit_pct?: number;
  consistency_threshold?: number | null;
  min_trading_days_required?: number | null;
  trading_days_completed?: number;
  daily_pnls?: Record<string, number>;
  first_breach_rule?: "daily_loss" | "drawdown" | null;
  first_breach_time?: string | null;
  stopped_at_first_breach?: boolean;
  first_breach_equity?: number;
  first_breach_balance?: number;
  first_breach_open_pnl?: number;
  stopped_trade_count?: number;
  trades_after_breach_ignored?: number;
}

interface CalendarCell {
  key: string;
  dayLabel: string;
  entry: DailyPnlEntry | null;
  isPadding: boolean;
}

interface CalendarMonth {
  key: string;
  label: string;
  cells: CalendarCell[];
}

interface DashboardCard {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "good" | "bad";
}

const tickValueBySymbol = Object.fromEntries(
  DATABENTO_SYMBOLS.map((symbol) => [symbol.key, symbol.tickValue]),
) as Record<string, number>;

const tabOptions: { key: DetailTab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "stats", label: "Stats" },
  { key: "prop-eval", label: "Prop Eval" },
  { key: "trades", label: "Trades" },
  { key: "robustness", label: "Robustness" },
];

const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const monthFormatter = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function formatCurrency(
  value: number,
  options: { signed?: boolean; digits?: number } = {},
): string {
  const { signed = false, digits = 2 } = options;
  const abs = Math.abs(value).toFixed(digits);

  if (signed) {
    return `${value >= 0 ? "+" : "-"}$${abs}`;
  }

  return `${value < 0 ? "-" : ""}$${abs}`;
}

function formatPercent(value: number | null | undefined, digits = 1, fallback = "n/a"): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return fallback;
  }
  return `${(value * 100).toFixed(digits)}%`;
}

function formatRatio(value: number): string {
  if (!Number.isFinite(value)) {
    return "∞";
  }

  return value.toFixed(2);
}

function formatParamSummary(params: Record<string, unknown>): string {
  const entries = Object.entries(params);
  if (entries.length === 0) {
    return "Default params";
  }

  return entries
    .map(([key, value]) => `${key}=${typeof value === "number" ? Number(value).toFixed(Number.isInteger(value) ? 0 : 2) : String(value)}`)
    .join(", ");
}

function formatDistribution(
  distribution: RobustnessDistribution,
  formatter: (value: number) => string,
): string {
  return `${formatter(distribution.p05)} / ${formatter(distribution.median)} / ${formatter(distribution.p95)}`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatRank(value?: number | null): string {
  return value == null ? "n/a" : `#${value}`;
}

function formatBracketConfig(runConfig?: {
  stop_loss_ticks?: number | null;
  take_profit_ticks?: number | null;
} | null): string {
  const stopLoss = runConfig?.stop_loss_ticks;
  const takeProfit = runConfig?.take_profit_ticks;

  if (stopLoss == null && takeProfit == null) {
    return "Brackets off";
  }

  return [
    stopLoss != null ? `SL ${stopLoss}t` : null,
    takeProfit != null ? `TP ${takeProfit}t` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function formatRunConfigSummary(runConfig: BacktestRobustnessResult["run_config"]): string {
  const positionSize = Number.isInteger(runConfig.position_size)
    ? runConfig.position_size.toFixed(0)
    : runConfig.position_size.toFixed(2);

  return [
    `Balance ${formatCurrency(runConfig.initial_balance)}`,
    `Size ${positionSize}`,
    `Comm ${formatCurrency(runConfig.commission)}`,
    `Tick ${runConfig.tick_size} / ${formatCurrency(runConfig.tick_value)}`,
    `Slip ${runConfig.slippage_ticks}t`,
    formatBracketConfig(runConfig),
  ].join(" · ");
}

function markerTimeFromIso(value: string): number {
  return Math.floor(new Date(value).getTime() / 1000);
}

function createReplayAction(type: ReplayAction["type"], barIndex: number): ReplayAction {
  return {
    id: `${type}_${barIndex}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    barIndex,
    createdAt: Date.now(),
  };
}

function propEvalTone(passed: boolean): string {
  return passed ? "border-green-700 bg-green-950/40" : "border-red-700 bg-red-950/40";
}

function getPropEvalDetails(evaluation: PropFirmEvaluation): PropEvalDetails {
  return evaluation.details as PropEvalDetails;
}

function formatBreachTime(value?: string | null): string {
  if (!value) return "n/a";
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString();
}

function formatDuration(startIso: string, endIso?: string | null): string {
  if (!endIso) {
    return "Open";
  }

  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
    return "n/a";
  }

  const minutes = Math.round((end - start) / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) {
    return `${hours}h`;
  }

  return `${hours}h ${remainingMinutes}m`;
}

function formatMinutesDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return "0m";
  }

  if (minutes < 60) {
    return `${Math.round(minutes)}m`;
  }

  const wholeHours = Math.floor(minutes / 60);
  const remainingMinutes = Math.round(minutes % 60);
  if (remainingMinutes === 0) {
    return `${wholeHours}h`;
  }

  return `${wholeHours}h ${remainingMinutes}m`;
}

function calendarTone(pnl: number | null): string {
  if (pnl === null) {
    return "border-zinc-900 bg-zinc-950/40";
  }
  if (pnl > 0) {
    return "border-emerald-900/80 bg-emerald-950/40";
  }
  if (pnl < 0) {
    return "border-red-900/80 bg-red-950/40";
  }
  return "border-zinc-800 bg-zinc-900/70";
}

function parseUtcDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function buildCalendarMonths(entries: DailyPnlEntry[]): CalendarMonth[] {
  if (entries.length === 0) {
    return [];
  }

  const byDate = new Map(entries.map((entry) => [entry.date, entry]));
  const first = parseUtcDate(entries[0].date);
  const last = parseUtcDate(entries[entries.length - 1].date);
  const cursor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
  const lastMonth = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), 1));
  const months: CalendarMonth[] = [];

  while (cursor <= lastMonth) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const monthStart = new Date(Date.UTC(year, month, 1));
    const monthEnd = new Date(Date.UTC(year, month + 1, 0));
    const cells: CalendarCell[] = [];

    for (let i = 0; i < monthStart.getUTCDay(); i += 1) {
      cells.push({
        key: `${year}-${month}-pad-${i}`,
        dayLabel: "",
        entry: null,
        isPadding: true,
      });
    }

    for (let day = 1; day <= monthEnd.getUTCDate(); day += 1) {
      const date = new Date(Date.UTC(year, month, day));
      const key = date.toISOString().slice(0, 10);
      cells.push({
        key,
        dayLabel: String(day),
        entry: byDate.get(key) ?? null,
        isPadding: false,
      });
    }

    months.push({
      key: `${year}-${String(month + 1).padStart(2, "0")}`,
      label: monthFormatter.format(monthStart),
      cells,
    });

    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return months;
}

function TabButton(props: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class={`rounded-sm px-4 py-2 text-sm font-medium transition-colors ${
        props.active
          ? "bg-sky-400 text-zinc-950"
          : "border border-zinc-700 bg-zinc-950 text-zinc-300 hover:border-zinc-500 hover:bg-zinc-900"
      }`}
    >
      {props.label}
    </button>
  );
}

function MetricCard(props: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "good" | "bad";
}) {
  return (
    <div class="app-panel p-4">
      <p class="mb-1 text-xs text-zinc-400">{props.label}</p>
      <p
        class={`font-mono text-xl font-semibold ${
          props.tone === "good"
            ? "text-emerald-300"
            : props.tone === "bad"
              ? "text-red-300"
              : "text-zinc-100"
        }`}
      >
        {props.value}
      </p>
      <Show when={props.hint}>
        <p class="mt-2 text-xs text-zinc-500">{props.hint}</p>
      </Show>
    </div>
  );
}

function HeroMetricCard(props: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "good" | "bad";
}) {
  return (
    <div class="rounded-md border border-zinc-800 bg-zinc-950/70 px-4 py-4">
      <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">{props.label}</p>
      <p
        class={`mt-2 font-mono text-2xl font-semibold ${
          props.tone === "good"
            ? "text-emerald-300"
            : props.tone === "bad"
              ? "text-red-300"
              : "text-zinc-100"
        }`}
      >
        {props.value}
      </p>
      <Show when={props.hint}>
        <p class="mt-2 text-xs text-zinc-500">{props.hint}</p>
      </Show>
    </div>
  );
}

function PropEvalPanel(props: {
  title: string;
  rules: PropFirmRules;
  evaluation: PropFirmEvaluation;
  summary: TradeAnalyticsSummary;
  payoutEstimate?: PayoutEstimate | null;
  note?: string;
}) {
  const details = createMemo(() => getPropEvalDetails(props.evaluation));
  const minTradingDaysPassed = () => props.evaluation.min_trading_days_passed ?? true;
  const drawdownLimitPct = () => details().max_drawdown_limit_pct ?? props.rules.max_drawdown;
  const actualDrawdownPct = () => details().actual_drawdown_pct ?? 0;
  const drawdownBufferPct = () => Math.max(0, drawdownLimitPct() - actualDrawdownPct());
  const drawdownBufferDollars = () => drawdownBufferPct() * props.rules.account_size;
  const profitTargetPct = () => details().profit_target_pct ?? props.rules.profit_target;
  const actualProfitPct = () => details().actual_profit_pct ?? 0;
  const profitProgress = () => {
    if (profitTargetPct() <= 0) {
      return actualProfitPct() > 0 ? 1 : 0;
    }
    return Math.max(0, actualProfitPct() / profitTargetPct());
  };
  const bestDayPct = () => details().best_day_profit_pct ?? 0;
  const tradingDaysRequired = () =>
    details().min_trading_days_required ?? props.rules.min_trading_days;
  const tradingDaysCompleted = () =>
    details().trading_days_completed ?? props.summary.trading_days;
  const firstBreachLabel = () => {
    if (!details().first_breach_rule) return "None";
    return details().first_breach_rule === "daily_loss" ? "Daily loss" : "Drawdown";
  };
  const equityLabel = () =>
    details().stopped_at_first_breach ? "Stopped Equity" : "Current Equity";

  return (
    <div class={`rounded-md border p-5 ${propEvalTone(props.evaluation.passed)}`}>
      <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div class="space-y-2">
          <div class="flex items-center gap-2">
            {props.evaluation.passed ? (
              <CircleCheck class="text-green-400" />
            ) : (
              <CircleX size={18} class="text-red-400" />
            )}
            <p class="font-semibold text-zinc-100">
              {props.title}: {props.evaluation.passed ? "Passed" : "Failed"}
            </p>
          </div>
          <p class="text-sm text-zinc-300">{props.rules.name}</p>
          <Show when={props.note}>
            <p class="max-w-2xl text-xs text-zinc-500">{props.note}</p>
          </Show>
        </div>

        <div class="rounded-sm border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-right">
          <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">{equityLabel()}</p>
          <p class="mt-2 font-mono text-xl font-semibold text-zinc-100">
            {formatCurrency(props.summary.current_balance)}
          </p>
        </div>
      </div>

      <div class="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Profit Target Progress"
          value={`${(profitProgress() * 100).toFixed(1)}%`}
          hint={`${formatPercent(actualProfitPct(), 2)} / ${formatPercent(profitTargetPct(), 2)}`}
          tone={props.evaluation.profit_target_hit ? "good" : "default"}
        />
        <MetricCard
          label="Max Drawdown Limit"
          value={formatPercent(drawdownLimitPct(), 2)}
          hint={`${props.rules.drawdown_type.toUpperCase()} rule`}
        />
        <MetricCard
          label="Remaining DD Buffer"
          value={formatPercent(drawdownBufferPct(), 2)}
          hint={formatCurrency(drawdownBufferDollars())}
          tone={props.evaluation.drawdown_breached ? "bad" : "good"}
        />
        <MetricCard
          label="Consistency %"
          value={
            props.rules.consistency_rule
              ? formatPercent(bestDayPct(), 2)
              : "Not used"
          }
          hint={
            props.rules.consistency_rule
              ? `limit ${formatPercent(props.rules.consistency_threshold, 2)}`
              : "This preset doesn't enforce it"
          }
          tone={!props.rules.consistency_rule || props.evaluation.consistency_passed ? "good" : "bad"}
        />
        <MetricCard
          label="Largest Green Day"
          value={formatCurrency(props.summary.largest_green_day, { signed: true })}
          hint={`${props.summary.trading_days} trading days logged`}
          tone={props.summary.largest_green_day >= 0 ? "good" : "bad"}
        />
        <MetricCard
          label="Min Trading Days"
          value={
            tradingDaysRequired() === null || tradingDaysRequired() === undefined
              ? "Not required"
              : `${tradingDaysCompleted()}/${tradingDaysRequired()}`
          }
          hint={`${formatCount(props.summary.total_contracts)} contracts logged`}
          tone={minTradingDaysPassed() ? "good" : "bad"}
        />
        <MetricCard
          label="Daily Loss Limit"
          value={
            props.rules.daily_loss_limit == null || props.rules.daily_loss_limit === 0
              ? "Off"
              : formatPercent(props.rules.daily_loss_limit, 2)
          }
          hint={
            props.rules.daily_loss_limit == null || props.rules.daily_loss_limit === 0
              ? "No daily loss limit"
              : details().daily_loss_actual_loss !== undefined
              ? `${formatCurrency(details().daily_loss_actual_loss ?? 0)} max intraday loss`
              : formatCurrency(props.rules.account_size * props.rules.daily_loss_limit)
          }
          tone={!props.evaluation.daily_loss_breached ? "good" : "bad"}
        />
        <MetricCard
          label="First Rule Breach"
          value={firstBreachLabel()}
          hint={formatBreachTime(details().first_breach_time)}
          tone={details().first_breach_rule ? "bad" : "good"}
        />
      </div>

      <Show when={props.payoutEstimate}>
        {(estimate) => (
          <div class="mt-5 rounded-md border border-zinc-800 bg-zinc-950/70 p-4">
            {(() => {
              const winningDaysRequired = estimate().winning_days_required;
              const winningDayProfit = estimate().winning_day_profit;
              const bufferBalance = estimate().buffer_balance;
              const minProfitGoal = estimate().min_profit_goal;
              const winningDaysComplete =
                winningDaysRequired === undefined ||
                estimate().winning_days_hit >= winningDaysRequired;
              const profitGateComplete =
                bufferBalance !== undefined
                  ? estimate().remaining_to_buffer === 0
                  : minProfitGoal === undefined ||
                    props.summary.current_balance - props.rules.account_size >= minProfitGoal;

              return (
                <>
            <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div class="space-y-1">
                <p class="text-sm font-semibold text-zinc-100">Estimated Payout</p>
                <p class="text-xs text-zinc-500">{estimate().policy_label}</p>
              </div>
              <div class="rounded-sm border border-zinc-800 bg-zinc-950 px-4 py-3 text-right">
                <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Payout Status</p>
                <p
                  class={`mt-2 font-mono text-lg font-semibold ${
                    estimate().eligible ? "text-emerald-300" : "text-yellow-300"
                  }`}
                >
                  {estimate().supported
                    ? estimate().eligible
                      ? "Likely eligible"
                      : "Not yet"
                    : "Unavailable"}
                </p>
              </div>
            </div>

            <div class="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                label="Estimated Payout"
                value={formatCurrency(estimate().estimated_payout)}
                hint={estimate().cadence_label}
                tone={estimate().eligible ? "good" : "default"}
              />
              <MetricCard
                label="Eligible Profit"
                value={formatCurrency(estimate().eligible_profit)}
                hint={`${formatPercent(estimate().request_pct, 0)} request model`}
              />
              <MetricCard
                label="Winning Days"
                value={
                  winningDaysRequired
                    ? `${estimate().winning_days_hit}/${winningDaysRequired}`
                    : "Not used"
                }
                hint={
                  winningDayProfit
                    ? `$${winningDayProfit} minimum green day`
                    : "No winning-day gate"
                }
                tone={winningDaysComplete ? "good" : "bad"}
              />
              <MetricCard
                label="Buffer / Profit Gate"
                value={
                  bufferBalance !== undefined
                    ? formatCurrency(bufferBalance)
                    : minProfitGoal !== undefined
                      ? formatCurrency(minProfitGoal)
                      : "Not used"
                }
                hint={
                  bufferBalance !== undefined
                    ? estimate().remaining_to_buffer > 0
                      ? `${formatCurrency(estimate().remaining_to_buffer)} still needed`
                      : "Buffer cleared"
                    : minProfitGoal !== undefined
                      ? "Cycle profit goal"
                      : "No extra gate"
                }
                tone={profitGateComplete ? "good" : "default"}
              />
            </div>

            <div class="mt-4 grid gap-4 lg:grid-cols-2">
              <div>
                <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Blocked By</p>
                <Show
                  when={estimate().blocked_by.length > 0}
                  fallback={<p class="mt-2 text-sm text-emerald-300">Nothing obvious is blocking a first payout request.</p>}
                >
                  <ul class="mt-2 space-y-2 text-sm text-zinc-300">
                    <For each={estimate().blocked_by}>
                      {(item) => (
                        <li class="flex items-start gap-2">
                          <TriangleAlert size={13} class="mt-0.5 text-yellow-300" />
                          <span>{item}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>

              <div>
                <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Assumptions</p>
                <ul class="mt-2 space-y-2 text-sm text-zinc-400">
                  <For each={estimate().assumptions}>
                    {(item) => <li>{item}</li>}
                  </For>
                </ul>
              </div>
            </div>
                </>
              );
            })()}
          </div>
        )}
      </Show>

      <Show when={!props.evaluation.passed}>
        <ul class="mt-4 space-y-2 text-sm text-red-300">
          <Show when={props.evaluation.daily_loss_breached}>
            <li class="flex items-center gap-1.5">
              <TriangleAlert size={13} /> Daily loss limit breached at {formatBreachTime(details().daily_loss_breach_time)}
            </li>
          </Show>
          <Show when={props.evaluation.drawdown_breached}>
            <li class="flex items-center gap-1.5">
              <TriangleAlert size={13} /> Max drawdown breached at {formatBreachTime(details().drawdown_breach_time)}
            </li>
          </Show>
          <Show when={details().stopped_at_first_breach}>
            <li class="flex items-center gap-1.5">
              <TriangleAlert size={13} />
              Reporting stops there at {formatCurrency(details().first_breach_equity ?? props.summary.current_balance)}
              <Show when={details().first_breach_open_pnl !== undefined}>
                {` (${formatCurrency(details().first_breach_open_pnl ?? 0, { signed: true })} open PnL)`}
              </Show>
            </li>
          </Show>
          <Show when={!props.evaluation.consistency_passed}>
            <li class="flex items-center gap-1.5">
              <TriangleAlert size={13} /> Consistency rule failed
            </li>
          </Show>
          <Show when={!minTradingDaysPassed()}>
            <li class="flex items-center gap-1.5">
              <TriangleAlert size={13} /> Minimum trading days not reached
            </li>
          </Show>
          <Show when={!props.evaluation.profit_target_hit}>
            <li class="flex items-center gap-1.5">
              <TriangleAlert size={13} /> Profit target not reached
            </li>
          </Show>
        </ul>
      </Show>
    </div>
  );
}

function DailyPnlCalendar(props: { entries: DailyPnlEntry[] }) {
  const months = createMemo(() => buildCalendarMonths(props.entries));

  return (
    <div class="space-y-6">
      <Show
        when={months().length > 0}
        fallback={
          <div class="rounded-md border border-zinc-800 bg-zinc-950/60 px-5 py-10 text-center text-sm text-zinc-500">
            No closed trades yet, so there isn't a daily PnL calendar to show.
          </div>
        }
      >
        <For each={months()}>
          {(month) => (
            <section class="space-y-3">
              <div class="flex items-center justify-between">
                <h3 class="text-sm font-semibold text-zinc-100">{month.label}</h3>
                <p class="text-xs text-zinc-500">Exit-day PnL by session</p>
              </div>

              <div class="grid grid-cols-7 gap-2">
                <For each={weekdayLabels}>
                  {(label) => (
                    <p class="px-1 text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                      {label}
                    </p>
                  )}
                </For>

                <For each={month.cells}>
                  {(cell) => (
                    <div
                      class={`min-h-20 rounded-sm border p-2 ${calendarTone(cell.entry?.pnl ?? null)}`}
                    >
                      <Show
                        when={!cell.isPadding}
                        fallback={<div class="h-full rounded-lg border border-dashed border-zinc-900" />}
                      >
                        <div class="flex h-full flex-col justify-between">
                          <p class="text-xs font-medium text-zinc-400">{cell.dayLabel}</p>
                          <Show when={cell.entry}>
                            {(entry) => (
                              <div>
                                <p
                                  class={`font-mono text-sm font-semibold ${
                                    entry().pnl >= 0 ? "text-emerald-300" : "text-red-300"
                                  }`}
                                >
                                  {formatCurrency(entry().pnl, { signed: true })}
                                </p>
                                <p class="mt-1 text-[11px] text-zinc-500">
                                  {entry().trade_count} trade{entry().trade_count === 1 ? "" : "s"}
                                </p>
                              </div>
                            )}
                          </Show>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </section>
          )}
        </For>
      </Show>
    </div>
  );
}

function TradesTable(props: {
  title: string;
  trades: Trade[];
  emptyMessage?: string;
}) {
  return (
    <div class="app-panel overflow-hidden">
      <p class="border-b border-zinc-800 p-4 text-sm text-zinc-400">
        {props.title} ({props.trades.length})
      </p>
      <table class="w-full text-sm">
        <thead class="text-xs text-zinc-400">
          <tr>
            <th class="p-3 text-left">#</th>
            <th class="p-3 text-left">Side</th>
            <th class="p-3 text-left">Entry Time</th>
            <th class="p-3 text-left">Exit Time</th>
            <th class="p-3 text-left">Duration</th>
            <th class="p-3 text-right">Entry $</th>
            <th class="p-3 text-right">Exit $</th>
            <th class="p-3 text-right">PnL</th>
          </tr>
        </thead>
        <tbody>
          <Show
            when={props.trades.length > 0}
            fallback={
              <tr class="border-t border-zinc-800">
                <td class="p-4 text-zinc-500" colSpan={8}>
                  {props.emptyMessage ?? "No trades yet."}
                </td>
              </tr>
            }
          >
            <For each={props.trades}>
              {(trade) => (
                <tr class="border-t border-zinc-800 transition-colors hover:bg-zinc-800">
                  <td class="p-3 text-zinc-400">{trade.trade_id}</td>
                  <td
                    class={`p-3 font-medium ${
                      trade.side === "buy" ? "text-green-400" : "text-red-400"
                    }`}
                  >
                    {trade.side}
                  </td>
                  <td class="p-3 font-mono text-xs text-zinc-400">{trade.entry_time}</td>
                  <td class="p-3 font-mono text-xs text-zinc-400">{trade.exit_time}</td>
                  <td class="p-3 text-zinc-400">{formatDuration(trade.entry_time, trade.exit_time)}</td>
                  <td class="p-3 text-right font-mono">{trade.entry_price.toFixed(2)}</td>
                  <td class="p-3 text-right font-mono">{(trade.exit_price ?? 0).toFixed(2)}</td>
                  <td
                    class={`p-3 text-right font-mono font-semibold ${
                      trade.pnl >= 0 ? "text-green-400" : "text-red-400"
                    }`}
                  >
                    {formatCurrency(trade.pnl, { signed: true })}
                  </td>
                </tr>
              )}
            </For>
          </Show>
        </tbody>
      </table>
    </div>
  );
}

export default function BacktestDetail() {
  const params = useParams<{ id: string }>();
  const [activeTab, setActiveTab] = createSignal<DetailTab>("overview");
  const [selectedPresetKey, setSelectedPresetKey] = createSignal<string | null>(null);
  const [result] = createResource(() => params.id, fetchBacktest);
  const [presets] = createResource(fetchPropPresets);
  const [candles] = createResource(
    () => result()?.backtest_id,
    (backtestId) => fetchBacktestCandles(backtestId),
  );
  const [robustness] = createResource(
    () => (activeTab() === "robustness" ? params.id : undefined),
    async (backtestId) => (backtestId ? fetchBacktestRobustness(backtestId) : null),
  );

  const [isReplayActive, setIsReplayActive] = createSignal(false);
  const [speed, setSpeed] = createSignal(8);
  const [currentIndex, setCurrentIndex] = createSignal(0);
  const [replayActions, setReplayActions] = createSignal<ReplayAction[]>([]);
  const [indicatorSettings, setIndicatorSettings] = createSignal(
    defaultPriceChartIndicatorSettings(),
  );

  let lastResetKey: string | null = null;

  createEffect(() => {
    const backtestId = result()?.backtest_id;
    const totalBars = candles()?.length ?? 0;
    const resetKey = backtestId ? `${backtestId}:${totalBars}` : null;

    if (!resetKey || resetKey === lastResetKey || totalBars === 0) {
      return;
    }

    lastResetKey = resetKey;
    batch(() => {
      setIsReplayActive(false);
      setSpeed(8);
      setCurrentIndex(0);
      setReplayActions([]);
      setActiveTab("overview");
    });
  });

  createEffect(() => {
    const loadedPresets = presets();
    const backtest = result();
    if (!loadedPresets || loadedPresets.length === 0 || !backtest) {
      return;
    }

    setSelectedPresetKey((current) => {
      if (current && loadedPresets.some((preset) => preset.key === current)) {
        return current;
      }

      return (
        findMatchingPresetKey(loadedPresets, backtest.prop_firm_rules) ??
        loadedPresets[0]?.key ??
        null
      );
    });
  });

  createEffect(() => {
    const candleList = candles();
    if (!isReplayActive() || !candleList || candleList.length === 0) {
      return;
    }

    const intervalMs = Math.max(50, Math.round(1000 / speed()));
    const timer = setInterval(() => {
      setCurrentIndex((previous) => {
        const capped = clampReplayIndex(previous, candleList.length);
        if (capped >= candleList.length - 1) {
          setIsReplayActive(false);
          return candleList.length - 1;
        }
        return capped + 1;
      });
    }, intervalMs);

    onCleanup(() => clearInterval(timer));
  });

  const totalBars = createMemo(() => candles()?.length ?? 0);
  const replayIndex = createMemo(() => clampReplayIndex(currentIndex(), totalBars()));
  const replayProgress = createMemo(() => getReplayProgress(replayIndex(), totalBars()));
  const currentCandle = createMemo<Candle | undefined>(() => candles()?.[replayIndex()]);
  const commission = createMemo(() => result()?.run_config.commission ?? result()?.trades[0]?.commission ?? 5);
  const tickValue = createMemo(() => result()?.run_config.tick_value ?? tickValueBySymbol[result()?.symbol ?? ""] ?? 1);
  const tickSize = createMemo(() => result()?.run_config.tick_size ?? 0.25);
  const tradeEntryIndices = createMemo(() =>
    candles() && result() ? getTradeEntryIndices(candles() ?? [], result()?.trades ?? []) : [],
  );
  const workspaceIntent = createMemo(() => {
    const backtest = result();
    const replayContext = backtest?.replay_context;

    if (!backtest?.symbol || !replayContext?.interval) {
      return null;
    }

    return {
      source: "backtest" as const,
      symbol: backtest.symbol,
      interval: replayContext.interval,
      startDate: replayContext.start_date ?? undefined,
      endDate: replayContext.end_date ?? undefined,
    };
  });

  const groupedPresets = createMemo(() => groupPropPresets(presets() ?? []));
  const savedPresetKey = createMemo(() => {
    const backtest = result();
    const loadedPresets = presets();
    if (!backtest || !loadedPresets) {
      return null;
    }

    return findMatchingPresetKey(loadedPresets, backtest.prop_firm_rules);
  });
  const selectedPreset = createMemo<PropFirmPreset | null>(() => {
    const key = selectedPresetKey();
    return presets()?.find((preset) => preset.key === key) ?? null;
  });
  const selectedPropRules = createMemo<PropFirmRules | null>(() => {
    const backtest = result();
    return selectedPreset() ?? backtest?.prop_firm_rules ?? null;
  });
  const rebasedSelectedEquityCurve = createMemo(() => {
    const backtest = result();
    const rules = selectedPropRules();
    if (!backtest || !rules) {
      return [];
    }

    const balanceOffset = rules.account_size - backtest.prop_firm_rules.account_size;
    return backtest.equity_curve.map((value) => Number((value + balanceOffset).toFixed(2)));
  });
  const selectedPropEvaluation = createMemo<PropFirmEvaluation | null>(() => {
    const backtest = result();
    const rules = selectedPropRules();
    if (!backtest || !rules) {
      return null;
    }

    if (
      savedPresetKey() &&
      selectedPresetKey() &&
      savedPresetKey() === selectedPresetKey()
    ) {
      return backtest.prop_firm_eval;
    }

    return evaluatePropFirmRules(
      rules,
      backtest.trades,
      rebasedSelectedEquityCurve(),
      rules.account_size,
      (candles() ?? []).map((candle) => Number(candle.time)),
    );
  });
  const strategySummary = createMemo(() => {
    const backtest = result();
    if (!backtest) {
      return [];
    }

    return [
      ["Symbol", backtest.symbol || "Unknown"],
      ["Strategy", backtest.strategy.type],
      ["Saved Preset", backtest.prop_firm_rules.name],
      ["Brackets", formatBracketConfig(backtest.run_config)],
      ["Created", new Date(backtest.created_at).toLocaleString()],
    ] as [string, string][];
  });
  const systemTradeSummary = createMemo(() => {
    const backtest = result();
    if (!backtest) {
      return null;
    }

    return summarizeTrades(
      backtest.trades,
      backtest.equity_curve,
      backtest.prop_firm_rules.account_size,
    );
  });
  const selectedTradeSummary = createMemo(() => {
    const backtest = result();
    const rules = selectedPropRules();
    if (!backtest || !rules) {
      return null;
    }

    return summarizeTrades(backtest.trades, rebasedSelectedEquityCurve(), rules.account_size);
  });
  const savedPayoutEstimate = createMemo(() => {
    const backtest = result();
    const summary = systemTradeSummary();
    if (!backtest || !summary) {
      return null;
    }

    return estimateFirstPayout({
      payoutPolicy: resolvePayoutPolicy(savedPresetKey(), backtest.prop_firm_rules),
      rules: backtest.prop_firm_rules,
      trades: backtest.trades,
      summary,
    });
  });
  const selectedPayoutEstimate = createMemo(() => {
    const backtest = result();
    const rules = selectedPropRules();
    const summary = selectedTradeSummary();
    if (!backtest || !rules || !summary) {
      return null;
    }

    return estimateFirstPayout({
      payoutPolicy: resolvePayoutPolicy(selectedPresetKey(), rules),
      rules,
      trades: backtest.trades,
      summary,
    });
  });

  const replaySession = createMemo(() => {
    const backtest = result();
    const candleList = candles();
    if (!backtest || !candleList || candleList.length === 0) {
      return null;
    }

    const executionDefaults = defaultExecutionConfigForSymbol(backtest.symbol);

    return simulateReplaySession({
      candles: candleList,
      currentIndex: replayIndex(),
      actions: replayActions(),
      initialBalance: backtest.prop_firm_rules.account_size,
      commission: commission(),
      tickValue: tickValue(),
      tickSize: tickSize(),
      spreadTicks: executionDefaults.spreadTicks,
      volatileBarThresholdTicks: executionDefaults.volatileBarThresholdTicks,
      volatileBarExtraTicks: executionDefaults.volatileBarExtraTicks,
      restingFillMode: executionDefaults.restingFillMode,
      propFirmRules: backtest.prop_firm_rules,
    });
  });
  const replayTradeSummary = createMemo(() => {
    const session = replaySession();
    const backtest = result();
    if (!session || !backtest) {
      return null;
    }

    return summarizeTrades(
      session.trades,
      session.equityCurve,
      backtest.prop_firm_rules.account_size,
    );
  });
  const replayPayoutEstimate = createMemo(() => {
    const backtest = result();
    const summary = replayTradeSummary();
    const session = replaySession();
    if (!backtest || !summary || !session) {
      return null;
    }

    return estimateFirstPayout({
      payoutPolicy: resolvePayoutPolicy(savedPresetKey(), backtest.prop_firm_rules),
      rules: backtest.prop_firm_rules,
      trades: session.trades,
      summary,
    });
  });

  const chartMarkers = createMemo<PriceChartMarker[]>(() => {
    const backtest = result();
    const session = replaySession();
    if (!backtest) {
      return [];
    }

    const baselineMarkers: PriceChartMarker[] = backtest.trades.map((trade) => ({
      time: markerTimeFromIso(trade.entry_time),
      position: trade.side === "buy" ? "belowBar" : "aboveBar",
      color: trade.side === "buy" ? "#38bdf8" : "#f59e0b",
      shape: trade.side === "buy" ? "arrowUp" : "arrowDown",
      text: `SYS ${trade.side.toUpperCase()} @ ${trade.entry_price.toFixed(2)}`,
    }));

    const replayMarkers: PriceChartMarker[] = [];
    for (const trade of session?.trades ?? []) {
      replayMarkers.push({
        time: markerTimeFromIso(trade.entry_time),
        position: trade.side === "buy" ? "belowBar" : "aboveBar",
        color: trade.side === "buy" ? "#22c55e" : "#fb7185",
        shape: trade.side === "buy" ? "arrowUp" : "arrowDown",
        text: `YOU ${trade.side.toUpperCase()} @ ${trade.entry_price.toFixed(2)}`,
      });

      if (trade.exit_time) {
        replayMarkers.push({
          time: markerTimeFromIso(trade.exit_time),
          position: trade.side === "buy" ? "aboveBar" : "belowBar",
          color: "#f8fafc",
          shape: "square",
          text: `EXIT ${trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}`,
        });
      }
    }

    if (session?.position && currentCandle()) {
      replayMarkers.push({
        time: Number(currentCandle()!.time),
        position: session.position.side === "buy" ? "belowBar" : "aboveBar",
        color: session.position.side === "buy" ? "#34d399" : "#f43f5e",
        shape: "circle",
        text: `OPEN ${session.position.side.toUpperCase()} ${formatCurrency(session.position.unrealized_pnl, { signed: true })}`,
      });
    }

    return [...baselineMarkers, ...replayMarkers];
  });

  const currentTimeLabel = createMemo(() => {
    const candle = currentCandle();
    return candle ? new Date(Number(candle.time) * 1000).toLocaleString() : "No candle";
  });

  const currentPriceLabel = createMemo(() => {
    const candle = currentCandle();
    return candle ? `$${candle.close.toFixed(2)}` : "No price";
  });

  const positionLabel = createMemo(() => {
    const session = replaySession();
    if (!session?.position) {
      return "Flat";
    }

    return `${session.position.side.toUpperCase()} from $${session.position.entry_price.toFixed(2)} (${formatCurrency(session.position.unrealized_pnl, { signed: true })})`;
  });

  const bidAskLabel = createMemo(() => {
    const quote = replaySession()?.currentQuote;
    if (!quote) {
      return "No book";
    }
    return `$${quote.bid.toFixed(2)} / $${quote.ask.toFixed(2)}`;
  });

  const activeOrderLabel = createMemo(() => {
    const order = replaySession()?.activeOrder;
    if (!order) {
      return "None";
    }
    const intent = order.intent === "exit" ? "EXIT" : "ENTRY";
    const armed = order.first_touch_bar_index !== undefined ? " [armed]" : "";
    const replaceTag = order.replace_count ? ` [replace ${order.replace_count}]` : "";
    return `${intent} ${order.side.toUpperCase()} @ $${order.price.toFixed(2)}${armed}${replaceTag}`;
  });

  const replayMetrics = createMemo(() => {
    const session = replaySession();
    if (!session) {
      return null;
    }

    return [
      ["Realized PnL", formatCurrency(session.realizedPnl, { signed: true })],
      ["Total PnL", formatCurrency(session.totalPnl, { signed: true })],
      ["Win Rate", `${(session.metrics.win_rate * 100).toFixed(1)}%`],
      ["Trades", String(session.metrics.total_trades)],
      ["Balance", formatCurrency(session.balance)],
      ["Position", session.position ? session.position.side.toUpperCase() : "FLAT"],
    ] as [string, string][];
  });

  const overviewCards = createMemo(() => {
    const backtest = result();
    const summary = systemTradeSummary();
    if (!backtest || !summary) {
      return [];
    }

    return [
      {
        label: "Net PnL",
        value: formatCurrency(backtest.metrics.total_pnl, { signed: true }),
        tone: backtest.metrics.total_pnl >= 0 ? "good" : "bad",
        hint: `End balance ${formatCurrency(summary.current_balance)}`,
      },
      {
        label: "Win Rate",
        value: formatPercent(backtest.metrics.win_rate),
        hint: `${backtest.metrics.winning_trades} winners / ${backtest.metrics.losing_trades} losers`,
      },
      {
        label: "Profit Factor",
        value: formatRatio(backtest.metrics.profit_factor),
        hint: `${formatCurrency(summary.gross_wins)} gross wins`,
      },
      {
        label: "Max Drawdown",
        value: formatPercent(backtest.metrics.max_drawdown, 2),
        hint: backtest.prop_firm_rules.drawdown_type.toUpperCase(),
      },
      {
        label: "Best Trade",
        value: formatCurrency(backtest.metrics.best_trade, { signed: true }),
        tone: backtest.metrics.best_trade >= 0 ? "good" : "default",
        hint: `Worst ${formatCurrency(backtest.metrics.worst_trade, { signed: true })}`,
      },
      {
        label: "Saved Prop Eval",
        value: backtest.prop_firm_eval.passed ? "Passed" : "Failed",
        tone: backtest.prop_firm_eval.passed ? "good" : "bad",
        hint: backtest.prop_firm_rules.name,
      },
    ] as DashboardCard[];
  });
  const robustnessHighlights = createMemo(() => {
    const analysis = robustness() as BacktestRobustnessResult | null;
    if (!analysis) {
      return [];
    }

    const bootstrap = analysis.monte_carlo.find((scenario) => scenario.key === "bootstrap") ?? analysis.monte_carlo[0];
    return [
      {
        label: "Bootstrap Median PnL",
        value: bootstrap ? formatCurrency(bootstrap.total_pnl.median, { signed: true }) : "n/a",
        hint: bootstrap ? `p05/p95 ${formatCurrency(bootstrap.total_pnl.p05, { signed: true })} / ${formatCurrency(bootstrap.total_pnl.p95, { signed: true })}` : undefined,
      },
      {
        label: "Bootstrap p95 DD",
        value: bootstrap ? formatPercent(bootstrap.max_drawdown.p95, 2) : "n/a",
        hint: bootstrap ? `Base ${formatPercent(analysis.baseline.max_drawdown, 2)}` : undefined,
        tone: bootstrap && bootstrap.max_drawdown.p95 > analysis.baseline.max_drawdown ? "bad" : "default",
      },
      {
        label: "Baseline Sweep Rank",
        value: formatRank(analysis.parameter_sweep.baseline_rank),
        hint: `${analysis.parameter_sweep.total_runs} nearby runs`,
        tone: analysis.parameter_sweep.baseline_rank === 1 ? "good" : "default",
      },
      {
        label: "Walk-Forward Pass Rate",
        value: formatPercent(analysis.walk_forward.passing_rate),
        hint: `${analysis.walk_forward.folds_completed}/${analysis.walk_forward.folds_requested} folds`,
        tone: analysis.walk_forward.passing_rate >= 0.5 ? "good" : analysis.walk_forward.folds_completed > 0 ? "bad" : "default",
      },
    ] as DashboardCard[];
  });

  const statsCards = createMemo(() => {
    const backtest = result();
    const summary = systemTradeSummary();
    if (!backtest || !summary) {
      return [];
    }

    return [
      {
        label: "Net PnL",
        value: formatCurrency(backtest.metrics.total_pnl, { signed: true }),
        tone: backtest.metrics.total_pnl >= 0 ? "good" : "bad",
      },
      { label: "Win Rate", value: formatPercent(backtest.metrics.win_rate) },
      { label: "Profit Factor", value: formatRatio(backtest.metrics.profit_factor) },
      { label: "Sharpe Ratio", value: backtest.metrics.sharpe_ratio.toFixed(2) },
      { label: "Sortino Ratio", value: backtest.metrics.sortino_ratio.toFixed(2) },
      { label: "Max Drawdown", value: formatPercent(backtest.metrics.max_drawdown, 2) },
      {
        label: "Best / Worst Trade",
        value: `${formatCurrency(backtest.metrics.best_trade, { signed: true })} / ${formatCurrency(backtest.metrics.worst_trade, { signed: true })}`,
      },
      {
        label: "Avg Win / Avg Loss",
        value: `${formatCurrency(summary.avg_win, { signed: true })} / ${formatCurrency(summary.avg_loss, { signed: true })}`,
      },
      { label: "Total Trades", value: formatCount(backtest.metrics.total_trades) },
      {
        label: "Contracts Traded",
        value: formatCount(summary.total_contracts),
        hint: "Current runs are fixed-size trades",
      },
    ] as DashboardCard[];
  });

  const tradesSummaryCards = createMemo(() => {
    const backtest = result();
    if (!backtest) {
      return [];
    }

    return [
      ["Total Trades", formatCount(backtest.metrics.total_trades)],
      ["Winning Trades", formatCount(backtest.metrics.winning_trades)],
      ["Losing Trades", formatCount(backtest.metrics.losing_trades)],
      ["Avg Duration", formatMinutesDuration(backtest.metrics.avg_trade_duration)],
    ] as [string, string][];
  });

  const seekToIndex = (nextIndex: number) => {
    batch(() => {
      setIsReplayActive(false);
      setCurrentIndex(clampReplayIndex(nextIndex, totalBars()));
    });
  };

  const recordReplayAction = (type: ReplayAction["type"]) => {
    if (!candles() || totalBars() === 0) {
      return;
    }

    if (
      ["lift_ask", "hit_bid", "join_bid", "join_ask", "rest_exit", "replace", "buy", "sell"].includes(type) &&
      replayIndex() >= totalBars() - 1
    ) {
      return;
    }

    setIsReplayActive(false);
    setReplayActions((previous) => [...previous, createReplayAction(type, replayIndex())]);
  };

  const jumpToTrade = (direction: "next" | "prev") => {
    const target = findJumpTarget(replayIndex(), tradeEntryIndices(), direction);
    if (target !== null) {
      seekToIndex(target);
    }
  };

  const jumpToReplaySection = () => {
    setActiveTab("overview");
    requestAnimationFrame(() => {
      document.getElementById("replay")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const toggleIndicator = (key: keyof PriceChartIndicatorSettings) => {
    setIndicatorSettings((current) => ({
      ...current,
      [key]: !current[key],
    }));
  };

  return (
    <AppShell
      title={result() ? `${result()!.symbol} • ${result()!.strategy.type}` : "Backtest"}
      subtitle={
        result()?.backtest_id ??
        "Saved run detail."
      }
      actions={
        <>
          <A
            href={`/experiments?fromBacktestId=${params.id}`}
            class="app-button-secondary"
          >
            Create Experiment
          </A>
          <A
            href={`/replay?backtestId=${params.id}`}
            class="app-button-secondary"
          >
            Launch Sim Session
          </A>
          <button
            type="button"
            onClick={jumpToReplaySection}
            class="app-button-primary"
          >
            Jump to Replay
          </button>
          <A
            href="/backtests"
            class="app-button-secondary"
          >
            Back to Backtests
          </A>
        </>
      }
    >
      <Show
        when={result()}
        fallback={
          <section class="app-panel app-panel-section flex min-h-60 items-center justify-center">
            <p class="text-zinc-400">Loading backtest…</p>
          </section>
        }
      >
        {(bt) => (
          <div class="space-y-6">
            <section class="app-panel app-panel-section">
              <div class="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
                <div class="space-y-2">
                  <p class="app-kicker">Saved Run</p>
                  <h2 class="text-2xl font-semibold text-zinc-100">
                    {bt().symbol} {bt().strategy.type.replace(/_/g, " ")}
                  </h2>
                </div>

                <div class="flex flex-wrap gap-2">
                  <For each={tabOptions}>
                    {(tab) => (
                      <TabButton
                        label={tab.label}
                        active={activeTab() === tab.key}
                        onClick={() => setActiveTab(tab.key)}
                      />
                    )}
                  </For>
                </div>
              </div>

              <div class="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,0.8fr)]">
                <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  <HeroMetricCard
                    label="Net PnL"
                    value={formatCurrency(bt().metrics.total_pnl, { signed: true })}
                    tone={bt().metrics.total_pnl >= 0 ? "good" : "bad"}
                    hint={`Win rate ${formatPercent(bt().metrics.win_rate)}`}
                  />
                  <HeroMetricCard
                    label="Saved Prop Eval"
                    value={bt().prop_firm_eval.passed ? "Passed" : "Failed"}
                    tone={bt().prop_firm_eval.passed ? "good" : "bad"}
                    hint={bt().prop_firm_rules.name}
                  />
                  <HeroMetricCard
                    label="Total Trades"
                    value={formatCount(bt().metrics.total_trades)}
                    hint={`Max DD ${formatPercent(bt().metrics.max_drawdown, 2)}`}
                  />
                </div>

                <div class="rounded-md border border-zinc-800 bg-zinc-950/60 px-4 py-4">
                  <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Run Context</p>
                  <div class="mt-4 grid gap-3 sm:grid-cols-2">
                    <For each={strategySummary()}>
                      {([label, value]) => (
                        <div class="rounded-sm border border-zinc-800 bg-zinc-900/60 px-3 py-3">
                          <p class="text-xs text-zinc-500">{label}</p>
                          <p class="mt-1 text-sm font-medium text-zinc-100">{value}</p>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </div>
            </section>

            <Switch>
              <Match when={activeTab() === "overview"}>
                <div class="space-y-6">
                  <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                    <For each={overviewCards()}>
                      {(card) => (
                        <MetricCard
                          label={card.label}
                          value={card.value}
                          hint={card.hint}
                          tone={card.tone}
                        />
                      )}
                    </For>
                  </div>

                  <section class="app-panel app-panel-section">
                    <div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                      <div class="space-y-2">
                        <p class="app-kicker">Replay First</p>
                      </div>

                      <div class="flex flex-wrap items-center gap-3">
                        <Show when={workspaceIntent()}>
                          {(intent) => (
                            <WorkspaceLaunchControl
                              intent={intent()}
                              buttonLabel="Open in Workspace"
                            />
                          )}
                        </Show>
                        <A
                          href={`/replay?backtestId=${bt().backtest_id}`}
                          class="app-button-secondary"
                        >
                          Launch Sim Session
                        </A>
                        <button
                          type="button"
                          onClick={jumpToReplaySection}
                          class="app-button-primary"
                        >
                          Start Replay
                        </button>
                        <A
                          href="/backtests"
                          class="app-button-secondary"
                        >
                          All Backtests
                        </A>
                      </div>
                    </div>
                    <Show when={!workspaceIntent() && result()?.symbol}>
                      <p class="text-xs text-zinc-500">
                        `Open in Workspace` needs durable replay context, so older saved backtests
                        still fall back to the replay section below.
                      </p>
                    </Show>
                  </section>

                  <section id="replay" class="app-panel app-panel-section space-y-6 scroll-mt-24">
                    <div class="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
                      <div class="space-y-2">
                        <p class="text-xs uppercase tracking-[0.18em] text-sky-300">Interactive Replay Simulator</p>
                      </div>
                      <div class="grid gap-3 sm:grid-cols-2">
                        <div class="rounded-md border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                          <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Commission</p>
                          <p class="mt-2 font-mono text-lg font-semibold text-zinc-100">
                            ${commission().toFixed(2)}
                          </p>
                        </div>
                        <div class="rounded-md border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                          <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Tick Value</p>
                          <p class="mt-2 font-mono text-lg font-semibold text-zinc-100">
                            ${tickValue().toFixed(2)}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div class="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
                      <div class="space-y-5">
                        <ChartIndicatorToggleBar
                          settings={indicatorSettings()}
                          onToggle={toggleIndicator}
                        />

                        <div class="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
                          <Show
                            when={candles.error}
                            fallback={
                              <Show
                                when={!candles.loading && candles() && candles()!.length > 0}
                                fallback={
                                  <div class="flex h-[520px] items-center justify-center rounded-md bg-zinc-800/70">
                                    <p class="text-sm text-zinc-500">
                                      {candles.loading
                                        ? "Loading chart data…"
                                        : "No candles available for this backtest."}
                                    </p>
                                  </div>
                                }
                              >
                                <PriceChart
                                  candles={candles() as Candle[]}
                                  markers={chartMarkers()}
                                  visibleIndex={replayIndex()}
                                  height={520}
                                  indicators={indicatorSettings()}
                                  indicatorLegend="full"
                                  class="rounded-md"
                                />
                              </Show>
                            }
                          >
                            {(error) => (
                              <div class="flex h-[520px] items-center justify-center rounded-md border border-zinc-800 bg-zinc-950 px-6 text-center">
                                <p class="text-sm text-red-400">
                                  Replay data failed to load: {error().message}
                                </p>
                              </div>
                            )}
                          </Show>
                        </div>

                        <Show when={candles() && candles()!.length > 0}>
                          <ReplayControls
                            isPlaying={isReplayActive()}
                            speed={speed()}
                            statusLabel="Backtest Replay"
                            statusDetail="Review mode is unlocked for this saved run."
                            progress={replayProgress()}
                            currentBar={totalBars() === 0 ? 0 : replayIndex() + 1}
                            totalBars={totalBars()}
                            currentTimeLabel={currentTimeLabel()}
                            currentPriceLabel={currentPriceLabel()}
                            bidAskLabel={bidAskLabel()}
                            positionLabel={positionLabel()}
                            activeOrderLabel={activeOrderLabel()}
                            canSeek
                            canStartPlayback={replayIndex() < totalBars() - 1}
                            canStepBack={replayIndex() > 0}
                            canStepForward={replayIndex() < totalBars() - 1}
                            canJumpPrevTrade={
                              findJumpTarget(replayIndex(), tradeEntryIndices(), "prev") !== null
                            }
                            canJumpNextTrade={
                              findJumpTarget(replayIndex(), tradeEntryIndices(), "next") !== null
                            }
                            canLiftAsk
                            canHitBid
                            canJoinBid={!replaySession()?.position && !replaySession()?.activeOrder}
                            canJoinAsk={!replaySession()?.position && !replaySession()?.activeOrder}
                            canRestExit={!!replaySession()?.position && !replaySession()?.activeOrder}
                            canReplaceOrder={!!replaySession()?.activeOrder && replayIndex() < totalBars() - 1}
                            canCancelOrder={!!replaySession()?.activeOrder}
                            canFlatten={!!replaySession()?.position || !!replaySession()?.activeOrder}
                            onPlayPause={() => {
                              if (isReplayActive()) {
                                setIsReplayActive(false);
                                return;
                              }

                              if (replayIndex() >= totalBars() - 1) {
                                setCurrentIndex(0);
                              }
                              setIsReplayActive(true);
                            }}
                            onSpeedChange={setSpeed}
                            onSeek={(progress) =>
                              seekToIndex(getReplayIndexFromProgress(progress, totalBars()))
                            }
                            onRestart={() => {
                              batch(() => {
                                setIsReplayActive(false);
                                setCurrentIndex(0);
                                setReplayActions([]);
                              });
                            }}
                            onStepBack={() => seekToIndex(replayIndex() - 1)}
                            onStepForward={() => seekToIndex(replayIndex() + 1)}
                            onJumpPrevTrade={() => jumpToTrade("prev")}
                            onJumpNextTrade={() => jumpToTrade("next")}
                            onLiftAsk={() => recordReplayAction("lift_ask")}
                            onHitBid={() => recordReplayAction("hit_bid")}
                            onJoinBid={() => recordReplayAction("join_bid")}
                            onJoinAsk={() => recordReplayAction("join_ask")}
                            onRestExit={() => recordReplayAction("rest_exit")}
                            onReplace={() => recordReplayAction("replace")}
                            onCancel={() => recordReplayAction("cancel")}
                            onFlatten={() => recordReplayAction("flatten")}
                          />
                        </Show>
                      </div>

                      <div class="space-y-4">
                        <div class="rounded-lg border border-zinc-800 bg-zinc-950/60 p-5">
                          <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Replay Pulse</p>
                          <div class="mt-4 grid gap-3">
                            <HeroMetricCard
                              label="Current Price"
                              value={currentPriceLabel()}
                              hint="Most recent visible close in the saved run."
                            />
                            <HeroMetricCard
                              label="Position"
                              value={positionLabel()}
                              tone={replaySession()?.position ? "good" : "default"}
                              hint="Manual replay position and unrealized mark."
                            />
                            <HeroMetricCard
                              label="Progress"
                              value={totalBars() === 0 ? "0 / 0" : `${replayIndex() + 1} / ${totalBars()}`}
                              hint="Current replay cursor across the saved tape."
                            />
                          </div>
                        </div>

                        <div class="rounded-lg border border-zinc-800 bg-zinc-950/60 p-5">
                          <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Compare Lens</p>
                          <p class="mt-2 text-sm text-zinc-400">
                            Blue and amber markers are the saved system trades. Green and rose markers
                            are your manual replay decisions layered on top.
                          </p>
                        </div>
                      </div>
                    </div>
                  </section>

                  <Show when={replaySession()}>
                    {(session) => (
                      <Show when={replayTradeSummary()}>
                        {(replaySummary) => (
                          <>
                        <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                          <For each={replayMetrics() ?? []}>
                            {([label, value]) => <MetricCard label={label} value={value} />}
                          </For>
                        </div>

                        <div class="app-panel app-panel-section">
                          <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Replay Equity Curve</p>
                          <div class="mt-4">
                            <EquityCurve data={session().equityCurve} />
                          </div>
                        </div>

                        <div class="grid gap-4 lg:grid-cols-2">
                          <PropEvalPanel
                            title="System Prop Eval"
                            evaluation={bt().prop_firm_eval}
                            rules={bt().prop_firm_rules}
                            summary={systemTradeSummary()!}
                            payoutEstimate={savedPayoutEstimate()}
                            note="This is the saved evaluation attached to the backtest, plus a first-payout estimate under the same preset when that firm's payout path is modeled."
                          />
                          <PropEvalPanel
                            title="Replay Prop Eval"
                            evaluation={session().propEvaluation}
                            rules={bt().prop_firm_rules}
                            summary={replaySummary()}
                            payoutEstimate={replayPayoutEstimate()}
                            note="Same rules, but scored against the manual replay trades you placed above."
                          />
                        </div>

                        <TradesTable
                          title="Replay Trades"
                          trades={session().trades}
                          emptyMessage="No replay trades yet. Use the controls above to place manual decisions."
                        />
                          </>
                        )}
                      </Show>
                    )}
                  </Show>
                </div>
              </Match>

              <Match when={activeTab() === "stats"}>
                <div class="space-y-6">
                  <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
                    <For each={statsCards()}>
                      {(card) => (
                        <MetricCard
                          label={card.label}
                          value={card.value}
                          hint={card.hint}
                          tone={card.tone}
                        />
                      )}
                    </For>
                  </div>

                  <div class="app-panel p-4">
                    <div class="mb-4 flex items-center justify-between">
                      <div>
                        <p class="text-sm text-zinc-400">Strategy Equity Curve</p>
                      </div>
                    </div>
                    <EquityCurve data={bt().equity_curve} />
                  </div>

                  <section class="app-panel app-panel-section space-y-5">
                    <div class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                      <div>
                        <p class="app-kicker">Daily PnL</p>
                      </div>

                      <Show when={systemTradeSummary()}>
                        {(summary) => (
                          <div class="grid gap-3 sm:grid-cols-3">
                            <MetricCard
                              label="Trading Days"
                              value={formatCount(summary().trading_days)}
                            />
                            <MetricCard
                              label="Largest Green Day"
                              value={formatCurrency(summary().largest_green_day, { signed: true })}
                              tone={summary().largest_green_day >= 0 ? "good" : "bad"}
                            />
                            <MetricCard
                              label="Largest Red Day"
                              value={formatCurrency(summary().largest_red_day, { signed: true })}
                              tone={summary().largest_red_day < 0 ? "bad" : "default"}
                            />
                          </div>
                        )}
                      </Show>
                    </div>

                    <DailyPnlCalendar entries={systemTradeSummary()?.daily_pnls ?? []} />
                  </section>
                </div>
              </Match>

              <Match when={activeTab() === "prop-eval"}>
                <div class="space-y-6">
                  <section class="app-panel app-panel-section">
                    <div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                      <div class="space-y-2">
                        <p class="app-kicker">Rule Set Selector</p>
                        <p class="max-w-3xl text-sm text-zinc-300">
                          Fixed trades, rescored against the selected preset.
                        </p>
                      </div>

                      <div class="w-full max-w-md">
                        <label class="mb-1 block text-xs text-zinc-400">Firm / Account</label>
                        <select
                          class="w-full rounded-sm border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
                          value={selectedPresetKey() ?? ""}
                          onChange={(event) => setSelectedPresetKey(event.currentTarget.value)}
                        >
                          <For each={Object.entries(groupedPresets())}>
                            {([firm, options]) => (
                              <optgroup label={firm}>
                                <For each={options}>
                                  {(preset) => (
                                    <option value={preset.key}>{preset.name}</option>
                                  )}
                                </For>
                              </optgroup>
                            )}
                          </For>
                        </select>
                        <Show when={presets.error}>
                          <p class="mt-2 text-xs text-red-400">
                            Presets failed to load, so this selector may be incomplete.
                          </p>
                        </Show>
                      </div>
                    </div>
                  </section>

                  <Show when={selectedPropRules() && selectedPropEvaluation() && selectedTradeSummary()}>
                    <div class="space-y-4">
                      <PropEvalPanel
                        title="Selected Prop Eval"
                        rules={selectedPropRules()!}
                        evaluation={selectedPropEvaluation()!}
                        summary={selectedTradeSummary()!}
                        payoutEstimate={selectedPayoutEstimate()}
                        note="Payout estimates appear when enough preset metadata exists. Contract caps, prior withdrawals, and compliance reviews are not modeled."
                      />

                      <Show when={selectedPresetKey() !== savedPresetKey()}>
                        <PropEvalPanel
                          title="Saved Prop Eval"
                          rules={bt().prop_firm_rules}
                          evaluation={bt().prop_firm_eval}
                          summary={systemTradeSummary()!}
                          payoutEstimate={savedPayoutEstimate()}
                          note="This is the original evaluation saved with the backtest."
                        />
                      </Show>
                    </div>
                  </Show>
                </div>
              </Match>

              <Match when={activeTab() === "robustness"}>
                <div class="space-y-6">
                  <Show
                    when={robustness.error}
                    fallback={
                      <Show
                        when={!robustness.loading && robustness()}
                        fallback={
                          <section class="app-panel app-panel-section flex min-h-52 items-center justify-center">
                            <p class="text-zinc-400">
                              {robustness.loading
                                ? "Running robustness checks…"
                                : "Open this tab to run Monte Carlo, parameter sweep, and walk-forward checks."}
                            </p>
                          </section>
                        }
                      >
                        {(analysis) => (
                          <>
                            <Show when={analysis().warnings.length > 0}>
                              <section class="rounded-md border border-yellow-800 bg-yellow-950/30 px-4 py-4">
                                <p class="text-xs uppercase tracking-[0.18em] text-yellow-300">Warnings</p>
                                <div class="mt-3 space-y-2">
                                  <For each={analysis().warnings}>
                                    {(warning) => <p class="text-sm text-yellow-100">{warning}</p>}
                                  </For>
                                </div>
                              </section>
                            </Show>

                            <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                              <For each={robustnessHighlights()}>
                                {(card) => (
                                  <MetricCard
                                    label={card.label}
                                    value={card.value}
                                    hint={card.hint}
                                    tone={card.tone}
                                  />
                                )}
                              </For>
                            </div>

                            <section class="app-panel app-panel-section space-y-5">
                              <div class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                                <div class="space-y-2">
                                  <p class="app-kicker">Saved Baseline</p>
                                </div>

                                <div class="flex flex-wrap gap-2 text-xs text-zinc-400">
                                  <span class="rounded-sm border border-zinc-800 bg-zinc-950/60 px-3 py-1">
                                    {(analysis().symbol ?? bt().symbol).toUpperCase()}
                                  </span>
                                  <span class="rounded-sm border border-zinc-800 bg-zinc-950/60 px-3 py-1">
                                    {analysis().strategy_type}
                                  </span>
                                </div>
                              </div>

                              <p class="text-sm text-zinc-500">
                                {formatRunConfigSummary(analysis().run_config)}
                              </p>

                              <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                                <MetricCard
                                  label="Net PnL"
                                  value={formatCurrency(analysis().baseline.total_pnl, {
                                    signed: true,
                                  })}
                                  tone={
                                    analysis().baseline.total_pnl >= 0 ? "good" : "bad"
                                  }
                                />
                                <MetricCard
                                  label="Max Drawdown"
                                  value={formatPercent(analysis().baseline.max_drawdown, 2)}
                                  tone={
                                    analysis().baseline.max_drawdown <= 0.08
                                      ? "default"
                                      : "bad"
                                  }
                                />
                                <MetricCard
                                  label="Profit Factor"
                                  value={formatRatio(analysis().baseline.profit_factor)}
                                />
                                <MetricCard
                                  label="Win Rate"
                                  value={formatPercent(analysis().baseline.win_rate)}
                                />
                                <MetricCard
                                  label="Closed Trades"
                                  value={formatCount(analysis().baseline.total_trades)}
                                />
                                <MetricCard
                                  label="Prop Status"
                                  value={analysis().baseline.passed ? "Passed" : "Failed"}
                                  tone={analysis().baseline.passed ? "good" : "bad"}
                                />
                              </div>
                            </section>

                            <section class="app-panel app-panel-section space-y-5">
                              <div class="space-y-2">
                                <p class="app-kicker">Monte Carlo</p>
                                <p class="max-w-3xl text-sm text-zinc-300">
                                  Stress tests from the saved trade list.
                                </p>
                              </div>

                              <div class="grid gap-4 xl:grid-cols-2">
                                <For each={analysis().monte_carlo}>
                                  {(scenario) => (
                                    <div class="rounded-lg border border-zinc-800 bg-zinc-950/60 p-5">
                                      <div class="flex items-start justify-between gap-4">
                                        <div>
                                          <p class="text-sm font-semibold text-zinc-100">{scenario.label}</p>
                                          <p class="mt-1 text-xs text-zinc-500">{scenario.simulations} simulations</p>
                                        </div>
                                        <p class="rounded-sm border border-zinc-800 px-3 py-1 text-xs text-zinc-300">
                                          Worse DD vs base: {formatPercent(scenario.worse_than_base_drawdown_rate)}
                                        </p>
                                      </div>

                                      <div class="mt-4 grid gap-3 sm:grid-cols-2">
                                        <MetricCard
                                          label="PnL p05 / med / p95"
                                          value={formatDistribution(
                                            scenario.total_pnl,
                                            (value) => formatCurrency(value, { signed: true }),
                                          )}
                                          hint={`Worst ${formatCurrency(scenario.total_pnl.worst, { signed: true })} · Best ${formatCurrency(scenario.total_pnl.best, { signed: true })}`}
                                        />
                                        <MetricCard
                                          label="Drawdown p05 / med / p95"
                                          value={formatDistribution(
                                            scenario.max_drawdown,
                                            (value) => formatPercent(value, 2),
                                          )}
                                          hint={`Worst ${formatPercent(scenario.max_drawdown.worst, 2)}`}
                                          tone={scenario.max_drawdown.p95 > analysis().baseline.max_drawdown ? "bad" : "default"}
                                        />
                                        <MetricCard
                                          label="Profitable sims"
                                          value={formatPercent(scenario.profitable_rate)}
                                          hint="Share of sims that still finish positive."
                                          tone={scenario.profitable_rate >= 0.5 ? "good" : "bad"}
                                        />
                                      </div>

                                      <p class="mt-4 text-sm text-zinc-400">{scenario.note}</p>
                                    </div>
                                  )}
                                </For>
                              </div>
                            </section>

                            <section class="app-panel app-panel-section space-y-5">
                              <div class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                                <div>
                                  <p class="app-kicker">Local Parameter Sweep</p>
                                </div>

                                <div class="grid gap-3 sm:grid-cols-3">
                                  <MetricCard
                                    label="Baseline Rank"
                                    value={formatRank(analysis().parameter_sweep.baseline_rank)}
                                    hint={analysis().parameter_sweep.ranking_rule}
                                  />
                                  <MetricCard
                                    label="Profitable Runs"
                                    value={formatPercent(analysis().parameter_sweep.profitable_rate)}
                                    hint={`${analysis().parameter_sweep.total_runs} tested`}
                                    tone={analysis().parameter_sweep.profitable_rate >= 0.5 ? "good" : "bad"}
                                  />
                                  <MetricCard
                                    label="Passing Runs"
                                    value={formatPercent(analysis().parameter_sweep.passing_rate)}
                                    hint="Share that still pass the prop rules."
                                    tone={analysis().parameter_sweep.passing_rate >= 0.5 ? "good" : "bad"}
                                  />
                                </div>
                              </div>

                              <p class="text-sm text-zinc-400">{analysis().parameter_sweep.note}</p>

                              <div class="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950/60">
                                <table class="min-w-full text-sm">
                                  <thead class="border-b border-zinc-800 text-left text-xs uppercase tracking-[0.18em] text-zinc-500">
                                    <tr>
                                      <th class="px-3 py-3">Rank</th>
                                      <th class="px-3 py-3">Params</th>
                                      <th class="px-3 py-3">Score</th>
                                      <th class="px-3 py-3">PnL</th>
                                      <th class="px-3 py-3">DD</th>
                                      <th class="px-3 py-3">PF</th>
                                      <th class="px-3 py-3">Prop</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    <For each={analysis().parameter_sweep.top_runs}>
                                      {(run) => (
                                        <tr class="border-t border-zinc-800">
                                          <td class="px-3 py-3 text-zinc-400">#{run.rank}</td>
                                          <td class="px-3 py-3 text-zinc-100">{formatParamSummary(run.params)}</td>
                                          <td class="px-3 py-3 font-mono text-zinc-200">{run.score.toFixed(2)}</td>
                                          <td class={`px-3 py-3 font-mono ${run.total_pnl >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                                            {formatCurrency(run.total_pnl, { signed: true })}
                                          </td>
                                          <td class="px-3 py-3 font-mono text-zinc-300">{formatPercent(run.max_drawdown, 2)}</td>
                                          <td class="px-3 py-3 font-mono text-zinc-300">{formatRatio(run.profit_factor)}</td>
                                          <td class="px-3 py-3">
                                            <span class={`rounded-sm border px-2 py-1 text-xs ${run.passed ? "border-emerald-800 text-emerald-300" : "border-red-800 text-red-300"}`}>
                                              {run.passed ? "Pass" : "Fail"}
                                            </span>
                                          </td>
                                        </tr>
                                      )}
                                    </For>
                                  </tbody>
                                </table>
                              </div>

                              <Show when={analysis().parameter_sweep.bottom_run}>
                                {(run) => (
                                  <div class="rounded-md border border-zinc-800 bg-zinc-950/40 px-4 py-4">
                                    <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">
                                      Soft Spot
                                    </p>
                                    <p class="mt-2 text-sm text-zinc-300">
                                      Weakest nearby run {formatRank(run().rank)} scored{" "}
                                      <span class="font-mono text-zinc-100">
                                        {run().score.toFixed(2)}
                                      </span>{" "}
                                      with {formatCurrency(run().total_pnl, { signed: true })} and{" "}
                                      {formatPercent(run().max_drawdown, 2)} drawdown.
                                    </p>
                                    <p class="mt-2 text-sm text-zinc-500">
                                      {formatParamSummary(run().params)}
                                    </p>
                                  </div>
                                )}
                              </Show>
                            </section>

                            <section class="app-panel app-panel-section space-y-5">
                              <div class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                                <div>
                                  <p class="app-kicker">Walk-Forward</p>
                                  <p class="max-w-3xl text-sm text-zinc-300">
                                    Train chunk selects params; next chunk scores them out of sample.
                                  </p>
                                </div>

                                <div class="grid gap-3 sm:grid-cols-3">
                                  <MetricCard
                                    label="Folds Completed"
                                    value={`${analysis().walk_forward.folds_completed}/${analysis().walk_forward.folds_requested}`}
                                  />
                                  <MetricCard
                                    label="Avg Test PnL"
                                    value={formatCurrency(analysis().walk_forward.average_test_pnl, { signed: true })}
                                    tone={analysis().walk_forward.average_test_pnl >= 0 ? "good" : "bad"}
                                  />
                                  <MetricCard
                                    label="Passing Folds"
                                    value={formatPercent(analysis().walk_forward.passing_rate)}
                                    tone={analysis().walk_forward.passing_rate >= 0.5 ? "good" : "bad"}
                                  />
                                </div>
                              </div>

                              <p class="text-sm text-zinc-400">{analysis().walk_forward.note}</p>

                              <Show
                                when={analysis().walk_forward.folds.length > 0}
                                fallback={
                                  <div class="rounded-md border border-zinc-800 bg-zinc-950/40 px-4 py-5">
                                    <p class="text-sm text-zinc-400">
                                      This saved run doesn't have enough bars for a useful walk-forward split yet.
                                    </p>
                                  </div>
                                }
                              >
                                <div class="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950/60">
                                  <table class="min-w-full text-sm">
                                    <thead class="border-b border-zinc-800 text-left text-xs uppercase tracking-[0.18em] text-zinc-500">
                                      <tr>
                                        <th class="px-3 py-3">Fold</th>
                                        <th class="px-3 py-3">Train</th>
                                        <th class="px-3 py-3">Test</th>
                                        <th class="px-3 py-3">Selected Params</th>
                                        <th class="px-3 py-3">Train Score</th>
                                        <th class="px-3 py-3">Test Score</th>
                                        <th class="px-3 py-3">Test PnL</th>
                                        <th class="px-3 py-3">Test DD</th>
                                        <th class="px-3 py-3">Trades</th>
                                        <th class="px-3 py-3">Prop</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      <For each={analysis().walk_forward.folds}>
                                        {(fold) => (
                                          <tr class="border-t border-zinc-800">
                                            <td class="px-3 py-3 text-zinc-400">#{fold.fold_index}</td>
                                            <td class="px-3 py-3 text-zinc-300">
                                              {new Date(fold.train_start).toLocaleDateString()} → {new Date(fold.train_end).toLocaleDateString()}
                                            </td>
                                            <td class="px-3 py-3 text-zinc-300">
                                              {new Date(fold.test_start).toLocaleDateString()} → {new Date(fold.test_end).toLocaleDateString()}
                                            </td>
                                            <td class="px-3 py-3 text-zinc-100">{formatParamSummary(fold.selected_params)}</td>
                                            <td class="px-3 py-3 font-mono text-zinc-300">{fold.train_score.toFixed(2)}</td>
                                            <td class="px-3 py-3 font-mono text-zinc-300">{fold.test_score.toFixed(2)}</td>
                                            <td class={`px-3 py-3 font-mono ${fold.test_total_pnl >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                                              {formatCurrency(fold.test_total_pnl, { signed: true })}
                                            </td>
                                            <td class="px-3 py-3 font-mono text-zinc-300">{formatPercent(fold.test_max_drawdown, 2)}</td>
                                            <td class="px-3 py-3 font-mono text-zinc-300">{formatCount(fold.test_trades)}</td>
                                            <td class="px-3 py-3">
                                              <span class={`rounded-sm border px-2 py-1 text-xs ${fold.test_passed ? "border-emerald-800 text-emerald-300" : "border-red-800 text-red-300"}`}>
                                                {fold.test_passed ? "Pass" : "Fail"}
                                              </span>
                                            </td>
                                          </tr>
                                        )}
                                      </For>
                                    </tbody>
                                  </table>
                                </div>
                              </Show>
                            </section>
                          </>
                        )}
                      </Show>
                    }>
                    {(error) => (
                      <section class="app-panel app-panel-section">
                        <p class="text-sm text-red-400">
                          Robustness analysis failed: {error().message}
                        </p>
                      </section>
                    )}
                  </Show>
                </div>
              </Match>

              <Match when={activeTab() === "trades"}>
                <div class="space-y-6">
                  <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <For each={tradesSummaryCards()}>
                      {([label, value]) => <MetricCard label={label} value={value} />}
                    </For>
                  </div>

                  <TradesTable title="System Trades" trades={bt().trades} />
                </div>
              </Match>
            </Switch>
          </div>
        )}
      </Show>
    </AppShell>
  );
}
