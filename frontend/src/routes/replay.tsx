import { A, useNavigate, useParams, useSearchParams } from "@solidjs/router";
import {
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  onCleanup,
  Show,
} from "solid-js";
import { ChevronDown, ChevronRight, CircleCheck, CircleX, TriangleAlert } from "lucide-solid";
import AppShell from "../components/AppShell";
import ChartIndicatorToggleBar from "../components/ChartIndicatorToggleBar";
import EquityCurve from "../components/EquityCurve";
import PriceChart, { type PriceChartMarker } from "../components/PriceChart";
import {
  ReplayChartStrip,
  ReplayExecutionActions,
  ReplayTimelineControls,
} from "../components/ReplayControls";
import {
  BACKTEST_INTERVALS,
  DATABENTO_SYMBOLS,
  getBackendInterval,
  type Interval,
} from "../constants";
import {
  createReplaySession,
  fetchBacktest,
  fetchBacktestCandles,
  fetchCandles,
  fetchPropPresets,
  fetchReplaySession,
  fetchSymbols,
  updateReplaySession,
  type BacktestResult,
  type Candle,
  type PropFirmEvaluation,
  type PropFirmRules,
  type ReplaySessionPayload,
  type ReplaySessionSourceBacktest,
  type SymbolInfo,
  type Trade,
} from "../services/api";
import {
  clampReplayIndex,
  findJumpTarget,
  getReplayIndexFromProgress,
  getReplayProgress,
  simulateReplaySession,
  type ReplayAction,
} from "../services/replaySimulator";
import {
  formatReplaySessionStatus,
  getReplaySessionStatus,
} from "../services/replaySessionState";
import {
  defaultPriceChartIndicatorSettings,
  type PriceChartIndicatorSettings,
} from "../services/chartIndicators";
import WorkspaceLaunchControl from "../components/workspace/WorkspaceLaunchControl";
import {
  loadActiveWorkspaceContext,
  type WorkspaceLaunchIntent,
} from "../components/workspace/workspacePersistence";
import {
  defaultExecutionConfigForSymbol,
  normalizeRestingFillMode,
} from "../services/executionModel";
import { buildReplayExecutionAnalytics } from "../services/executionAnalytics";
import { formatTradeLabel } from "../services/tradeFormatting";

const field =
  "app-input w-full text-sm disabled:opacity-40";
const label = "block mb-1 text-xs text-zinc-400";
const section = "app-panel app-panel-section space-y-4";
const SESSION_LIMIT = 10_000;

const tickValueBySymbol = Object.fromEntries(
  DATABENTO_SYMBOLS.map((symbol) => [symbol.key, symbol.tickValue]),
) as Record<string, number>;

type ReplayLaunchConfig = {
  mode: "standalone" | "backtest";
  symbol: SymbolInfo;
  interval: Interval;
  propFirmRules: PropFirmRules;
  startDate?: string;
  endDate?: string;
  commission: number;
  tickValue: number;
  tickSize: number;
  positionSize: number;
  spreadTicks: number;
  volatileBarThresholdTicks: number;
  volatileBarExtraTicks: number;
  restingFillMode: "touch" | "penetrate" | "touch_plus_1_bar";
  sourceBacktest?: ReplaySessionSourceBacktest | null;
  candleSource: { kind: "db" } | { kind: "backtest"; backtestId: string };
};

function formatCurrency(value: number): string {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
}

function formatTradePnl(value: number): string {
  return `${value >= 0 ? "+" : ""}$${value.toFixed(2)}`;
}

function formatTicks(value?: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "n/a";
  }
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}t`;
}

function markerTimeFromIso(value: string): number {
  return Math.floor(new Date(value).getTime() / 1000);
}

function createReplayAction(
  type: ReplayAction["type"],
  barIndex: number,
  fields: Partial<Pick<ReplayAction, "price" | "stopPrice" | "targetPrice">> = {},
): ReplayAction {
  return {
    id: `${type}_${barIndex}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    barIndex,
    createdAt: Date.now(),
    ...fields,
  };
}

function propEvalTone(passed: boolean): string {
  return passed ? "border-green-700 bg-green-950" : "border-red-700 bg-red-950";
}

function groupPresets(presets: PropFirmRules[]): Record<string, PropFirmRules[]> {
  return presets.reduce<Record<string, PropFirmRules[]>>((acc, preset) => {
    let firm = preset.name.split(/\s+\d/)[0].trim();
    firm = firm
      .replace(/^My Funded Futures (Rapid|Flex)?/i, "My Funded Futures")
      .replace(/^Lucid Trading /i, "Lucid Trading")
      .trim();
    (acc[firm] ??= []).push(preset);
    return acc;
  }, {});
}

function findPresetByPropFirm(presets: PropFirmRules[], propFirm: string): PropFirmRules | null {
  const cleanedFirm = propFirm.trim().toLowerCase();
  if (!cleanedFirm) {
    return null;
  }

  return presets.find((preset) => preset.name.toLowerCase().includes(cleanedFirm)) ?? null;
}

function findInterval(value: string): Interval {
  return (
    BACKTEST_INTERVALS.find(
      (interval) =>
        interval.value === value || getBackendInterval(interval).toLowerCase() === value.toLowerCase(),
    ) ?? BACKTEST_INTERVALS.find((interval) => interval.value === "15m")!
  );
}

function defaultSessionName(config: ReplayLaunchConfig): string {
  const range =
    config.startDate || config.endDate
      ? `${config.startDate || "earliest"} to ${config.endDate || "latest"}`
      : "full range";
  const sourceLabel = config.sourceBacktest
    ? ` vs ${config.sourceBacktest.backtest_id.slice(0, 8)}`
    : "";
  return `${config.symbol.symbol} ${config.interval.label} replay${sourceLabel} (${range})`;
}

function formatDailyLossLimit(limit: number | null | undefined): string {
  if (limit == null || limit === 0) {
    return "Off";
  }

  return `${(limit * 100).toFixed(0)}%`;
}

function buildSourceBacktest(backtest: BacktestResult): ReplaySessionSourceBacktest {
  return {
    backtest_id: backtest.backtest_id,
    symbol: backtest.symbol ?? backtest.replay_context?.symbol ?? undefined,
    interval: backtest.replay_context?.interval ?? undefined,
    start_date: backtest.replay_context?.start_date ?? undefined,
    end_date: backtest.replay_context?.end_date ?? undefined,
    strategy_type: backtest.strategy.type,
  };
}

function resolveReplaySymbolInfo(args: {
  symbol: string;
  loadedSymbols?: SymbolInfo[];
  startDate?: string;
  endDate?: string;
}): SymbolInfo {
  const matched = args.loadedSymbols?.find((item) => item.symbol === args.symbol);
  if (matched) {
    return matched;
  }

  return {
    symbol: args.symbol,
    full_name: `${args.symbol} saved source`,
    exchange: "Saved",
    tick_size: 0.25,
    tick_value: tickValueBySymbol[args.symbol] ?? 1,
    rows: 0,
    start_date: args.startDate ?? "",
    end_date: args.endDate ?? "",
  };
}

function PropEvalPanel(props: {
  title: string;
  evaluation: PropFirmEvaluation;
  children?: JSX.Element;
}) {
  const minTradingDaysPassed = () => props.evaluation.min_trading_days_passed ?? true;

  return (
    <div class={`rounded-lg border p-4 ${propEvalTone(props.evaluation.passed)}`}>
      <div class="mb-2 flex items-center gap-2">
        {props.evaluation.passed ? (
          <CircleCheck class="text-green-400" />
        ) : (
          <CircleX size={18} class="text-red-400" />
        )}
        <p class="font-semibold">
          {props.title}: {props.evaluation.passed ? "Passed" : "Failed"}
        </p>
      </div>

      <Show when={!props.evaluation.passed}>
        <ul class="mt-2 space-y-1 text-sm text-red-300">
          <Show when={props.evaluation.daily_loss_breached}>
            <li class="flex items-center gap-1.5">
              <TriangleAlert size={13} /> Daily loss limit breached
            </li>
          </Show>
          <Show when={props.evaluation.drawdown_breached}>
            <li class="flex items-center gap-1.5">
              <TriangleAlert size={13} /> Max drawdown breached
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

      <Show when={props.children}>
        <div class="mt-4 border-t border-current/20 pt-3">{props.children}</div>
      </Show>
    </div>
  );
}

function ReplayStatCard(props: {
  label: string;
  value: string;
  tone?: "default" | "good" | "bad";
  detail?: string;
}) {
  return (
    <div class="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-4">
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
      <Show when={props.detail}>
        <p class="mt-2 text-xs text-zinc-500">{props.detail}</p>
      </Show>
    </div>
  );
}

function ReplayAccordionSection(props: {
  index: string;
  title: string;
  subtitle: string;
  meta?: string;
  open: boolean;
  onToggle: () => void;
  children?: JSX.Element;
}) {
  return (
    <section class="app-panel app-panel-section h-full space-y-4">
      <button
        type="button"
        class="flex w-full items-start justify-between gap-4 rounded-2xl border border-zinc-800/80 bg-zinc-950/55 px-4 py-3 text-left transition-colors hover:border-zinc-700 hover:bg-zinc-950/80"
        aria-expanded={props.open}
        aria-label={`${props.open ? "Collapse" : "Expand"} ${props.title.toLowerCase()} section`}
        onClick={props.onToggle}
      >
        <div class="space-y-1">
          <p class="text-sm font-semibold text-zinc-100">
            {props.index}. {props.title}
          </p>
          <p class="text-xs text-zinc-400">{props.subtitle}</p>
        </div>

        <div class="flex items-center gap-2">
          <Show when={props.meta}>
            <span class="rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-zinc-400">
              {props.meta}
            </span>
          </Show>
          {props.open ? (
            <ChevronDown size={16} class="mt-1 shrink-0 text-zinc-500" />
          ) : (
            <ChevronRight size={16} class="mt-1 shrink-0 text-zinc-500" />
          )}
        </div>
      </button>

      <Show when={props.open}>
        <div class="space-y-4">{props.children}</div>
      </Show>
    </section>
  );
}

export default function ReplayLabPage() {
  const params = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams<{ backtestId?: string }>();
  const navigate = useNavigate();
  const workspaceContext = createMemo(() => loadActiveWorkspaceContext());
  const [symbols] = createResource(fetchSymbols);
  const [presets] = createResource(fetchPropPresets);
  const [savedSession] = createResource(() => params.id, fetchReplaySession);
  const sourceBacktestId = createMemo(() =>
    params.id ? null : searchParams.backtestId?.trim() || null,
  );
  const [sourceBacktest] = createResource(sourceBacktestId, fetchBacktest);

  const defaultInterval = BACKTEST_INTERVALS.find((interval) => interval.value === "15m")!;
  const [sessionId, setSessionId] = createSignal<string | null>(params.id ?? null);
  const [sessionName, setSessionName] = createSignal("");
  const [symbol, setSymbol] = createSignal<SymbolInfo | null>(null);
  const [interval, setInterval] = createSignal(defaultInterval);
  const [preset, setPreset] = createSignal<PropFirmRules | null>(null);
  const [startDate, setStartDate] = createSignal("");
  const [endDate, setEndDate] = createSignal("");
  const [positionSize, setPositionSize] = createSignal(1);
  const [bannerError, setBannerError] = createSignal<string | null>(null);
  const [bannerNotice, setBannerNotice] = createSignal<string | null>(null);
  const [workspaceSeedNotice, setWorkspaceSeedNotice] = createSignal<string | null>(null);
  const [launchConfig, setLaunchConfig] = createSignal<ReplayLaunchConfig | null>(null);
  const [isSaving, setIsSaving] = createSignal(false);
  const [setupExpanded, setSetupExpanded] = createSignal(true);
  const [rulesExpanded, setRulesExpanded] = createSignal(true);

  const [isReplayActive, setIsReplayActive] = createSignal(false);
  const [isReviewMode, setIsReviewMode] = createSignal(false);
  const [speed, setSpeed] = createSignal(8);
  const [currentIndex, setCurrentIndex] = createSignal(0);
  const [replayActions, setReplayActions] = createSignal<ReplayAction[]>([]);
  const [bracketStopPrice, setBracketStopPrice] = createSignal("");
  const [bracketTargetPrice, setBracketTargetPrice] = createSignal("");
  const [indicatorSettings, setIndicatorSettings] = createSignal(
    defaultPriceChartIndicatorSettings(),
  );

  let hydratedSessionId: string | null = null;
  let hydratedSourceBacktestId: string | null = null;

  const [candles] = createResource(launchConfig, async (config) =>
    config.candleSource.kind === "backtest"
      ? fetchBacktestCandles(config.candleSource.backtestId, SESSION_LIMIT)
      : fetchCandles({
          symbol: config.symbol.symbol,
          interval: getBackendInterval(config.interval),
          startDate: config.startDate,
          endDate: config.endDate,
          limit: SESSION_LIMIT,
        }),
  );

  createEffect(() => {
    const loadedSymbols = symbols();
    if (!symbol() && loadedSymbols && loadedSymbols.length > 0) {
      setSymbol(loadedSymbols[0]);
    }
  });

  createEffect(() => {
    const loadedPresets = presets();
    if (!preset() && loadedPresets && loadedPresets.length > 0) {
      setPreset(loadedPresets[0]);
    }
  });

  let seededStandaloneDefaults = false;
  createEffect(() => {
    if (
      seededStandaloneDefaults ||
      params.id ||
      sourceBacktestId() ||
      sourceBacktest() ||
      launchConfig()
    ) {
      return;
    }

    const loadedSymbols = symbols();
    const loadedPresets = presets();
    if (!loadedSymbols || loadedSymbols.length === 0 || !loadedPresets || loadedPresets.length === 0) {
      return;
    }

    seededStandaloneDefaults = true;
    const context = workspaceContext();
    if (!context) {
      return;
    }

    const query = context.query;
    const preferredSymbol = query?.symbol
      ? loadedSymbols.find((candidate) => candidate.symbol === query.symbol)
      : null;
    const preferredInterval = query?.interval ? findInterval(query.interval) : null;
    const preferredPreset = context.accountProfile.propFirm
      ? findPresetByPropFirm(loadedPresets, context.accountProfile.propFirm)
      : null;

    batch(() => {
      if (preferredSymbol) {
        setSymbol(preferredSymbol);
      }
      if (preferredInterval) {
        setInterval(preferredInterval);
      }
      if (query?.mode === "historical") {
        setStartDate(query.startDate ?? "");
        setEndDate(query.endDate ?? "");
      }
      if (preferredPreset) {
        setPreset(preferredPreset);
      }
      if (preferredSymbol || preferredInterval || preferredPreset || query?.mode === "historical") {
        setWorkspaceSeedNotice(`Seeded setup defaults from ${context.workspaceName}.`);
      }
    });
  });

  createEffect(() => {
    const existing = savedSession();
    const loadedSymbols = symbols() ?? [];
    if (!existing || hydratedSessionId === existing.replay_session_id) {
      return;
    }

    const matchedSymbol = resolveReplaySymbolInfo({
      symbol: existing.symbol,
      loadedSymbols,
      startDate: existing.start_date ?? undefined,
      endDate: existing.end_date ?? undefined,
    });
    const resolvedInterval = findInterval(existing.interval);
    const sourceBacktest = existing.source_backtest;
    const executionDefaults = defaultExecutionConfigForSymbol(existing.symbol);

    hydratedSessionId = existing.replay_session_id;
    batch(() => {
      setSessionId(existing.replay_session_id);
      setSessionName(existing.name);
      setSymbol(matchedSymbol ?? null);
      setInterval(resolvedInterval);
      setPreset(existing.prop_firm_rules);
      setStartDate(existing.start_date ?? "");
      setEndDate(existing.end_date ?? "");
      setPositionSize(existing.position_size ?? 1);
      setSpeed(8);
      setIsReplayActive(false);
      setIsReviewMode(existing.status === "review");
      setCurrentIndex(existing.current_bar_index);
      setReplayActions(
        existing.actions.map((action) => ({
          id: action.id,
          type: action.type,
          barIndex: action.bar_index,
          createdAt: action.created_at,
          price: action.price,
          stopPrice: action.stop_price,
          targetPrice: action.target_price,
        })),
      );
      setLaunchConfig({
        mode: sourceBacktest?.backtest_id ? "backtest" : "standalone",
        symbol: matchedSymbol,
        interval: resolvedInterval,
        propFirmRules: existing.prop_firm_rules,
        startDate: existing.start_date ?? undefined,
        endDate: existing.end_date ?? undefined,
        commission: existing.commission,
        tickValue: existing.tick_value,
        tickSize: existing.tick_size ?? matchedSymbol.tick_size ?? 0.25,
        positionSize: existing.position_size ?? 1,
        spreadTicks: existing.spread_ticks ?? executionDefaults.spreadTicks,
        volatileBarThresholdTicks:
          existing.volatile_bar_threshold_ticks ?? 0,
        volatileBarExtraTicks:
          existing.volatile_bar_extra_ticks ?? 0,
        restingFillMode: normalizeRestingFillMode(existing.resting_fill_mode),
        sourceBacktest,
        candleSource: sourceBacktest?.backtest_id
          ? { kind: "backtest", backtestId: sourceBacktest.backtest_id }
          : { kind: "db" },
      });
      setBannerError(null);
      setBannerNotice(`Loaded saved session "${existing.name}".`);
    });
  });

  createEffect(() => {
    const source = sourceBacktest();
    if (!source || params.id || hydratedSourceBacktestId === source.backtest_id) {
      return;
    }

    const replaySymbol = source.symbol || source.replay_context?.symbol;
    if (!replaySymbol) {
      setBannerError("This saved backtest is missing symbol context, so it can't launch a sim yet.");
      return;
    }

    hydratedSourceBacktestId = source.backtest_id;
    const resolvedInterval = findInterval(source.replay_context?.interval ?? "15min");
    const start = source.replay_context?.start_date ?? undefined;
    const end = source.replay_context?.end_date ?? undefined;
    const resolvedSymbol = resolveReplaySymbolInfo({
      symbol: replaySymbol,
      loadedSymbols: symbols() ?? [],
      startDate: start,
      endDate: end,
    });
    const sourceMeta = buildSourceBacktest(source);
    const commission = source.trades[0]?.commission ?? 5;
    const tickValue =
      tickValueBySymbol[replaySymbol] ?? resolvedSymbol.tick_value ?? 1;
    const sourcePositionSize = source.run_config?.position_size ?? 1;
    const executionDefaults = defaultExecutionConfigForSymbol(replaySymbol);

    batch(() => {
      setSessionId(null);
      setSessionName((previous) =>
        previous ||
        defaultSessionName({
          mode: "backtest",
          symbol: resolvedSymbol,
          interval: resolvedInterval,
          propFirmRules: source.prop_firm_rules,
          startDate: start,
          endDate: end,
          commission,
          tickValue,
          tickSize: source.run_config?.tick_size ?? resolvedSymbol.tick_size ?? 0.25,
          positionSize: sourcePositionSize,
          spreadTicks: executionDefaults.spreadTicks,
          volatileBarThresholdTicks: executionDefaults.volatileBarThresholdTicks,
          volatileBarExtraTicks: executionDefaults.volatileBarExtraTicks,
          restingFillMode: executionDefaults.restingFillMode,
          sourceBacktest: sourceMeta,
          candleSource: { kind: "backtest", backtestId: source.backtest_id },
        }),
      );
      setSymbol(resolvedSymbol);
      setInterval(resolvedInterval);
      setPreset(source.prop_firm_rules);
      setStartDate(start ?? "");
      setEndDate(end ?? "");
      setIsReplayActive(false);
      setIsReviewMode(false);
      setSpeed(8);
      setCurrentIndex(0);
      setReplayActions([]);
      setLaunchConfig({
        mode: "backtest",
        symbol: resolvedSymbol,
        interval: resolvedInterval,
        propFirmRules: source.prop_firm_rules,
        startDate: start,
        endDate: end,
        commission,
        tickValue,
        tickSize: source.run_config?.tick_size ?? resolvedSymbol.tick_size ?? 0.25,
        positionSize: sourcePositionSize,
        spreadTicks: executionDefaults.spreadTicks,
        volatileBarThresholdTicks: executionDefaults.volatileBarThresholdTicks,
        volatileBarExtraTicks: executionDefaults.volatileBarExtraTicks,
        restingFillMode: executionDefaults.restingFillMode,
        sourceBacktest: sourceMeta,
        candleSource: { kind: "backtest", backtestId: source.backtest_id },
      });
      setBannerError(null);
      setBannerNotice(`Loaded backtest "${source.backtest_id.slice(0, 8)}" into simulated-live mode.`);
    });
  });

  createEffect(() => {
    const candleList = candles();
    if (!isReplayActive() || !candleList || candleList.length === 0) {
      return;
    }

    const intervalMs = Math.max(50, Math.round(1000 / speed()));
    const timer = window.setInterval(() => {
      setCurrentIndex((previous) => {
        const capped = clampReplayIndex(previous, candleList.length);
        if (capped >= candleList.length - 1) {
          setIsReplayActive(false);
          return candleList.length - 1;
        }
        return capped + 1;
      });
    }, intervalMs);

    onCleanup(() => window.clearInterval(timer));
  });

  const totalBars = createMemo(() => candles()?.length ?? 0);
  const replayIndex = createMemo(() => clampReplayIndex(currentIndex(), totalBars()));
  const replayProgress = createMemo(() => getReplayProgress(replayIndex(), totalBars()));
  const currentCandle = createMemo<Candle | undefined>(() => candles()?.[replayIndex()]);
  const hasLaunch = createMemo(() => !!launchConfig());

  createEffect(() => {
    if (!hasLaunch()) {
      return;
    }

    setSetupExpanded(false);
    setRulesExpanded(false);
  });

  const replayTradeEntryIndices = createMemo(() =>
    Array.from(
      new Set(
        replayActions()
          .filter((action) =>
            ["buy", "sell", "lift_ask", "hit_bid", "join_bid", "join_ask"].includes(action.type),
          )
          .map((action) => action.barIndex)
          .sort((a, b) => a - b),
      ),
    ),
  );

  const replaySession = createMemo(() => {
    const config = launchConfig();
    const candleList = candles();
    if (!config || !candleList || candleList.length === 0) {
      return null;
    }

    return simulateReplaySession({
      candles: candleList,
      currentIndex: replayIndex(),
      actions: replayActions(),
      initialBalance: config.propFirmRules.account_size,
      commission: config.commission,
      tickValue: config.tickValue,
      tickSize: config.tickSize,
      positionSize: config.positionSize,
      spreadTicks: config.spreadTicks,
      volatileBarThresholdTicks: config.volatileBarThresholdTicks,
      volatileBarExtraTicks: config.volatileBarExtraTicks,
      restingFillMode: config.restingFillMode,
      propFirmRules: config.propFirmRules,
    });
  });
  const activeOrders = createMemo(() => replaySession()?.activeOrders ?? []);

  const isSessionComplete = createMemo(() => {
    const session = replaySession();
    return totalBars() > 0 && replayIndex() >= totalBars() - 1 && !session?.position;
  });

  const replayStatus = createMemo(() =>
    getReplaySessionStatus({
      hasLaunch: hasLaunch(),
      isPlaying: isReplayActive(),
      isComplete: isSessionComplete(),
      isReviewMode: isReviewMode(),
    }),
  );

  const canEditSetup = createMemo(() => !hasLaunch());
  const canUnlockReview = createMemo(() => isSessionComplete() && !isReviewMode());
  const canSeek = createMemo(() => isReviewMode());
  const canStartPlayback = createMemo(
    () => !isReviewMode() && replayIndex() < totalBars() - 1,
  );
  const canStepBack = createMemo(
    () => isReviewMode() && !isReplayActive() && replayIndex() > 0,
  );
  const canStepForward = createMemo(
    () => !isReplayActive() && replayIndex() < totalBars() - 1,
  );
  const canJumpPrevTrade = createMemo(
    () =>
      isReviewMode() &&
      findJumpTarget(replayIndex(), replayTradeEntryIndices(), "prev") !== null,
  );
  const canJumpNextTrade = createMemo(
    () =>
      isReviewMode() &&
      findJumpTarget(replayIndex(), replayTradeEntryIndices(), "next") !== null,
  );
  const canPlaceEntries = createMemo(
    () =>
      !isReviewMode() &&
      replayIndex() < totalBars() - 1 &&
      !replaySession()?.position &&
      activeOrders().length === 0,
  );
  const canRestExit = createMemo(
    () =>
      !isReviewMode() &&
      replayIndex() < totalBars() - 1 &&
      !!replaySession()?.position &&
      activeOrders().length === 0,
  );
  const canAttachBracket = createMemo(
    () =>
      !isReviewMode() &&
      replayIndex() < totalBars() - 1 &&
      !!replaySession()?.position &&
      activeOrders().length === 0,
  );
  const canExitPosition = createMemo(
    () => !!replaySession()?.position && !isReviewMode(),
  );
  const canCancelOrder = createMemo(
    () => activeOrders().length > 0 && !isReviewMode(),
  );
  const canReplaceOrder = createMemo(
    () => activeOrders().length === 1 && replayIndex() < totalBars() - 1 && !isReviewMode(),
  );
  const replayStatusDetail = createMemo(() => {
    if (replayStatus() === "review") {
      return "The run is done, so you can scrub and study it without changing the paper trades.";
    }

    if (replayStatus() === "completed") {
      return "The sim is finished. Unlock review mode when you want full-chart inspection.";
    }

    if (replayStatus() === "active") {
      return "Future candles stay hidden while the session rolls forward bar by bar.";
    }

    if (replayStatus() === "paused") {
      return "The sim is paused at the current bar. You can step forward, trade, save, or restart.";
    }

    return "Pick a market window and launch a session to start the simulated-live run.";
  });

  const sessionSummary = createMemo(() => {
    const config = launchConfig();
    if (!config) {
      return [];
    }

    return [
      ["Session", sessionName() || defaultSessionName(config)],
      ["Source", config.sourceBacktest ? `Backtest ${config.sourceBacktest.backtest_id.slice(0, 8)}` : "Standalone"],
      ["Symbol", config.symbol.symbol],
      ["Interval", config.interval.label],
      ["Contracts", String(config.positionSize)],
      [
        "Range",
        config.startDate || config.endDate
          ? `${config.startDate || "Earliest"} to ${config.endDate || "Latest"}`
          : "Full available range",
      ],
      ["Rules", config.propFirmRules.name],
      ["Progress", totalBars() === 0 ? "0 / 0" : `${replayIndex() + 1} / ${totalBars()}`],
    ] as [string, string][];
  });

  const replayMetrics = createMemo(() => {
    const config = launchConfig();
    const session = replaySession();
    if (!session || !config) {
      return [];
    }

    return [
      ["Realized PnL", formatCurrency(session.realizedPnl)],
      ["Total PnL", formatCurrency(session.totalPnl)],
      ["Win Rate", `${(session.metrics.win_rate * 100).toFixed(1)}%`],
      ["Trades", String(session.metrics.total_trades)],
      ["Balance", `$${session.balance.toFixed(2)}`],
    ] as [string, string][];
  });

  const executionAnalytics = createMemo(() => {
    const config = launchConfig();
    const session = replaySession();
    const candleList = candles();
    if (!config || !session || !candleList) {
      return null;
    }

    return buildReplayExecutionAnalytics({
      candles: candleList,
      trades: session.trades,
      executionEvents: session.executionEvents,
      tickSize: config.tickSize,
      executionConfig: {
        tickSize: config.tickSize,
        spreadTicks: config.spreadTicks,
        volatileBarThresholdTicks: config.volatileBarThresholdTicks,
        volatileBarExtraTicks: config.volatileBarExtraTicks,
        restingFillMode: config.restingFillMode,
      },
    });
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

    return `${formatTradeLabel(session.position.side, session.position.quantity)} from $${session.position.entry_price.toFixed(2)} (${formatCurrency(session.position.unrealized_pnl)})`;
  });

  const bidAskLabel = createMemo(() => {
    const quote = replaySession()?.currentQuote;
    if (!quote) {
      return "No book";
    }
    const volatilityTag = quote.is_volatile ? " volatile" : "";
    return `$${quote.bid.toFixed(2)} / $${quote.ask.toFixed(2)} (${quote.spread_ticks}-tick${volatilityTag})`;
  });

  const activeOrderLabel = createMemo(() => {
    const orders = activeOrders();
    if (orders.length === 0) {
      return "None";
    }
    return orders
      .map((order) => {
        const armed = order.first_touch_bar_index !== undefined ? " [armed]" : "";
        const replaceTag = order.replace_count ? ` [replace ${order.replace_count}]` : "";
        const quantity = order.quantity;
        const role =
          order.bracket_role === "target"
            ? "TARGET"
            : order.bracket_role === "stop"
              ? "STOP"
              : order.intent === "exit"
                ? "EXIT"
                : "ENTRY";
        const sizeTag = quantity ? ` ${formatTradeLabel(order.side, quantity)}` : ` ${order.side.toUpperCase()}`;
        return `${role}${sizeTag} @ $${order.price.toFixed(2)}${armed}${replaceTag}`;
      })
      .join(" | ");
  });

  const activeSourceBacktest = createMemo(
    () => launchConfig()?.sourceBacktest ?? savedSession()?.source_backtest ?? null,
  );

  const compareHref = createMemo(() => {
    if (!sessionId() || !activeSourceBacktest()?.backtest_id || !isReviewMode()) {
      return null;
    }

    return `/replay/${sessionId()}/compare`;
  });

  const workspaceIntent = createMemo<WorkspaceLaunchIntent | null>(() => {
    const config = launchConfig();
    if (!config) {
      return null;
    }

    return {
      source: sessionId() ? "replay-session" : "replay-lab",
      symbol: config.symbol.symbol,
      interval: getBackendInterval(config.interval),
      startDate: config.startDate,
      endDate: config.endDate,
    };
  });

  const chartMarkers = createMemo<PriceChartMarker[]>(() => {
    const session = replaySession();
    if (!session) {
      return [];
    }

    const markers: PriceChartMarker[] = [];

    for (const trade of session.trades) {
      markers.push({
        time: markerTimeFromIso(trade.entry_time),
        position: trade.side === "buy" ? "belowBar" : "aboveBar",
        color: trade.side === "buy" ? "#22c55e" : "#fb7185",
        shape: trade.side === "buy" ? "arrowUp" : "arrowDown",
        text: `${formatTradeLabel(trade.side, trade.quantity)} @ ${trade.entry_price.toFixed(2)}`,
      });

      if (trade.exit_time) {
        const exitColor = trade.pnl >= 0 ? "#22c55e" : "#fb7185";
        markers.push({
          time: markerTimeFromIso(trade.exit_time),
          position: trade.side === "buy" ? "aboveBar" : "belowBar",
          color: exitColor,
          shape: "square",
          text: `EXIT ${formatTradePnl(trade.pnl)}`,
        });
      }
    }

    if (session.position && currentCandle()) {
      markers.push({
        time: Number(currentCandle()!.time),
        position: session.position.side === "buy" ? "belowBar" : "aboveBar",
        color: session.position.side === "buy" ? "#34d399" : "#f43f5e",
        shape: "circle",
        text: `OPEN ${formatTradeLabel(session.position.side, session.position.quantity)} ${formatCurrency(session.position.unrealized_pnl)}`,
      });
    }

    return markers;
  });

  const canLaunch = createMemo(
    () =>
      !!symbol() &&
      !!preset() &&
      !symbols.loading &&
      !presets.loading &&
      !savedSession.loading,
  );

  const canSave = createMemo(
    () => !!launchConfig() && !!replaySession() && !candles.loading && !isSaving() && !isReplayActive(),
  );

  let announcedComplete = false;

  createEffect(() => {
    const complete = isSessionComplete();
    if (!complete) {
      announcedComplete = false;
      return;
    }

    if (announcedComplete) {
      return;
    }

    announcedComplete = true;
    setBannerNotice("Sim run finished. Unlock review mode whenever you want to inspect the whole session.");
  });

  const seekToIndex = (nextIndex: number) => {
    batch(() => {
      setIsReplayActive(false);
      setCurrentIndex(clampReplayIndex(nextIndex, totalBars()));
    });
  };

  const recordReplayAction = (
    type: ReplayAction["type"],
    fields: Partial<Pick<ReplayAction, "price" | "stopPrice" | "targetPrice">> = {},
  ) => {
    if (!candles() || totalBars() === 0 || isReviewMode()) {
      return;
    }

    if (
      ["lift_ask", "hit_bid", "join_bid", "join_ask", "rest_exit", "attach_bracket", "replace", "buy", "sell"].includes(type) &&
      replayIndex() >= totalBars() - 1
    ) {
      return;
    }

    setBannerNotice(null);
    setIsReplayActive(false);
    setReplayActions((previous) => [...previous, createReplayAction(type, replayIndex(), fields)]);
  };

  const attachReplayBracket = () => {
    const stopPrice = Number(bracketStopPrice().trim());
    const targetPrice = Number(bracketTargetPrice().trim());
    if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
      setBannerError("Bracket stop needs a real price.");
      return;
    }
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
      setBannerError("Bracket target needs a real price.");
      return;
    }

    const session = replaySession();
    const quote = session?.currentQuote;
    const position = session?.position;
    if (!position || !quote) {
      setBannerError("Open a position first so the bracket has something to protect.");
      return;
    }

    if (position.side === "buy") {
      if (stopPrice >= quote.reference) {
        setBannerError("Long brackets need the stop below the current reference price.");
        return;
      }
      if (targetPrice <= quote.reference) {
        setBannerError("Long brackets need the target above the current reference price.");
        return;
      }
    } else {
      if (stopPrice <= quote.reference) {
        setBannerError("Short brackets need the stop above the current reference price.");
        return;
      }
      if (targetPrice >= quote.reference) {
        setBannerError("Short brackets need the target below the current reference price.");
        return;
      }
    }

    setBannerError(null);
    recordReplayAction("attach_bracket", {
      stopPrice: Number(stopPrice.toFixed(4)),
      targetPrice: Number(targetPrice.toFixed(4)),
    });
    setBracketStopPrice("");
    setBracketTargetPrice("");
  };

  const jumpToTrade = (direction: "next" | "prev") => {
    if (!isReviewMode()) {
      return;
    }

    const target = findJumpTarget(replayIndex(), replayTradeEntryIndices(), direction);
    if (target !== null) {
      seekToIndex(target);
    }
  };

  const toggleIndicator = (key: keyof PriceChartIndicatorSettings) => {
    setIndicatorSettings((current) => ({
      ...current,
      [key]: !current[key],
    }));
  };

  const launchReplay = () => {
    const selectedSymbol = symbol();
    const selectedPreset = preset();
    if (!selectedSymbol) {
      setBannerError("Select a symbol to launch a standalone replay session.");
      return;
    }
    if (!selectedPreset) {
      setBannerError("Select a prop-firm ruleset to evaluate the replay against.");
      return;
    }
    if (startDate() && endDate() && startDate() > endDate()) {
      setBannerError("Start date must be before end date.");
      return;
    }
    if (!Number.isFinite(positionSize()) || positionSize() <= 0) {
      setBannerError("Contracts needs to be a real positive number.");
      return;
    }

    setBannerError(null);
    setBannerNotice(null);
    batch(() => {
      const executionDefaults = defaultExecutionConfigForSymbol(selectedSymbol.symbol);
      setIsReplayActive(false);
      setIsReviewMode(false);
      setSpeed(8);
      setCurrentIndex(0);
      setReplayActions([]);
      setSessionName((previous) => previous || defaultSessionName({
        mode: "standalone",
        symbol: selectedSymbol,
        interval: interval(),
        propFirmRules: selectedPreset,
        startDate: startDate() || undefined,
        endDate: endDate() || undefined,
        commission: 5,
        tickValue: tickValueBySymbol[selectedSymbol.symbol] ?? selectedSymbol.tick_value ?? 1,
        tickSize: selectedSymbol.tick_size || 0.25,
        positionSize: positionSize(),
        spreadTicks: executionDefaults.spreadTicks,
        volatileBarThresholdTicks: executionDefaults.volatileBarThresholdTicks,
        volatileBarExtraTicks: executionDefaults.volatileBarExtraTicks,
        restingFillMode: executionDefaults.restingFillMode,
        sourceBacktest: null,
        candleSource: { kind: "db" },
      }));
      setLaunchConfig({
        mode: "standalone",
        symbol: selectedSymbol,
        interval: interval(),
        propFirmRules: selectedPreset,
        startDate: startDate() || undefined,
        endDate: endDate() || undefined,
        commission: 5,
        tickValue: tickValueBySymbol[selectedSymbol.symbol] ?? selectedSymbol.tick_value ?? 1,
        tickSize: selectedSymbol.tick_size || 0.25,
        positionSize: positionSize(),
        spreadTicks: executionDefaults.spreadTicks,
        volatileBarThresholdTicks: executionDefaults.volatileBarThresholdTicks,
        volatileBarExtraTicks: executionDefaults.volatileBarExtraTicks,
        restingFillMode: executionDefaults.restingFillMode,
        sourceBacktest: null,
        candleSource: { kind: "db" },
      });
    });
  };

  const buildPayload = (): ReplaySessionPayload | null => {
    const config = launchConfig();
    const session = replaySession();
    if (!config || !session) {
      return null;
    }

    return {
      name: (sessionName().trim() || defaultSessionName(config)).trim(),
      symbol: config.symbol.symbol,
      interval: getBackendInterval(config.interval),
      start_date: config.startDate,
      end_date: config.endDate,
      source_backtest: config.sourceBacktest ?? null,
      prop_firm_rules: config.propFirmRules,
      commission: config.commission,
      tick_value: config.tickValue,
      tick_size: config.tickSize,
      position_size: config.positionSize,
      spread_ticks: config.spreadTicks,
      volatile_bar_threshold_ticks: config.volatileBarThresholdTicks,
      volatile_bar_extra_ticks: config.volatileBarExtraTicks,
      resting_fill_mode: config.restingFillMode,
      current_bar_index: replayIndex(),
      status: replayStatus(),
      actions: replayActions().map((action) => ({
        id: action.id,
        type: action.type,
        bar_index: action.barIndex,
        created_at: action.createdAt,
        price: action.price,
        stop_price: action.stopPrice,
        target_price: action.targetPrice,
      })),
      active_order: session.activeOrder ? { ...session.activeOrder } : null,
      active_orders: session.activeOrders.map((order) => ({ ...order })),
      execution_events: session.executionEvents.map((event) => ({ ...event })),
      trades: session.trades,
      metrics: session.metrics,
      prop_firm_eval: session.propEvaluation,
      equity_curve: session.equityCurve,
    };
  };

  const saveSession = async () => {
    const payload = buildPayload();
    if (!payload) {
      setBannerError("Launch the replay before saving a session.");
      return;
    }

    setBannerError(null);
    setBannerNotice(null);
    setIsReplayActive(false);
    setIsSaving(true);

    try {
      if (sessionId()) {
        const result = await updateReplaySession(sessionId()!, payload);
        setSessionName(result.name);
        setBannerNotice(`Updated session "${result.name}".`);
      } else {
        const result = await createReplaySession(payload);
        setSessionId(result.replay_session_id);
        setSessionName(result.name);
        setBannerNotice(`Saved session "${result.name}".`);
        navigate(`/replay/${result.replay_session_id}`, { replace: true });
      }
    } catch (error) {
      setBannerError(error instanceof Error ? error.message : "Failed to save replay session.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <AppShell
      title={sessionId() ? "Replay Session" : "Simulated Live Replay"}
      subtitle={
        sourceBacktestId()
          ? "Launch the exact market window from a saved backtest, trade it forward-only, then review how your manual calls stacked up."
          : "Trade old Databento windows like they're live, keep future candles hidden during the run, and save progress when you need a break."
      }
      actions={
        <>
          <A
            href="/replay-sessions"
            class="app-button-secondary"
          >
            Replay Sessions
          </A>
          <A
            href="/replay"
            class="app-button-secondary"
          >
            New Replay
          </A>
          <A
            href="/backtests"
            class="app-button-primary"
          >
            Saved Backtests
          </A>
        </>
      }
    >
      <div class="space-y-6">
        <Show when={bannerError()}>
          <div class="rounded-xl border border-red-700 bg-red-950/80 px-4 py-3 text-sm text-red-300">
            {bannerError()}
          </div>
        </Show>

        <Show when={bannerNotice()}>
          <div class="rounded-xl border border-emerald-700 bg-emerald-950/80 px-4 py-3 text-sm text-emerald-300">
            {bannerNotice()}
          </div>
        </Show>

        <Show
          when={launchConfig()}
          fallback={
            <section class={`${section} app-panel-selected`}>
              <div class="space-y-2">
                <p class="app-kicker">
                  {activeSourceBacktest() || sourceBacktestId() ? "Saved Backtest Source" : "Standalone Session"}
                </p>
                <h2 class="text-lg font-semibold text-zinc-100">
                  {sessionId()
                    ? "Resume and update a saved replay"
                    : activeSourceBacktest() || sourceBacktestId()
                      ? "Trade the saved window"
                      : "Build a standalone replay"}
                </h2>
                <p class="max-w-3xl text-sm text-zinc-400">
                  {activeSourceBacktest() || sourceBacktestId()
                    ? "Pinned to the source backtest for later manual-vs-system review."
                    : "Load a historical window into a forward-only sim."}
                </p>
              </div>

              <div class="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
                <For each={sessionSummary()}>
                  {([key, value]) => (
                    <div class="rounded-2xl border border-zinc-700/80 bg-zinc-950/65 px-4 py-3">
                      <p class="app-metric-label">{key}</p>
                      <p class="mt-2 text-sm font-medium text-zinc-100">{value}</p>
                    </div>
                  )}
                </For>
                <div class="rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-3 md:col-span-3 xl:col-span-6">
                  <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Next Move</p>
                  <p class="mt-2 text-sm text-zinc-300">
                    {sourceBacktestId()
                      ? "Loading the saved backtest context, then locking the sim to that exact historical run."
                      : `Launch a simulated-live session to load up to ${SESSION_LIMIT.toLocaleString()} bars from the selected historical window.`}
                  </p>
                </div>
              </div>
            </section>
          }
        >
          <section class={`${section} app-panel-selected !py-4`}>
            <div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
              <p class="app-kicker mr-1">
                {activeSourceBacktest() || sourceBacktestId() ? "Saved Backtest Source" : "Standalone Session"}
              </p>
              <For each={sessionSummary()}>
                {([key, value], index) => (
                  <>
                    <Show when={index() > 0}>
                      <span class="text-zinc-700">·</span>
                    </Show>
                    <span class="text-zinc-500">
                      {key} <span class="ml-1 font-medium text-zinc-100">{value}</span>
                    </span>
                  </>
                )}
              </For>
            </div>
          </section>
        </Show>

        <div class="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
          <ReplayAccordionSection
            index="1"
            title="Session Setup"
            subtitle={
              activeSourceBacktest() || sourceBacktestId()
                ? "Symbol, range, and rules stay pinned to the source run."
                : "Name the sim and pick the market window."
            }
            meta={symbol()?.symbol ?? "Setup"}
            open={setupExpanded()}
            onToggle={() => setSetupExpanded((value) => !value)}
          >
            <Show when={workspaceSeedNotice() && !(activeSourceBacktest() || sourceBacktestId())}>
              <p class="text-xs text-cyan-300">{workspaceSeedNotice()}</p>
            </Show>

            <div>
              <label class={label}>Session name</label>
              <input
                type="text"
                class={field}
                value={sessionName()}
                placeholder="NQ 15 min replay"
                disabled={!canEditSetup()}
                onInput={(event) => setSessionName(event.currentTarget.value)}
              />
            </div>

            <Show
              when={!symbols.loading && symbols() && symbols()!.length > 0}
              fallback={
                <Show
                  when={!symbols.loading}
                  fallback={<div class="h-9 animate-pulse rounded bg-zinc-800" />}
                >
                  <div class="rounded-lg border border-yellow-700 bg-yellow-950 px-4 py-3 text-sm text-yellow-300">
                    No DB-backed symbols found. Import market data first.
                  </div>
                </Show>
              }
            >
              <div>
                <label class={label}>Symbol</label>
                <select
                  class={field}
                  value={symbol()?.symbol ?? ""}
                  disabled={!canEditSetup()}
                  onChange={(event) => {
                    const selected = symbols()?.find(
                      (item) => item.symbol === event.currentTarget.value,
                    );
                    setSymbol(selected ?? null);
                  }}
                >
                  <option value="" disabled>
                    Select a symbol…
                  </option>
                  <For each={symbols()}>
                    {(item) => (
                      <option value={item.symbol}>
                        {item.symbol} - {item.full_name} ({item.rows.toLocaleString()} bars)
                      </option>
                    )}
                  </For>
                </select>
              </div>
            </Show>

            <div class="grid gap-2 md:grid-cols-3">
              <div>
                <label class={label}>Interval</label>
                <select
                  class={field}
                  value={interval().value}
                  disabled={!canEditSetup()}
                  onChange={(event) => {
                    const selected = BACKTEST_INTERVALS.find(
                      (item) => item.value === event.currentTarget.value,
                    );
                    if (selected) {
                      setInterval(selected);
                    }
                  }}
                >
                  <For each={BACKTEST_INTERVALS}>
                    {(item) => <option value={item.value}>{item.label}</option>}
                  </For>
                </select>
              </div>

              <div>
                <label class={label}>Start date</label>
                <input
                  type="date"
                  class={field}
                  value={startDate()}
                  disabled={!canEditSetup()}
                  onInput={(event) => setStartDate(event.currentTarget.value)}
                />
              </div>

              <div>
                <label class={label}>End date</label>
                <input
                  type="date"
                  class={field}
                  value={endDate()}
                  disabled={!canEditSetup()}
                  onInput={(event) => setEndDate(event.currentTarget.value)}
                />
              </div>
            </div>

            <div class="grid gap-3 md:grid-cols-[160px_1fr]">
              <div>
                <label class={label}>Contracts</label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  class={field}
                  value={positionSize()}
                  disabled={!canEditSetup()}
                  onInput={(event) => {
                    const next = Number(event.currentTarget.value);
                    setPositionSize(Number.isFinite(next) && next > 0 ? next : 1);
                  }}
                />
              </div>
              <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                <p class="text-sm text-zinc-400">
                  This is the contract count used for every entry in the replay.
                </p>
              </div>
            </div>

            <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
              <p class="text-sm text-zinc-400">
                {activeSourceBacktest() || sourceBacktestId()
                  ? "Linked to the saved run."
                  : `Future candles stay hidden. Limit: ${SESSION_LIMIT.toLocaleString()} bars.`}
              </p>
            </div>
          </ReplayAccordionSection>

          <ReplayAccordionSection
            index="2"
            title="Ruleset And Launch"
            subtitle="Pick guardrails, then launch or save."
            meta={preset()?.name ?? "Rules"}
            open={rulesExpanded()}
            onToggle={() => setRulesExpanded((value) => !value)}
          >
            <Show
              when={presets() && presets()!.length > 0}
              fallback={<div class="h-9 animate-pulse rounded bg-zinc-800" />}
            >
              <div>
                <label class={label}>Preset</label>
                <select
                  class={field}
                  value={preset()?.name ?? ""}
                  disabled={!canEditSetup()}
                  onChange={(event) => {
                    const selected = presets()?.find(
                      (item) => item.name === event.currentTarget.value,
                    );
                    setPreset(selected ?? null);
                  }}
                >
                  <option value="" disabled>
                    Select a preset…
                  </option>
                  <For each={Object.entries(groupPresets(presets() ?? []))}>
                    {([firm, firmPresets]) => (
                      <optgroup label={firm}>
                        <For each={firmPresets}>
                          {(item) => <option value={item.name}>{item.name}</option>}
                        </For>
                      </optgroup>
                    )}
                  </For>
                </select>
              </div>

              <Show when={preset()}>
                {(selectedPreset) => (
                  <div class="space-y-3">
                    <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-3 py-3">
                      <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Selected Challenge</p>
                      <p class="mt-2 text-sm font-semibold text-zinc-100">{selectedPreset().name}</p>
                    </div>

                    <div class="grid grid-cols-2 gap-2">
                      {([
                        ["Account", `$${selectedPreset().account_size.toLocaleString()}`],
                        [
                          "Daily loss",
                          formatDailyLossLimit(selectedPreset().daily_loss_limit),
                        ],
                        ["Max DD", `${(selectedPreset().max_drawdown * 100).toFixed(0)}%`],
                        ["Target", `${(selectedPreset().profit_target * 100).toFixed(0)}%`],
                        ["Min days", selectedPreset().min_trading_days ?? "—"],
                        ["Drawdown", selectedPreset().drawdown_type ?? "eod"],
                      ] as [string, string | number][]).map(([key, value]) => (
                        <div class="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2.5">
                          <p class="text-xs text-zinc-400">{key}</p>
                          <p class="mt-1 text-sm font-mono text-zinc-100">{value}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Show>
            </Show>

            <Show when={!canEditSetup()}>
              <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3 text-sm text-zinc-400">
                {activeSourceBacktest()
                  ? "Pinned to the source backtest."
                  : "This market window is locked for the active run."}
              </div>
            </Show>

            <div class="space-y-3">
              <Show when={workspaceIntent()}>
                {(intent) => (
                  <WorkspaceLaunchControl
                    intent={intent()}
                    buttonLabel="Open in Workspace"
                  />
                )}
              </Show>

              <div class="grid gap-3 md:grid-cols-2">
                <button
                  class={
                    "app-button-primary w-full justify-center " +
                    (!(canLaunch() && canEditSetup()) ? "cursor-not-allowed bg-zinc-700 text-zinc-400 hover:bg-zinc-700" : "")
                  }
                  disabled={!canLaunch() || !canEditSetup()}
                  onClick={launchReplay}
                >
                  {candles.loading
                    ? "Loading Sim…"
                    : activeSourceBacktest() || sourceBacktestId()
                      ? "Launch Source Sim"
                      : "Launch Sim"}
                </button>

                <button
                  class={
                    "inline-flex items-center justify-center rounded-xl px-4 py-2 text-sm font-semibold transition-colors " +
                    (canSave()
                      ? "bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
                      : "cursor-not-allowed bg-zinc-700 text-zinc-400")
                  }
                  disabled={!canSave()}
                  onClick={saveSession}
                >
                  {isSaving()
                    ? "Saving…"
                    : sessionId()
                      ? "Update Session"
                      : "Save Session"}
                </button>
              </div>
            </div>
          </ReplayAccordionSection>
        </div>

        <Show when={launchConfig()}>
          {(config) => (
            <>
              <section id="replay" class="app-panel app-panel-section scroll-mt-24">
                <div class="space-y-6">
                  <div class="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
                    <div class="space-y-2">
                      <p class="text-xs uppercase tracking-[0.18em] text-sky-300">Current Session</p>
                      <h2 class="text-2xl font-semibold text-zinc-100">
                        {sessionName() || defaultSessionName(config())}
                      </h2>
                      <p class="max-w-3xl text-sm text-zinc-400">
                        {config().sourceBacktest
                          ? "Trading the saved backtest window."
                          : "Trading a historical window forward-only."}
                      </p>
                      <p class="text-xs text-zinc-500">
                        <span class="app-data text-zinc-300">${config().commission.toFixed(2)}</span> commission
                        <span class="mx-2 text-zinc-700">·</span>
                        <span class="app-data text-zinc-300">${config().tickValue.toFixed(2)}</span> tick value
                        <span class="mx-2 text-zinc-700">·</span>
                        <span class="app-data text-zinc-300">{config().positionSize}</span> contracts
                        <span class="mx-2 text-zinc-700">·</span>
                        <span class="text-zinc-300">{config().propFirmRules.name}</span>
                        <Show when={config().sourceBacktest}>
                          {(source) => (
                            <>
                              <span class="mx-2 text-zinc-700">·</span>
                              <span class="text-zinc-400">{source().strategy_type?.replace(/_/g, " ") ?? "Saved run"}</span>
                            </>
                          )}
                        </Show>
                      </p>
                    </div>

                    <div class="flex flex-wrap items-center gap-2">
                      <Show when={config().sourceBacktest}>
                        {(source) => (
                          <div class="rounded-full border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs font-medium uppercase tracking-[0.16em] text-zinc-400">
                            Backtest {source().backtest_id.slice(0, 8)}
                          </div>
                        )}
                      </Show>
                      <div class="rounded-full border border-sky-400/75 bg-sky-400/12 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-sky-100">
                        {formatReplaySessionStatus(replayStatus())}
                      </div>
                      <Show when={canUnlockReview()}>
                        <button
                          type="button"
                          class="app-button-secondary"
                          onClick={() => {
                            setIsReviewMode(true);
                            setBannerNotice("Review mode unlocked. The trade log is frozen, but you can inspect the full session now.");
                          }}
                        >
                          Unlock Review Mode
                        </button>
                      </Show>
                    </div>
                  </div>

                  <div class="space-y-5">
                      <ChartIndicatorToggleBar
                        settings={indicatorSettings()}
                        onToggle={toggleIndicator}
                      />

                      <div class="overflow-hidden rounded-3xl border border-zinc-700/80 bg-zinc-950/76">
                        <Show when={candles() && candles()!.length > 0}>
                          <ReplayChartStrip
                            isPlaying={isReplayActive()}
                            statusLabel={formatReplaySessionStatus(replayStatus())}
                            currentBar={totalBars() === 0 ? 0 : replayIndex() + 1}
                            totalBars={totalBars()}
                            currentPriceLabel={currentPriceLabel()}
                            bidAskLabel={bidAskLabel()}
                            canStartPlayback={canStartPlayback()}
                            onPlayPause={() => {
                              if (isReplayActive()) {
                                setIsReplayActive(false);
                                return;
                              }

                              if (!canStartPlayback()) {
                                return;
                              }

                              setIsReplayActive(true);
                            }}
                            onRestart={() => {
                              batch(() => {
                                setBannerNotice(null);
                                setIsReplayActive(false);
                                setIsReviewMode(false);
                                setCurrentIndex(0);
                                setReplayActions([]);
                                setBracketStopPrice("");
                                setBracketTargetPrice("");
                              });
                            }}
                          />
                        </Show>

                        <div class="p-4">
                          <Show
                            when={candles.error}
                            fallback={
                              <Show
                                when={!candles.loading && candles() && candles()!.length > 0}
                                fallback={
                                  <div class="flex h-[520px] items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-950 px-6 text-center">
                                    <p class="text-sm text-zinc-500">
                                      {candles.loading
                                        ? "Loading replay candles…"
                                        : "No candles were returned for that historical request."}
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
                                  class="rounded-2xl"
                                />
                              </Show>
                            }
                          >
                            {(error) => (
                              <div class="flex h-[520px] items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-950 px-6 text-center">
                                <p class="text-sm text-red-400">Replay data failed to load: {error().message}</p>
                              </div>
                            )}
                          </Show>
                        </div>

                        <Show when={candles() && candles()!.length > 0}>
                          <ReplayExecutionActions
                            canLiftAsk={!isReviewMode()}
                            canHitBid={!isReviewMode()}
                            canJoinBid={canPlaceEntries()}
                            canJoinAsk={canPlaceEntries()}
                            canRestExit={canRestExit()}
                            canReplaceOrder={canReplaceOrder()}
                            canCancelOrder={canCancelOrder()}
                            canFlatten={canExitPosition() || canCancelOrder()}
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

                      <Show when={candles() && candles()!.length > 0}>
                        <ReplayTimelineControls
                          speed={speed()}
                          progress={replayProgress()}
                          currentBar={totalBars() === 0 ? 0 : replayIndex() + 1}
                          totalBars={totalBars()}
                          statusDetail={replayStatusDetail()}
                          currentTimeLabel={currentTimeLabel()}
                          positionLabel={positionLabel()}
                          activeOrderLabel={activeOrderLabel()}
                          isPlaying={isReplayActive()}
                          canSeek={canSeek()}
                          canStartPlayback={canStartPlayback()}
                          canStepBack={canStepBack()}
                          canStepForward={canStepForward()}
                          canJumpPrevTrade={canJumpPrevTrade()}
                          canJumpNextTrade={canJumpNextTrade()}
                          onSpeedChange={setSpeed}
                          onSeek={(progress) =>
                            canSeek() ? seekToIndex(getReplayIndexFromProgress(progress, totalBars())) : undefined
                          }
                          onStepBack={() => {
                            if (canStepBack()) {
                              seekToIndex(replayIndex() - 1);
                            }
                          }}
                          onStepForward={() => {
                            if (canStepForward()) {
                              seekToIndex(replayIndex() + 1);
                            }
                          }}
                          onJumpPrevTrade={() => jumpToTrade("prev")}
                          onJumpNextTrade={() => jumpToTrade("next")}
                        />
                      </Show>
                      <Show when={!!replaySession()?.position || activeOrders().length > 0}>
                        <div class="rounded-3xl border border-zinc-700/80 bg-zinc-950/65 p-5">
                          <div class="flex items-center justify-between gap-3">
                            <div>
                              <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Bracket Builder</p>
                              <p class="mt-1 text-sm text-zinc-400">
                                Attach a stop/target OCO pair to the open replay trade.
                              </p>
                            </div>
                            <div class="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-xs text-zinc-400">
                              {activeOrders().length} live order{activeOrders().length === 1 ? "" : "s"}
                            </div>
                          </div>

                          <div class="mt-4 space-y-3">
                            <div class="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
                              <input
                                type="number"
                                step="0.01"
                                value={bracketStopPrice()}
                                onInput={(event) => setBracketStopPrice(event.currentTarget.value)}
                                placeholder="Stop price"
                                class="w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-500"
                              />
                              <input
                                type="number"
                                step="0.01"
                                value={bracketTargetPrice()}
                                onInput={(event) => setBracketTargetPrice(event.currentTarget.value)}
                                placeholder="Target price"
                                class="w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-500"
                              />
                              <button
                                type="button"
                                disabled={!canAttachBracket()}
                                onClick={attachReplayBracket}
                                class="rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-500"
                              >
                                Attach Bracket
                              </button>
                            </div>

                            <Show when={activeOrders().length > 0}>
                              <div class="grid gap-2 rounded-2xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 md:grid-cols-2">
                                <For each={activeOrders()}>
                                  {(order) => (
                                    <div class="rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-xs text-zinc-300">
                                      {order.bracket_role === "target"
                                        ? "TARGET"
                                        : order.bracket_role === "stop"
                                          ? "STOP"
                                          : order.intent === "exit"
                                            ? "EXIT"
                                            : "ENTRY"}{" "}
                                      {formatTradeLabel(order.side, order.quantity)}{" "}
                                      @ ${order.price.toFixed(2)}
                                    </div>
                                  )}
                                </For>
                              </div>
                            </Show>
                          </div>
                        </div>
                      </Show>
                  </div>
                </div>
              </section>

              <Show when={replaySession()}>
                {(session) => (
                  <>
                    <div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
                      <For each={replayMetrics()}>
                        {([key, value]) => (
                          <ReplayStatCard
                            label={key}
                            value={value}
                            tone={key === "Realized PnL" || key === "Total PnL"
                              ? value.startsWith("+")
                                ? "good"
                                : value.startsWith("-")
                                  ? "bad"
                                  : "default"
                              : "default"}
                          />
                        )}
                      </For>
                    </div>

                    <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                      <ReplayStatCard
                        label="Entry Mix"
                        value={
                          executionAnalytics()
                            ? `${executionAnalytics()!.summary.makerEntries} maker / ${executionAnalytics()!.summary.takerEntries} taker`
                            : "0 / 0"
                        }
                        detail="How your entries got filled under the synthetic book."
                      />
                      <ReplayStatCard
                        label="Exit Mix"
                        value={
                          executionAnalytics()
                            ? `${executionAnalytics()!.summary.makerExits} maker / ${executionAnalytics()!.summary.takerExits} taker`
                            : "0 / 0"
                        }
                        detail="Useful once you start mixing resting exits later."
                      />
                      <ReplayStatCard
                        label="Avg Entry Slip"
                        value={formatTicks(executionAnalytics()?.summary.avgEntrySlippageTicks)}
                        tone={
                          (executionAnalytics()?.summary.avgEntrySlippageTicks ?? 0) < 0
                            ? "good"
                            : (executionAnalytics()?.summary.avgEntrySlippageTicks ?? 0) > 0
                              ? "bad"
                              : "default"
                        }
                        detail="Measured versus the synthetic reference on the fill bar."
                      />
                      <ReplayStatCard
                        label="Avg Exit Slip"
                        value={formatTicks(executionAnalytics()?.summary.avgExitSlippageTicks)}
                        tone={
                          (executionAnalytics()?.summary.avgExitSlippageTicks ?? 0) < 0
                            ? "good"
                            : (executionAnalytics()?.summary.avgExitSlippageTicks ?? 0) > 0
                              ? "bad"
                              : "default"
                        }
                        detail="Negative means you beat the reference; positive means adverse."
                      />
                      <ReplayStatCard
                        label="1-Bar Markout"
                        value={formatTicks(executionAnalytics()?.summary.avgOneBarMarkoutTicks)}
                        tone={
                          (executionAnalytics()?.summary.avgOneBarMarkoutTicks ?? 0) > 0
                            ? "good"
                            : (executionAnalytics()?.summary.avgOneBarMarkoutTicks ?? 0) < 0
                              ? "bad"
                              : "default"
                        }
                        detail="Did the trade go your way one bar after entry?"
                      />
                      <ReplayStatCard
                        label="Excursion"
                        value={
                          executionAnalytics()
                            ? `${formatTicks(executionAnalytics()!.summary.avgMfeTicks)} / ${formatTicks(executionAnalytics()!.summary.avgMaeTicks)}`
                            : "n/a"
                        }
                        detail="Avg MFE / MAE in ticks across closed replay trades."
                      />
                    </div>

                    <div class="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
                      <div class="app-panel app-panel-section">
                        <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Replay Equity Curve</p>
                        <div class="mt-4">
                          <EquityCurve data={session().equityCurve} />
                        </div>
                      </div>

                      <PropEvalPanel title="Replay Prop Eval" evaluation={session().propEvaluation}>
                        <div class="space-y-2 text-sm">
                          <Show when={activeSourceBacktest()}>
                            {(source) => (
                              <p class="text-zinc-400">
                                Linked to backtest `{source().backtest_id.slice(0, 8)}`. Save the run, then review after completion.
                              </p>
                            )}
                          </Show>
                          <Show when={!activeSourceBacktest()}>
                            <p class="text-zinc-400">Save the run, then review after completion.</p>
                          </Show>
                          <div class="flex flex-wrap items-center gap-2">
                            <Show when={compareHref()}>
                              {(href) => (
                                <A href={href()} class="app-button-compact-primary">
                                  Compare Vs System
                                </A>
                              )}
                            </Show>
                            <Show when={activeSourceBacktest() && !compareHref()}>
                              <p class="text-xs text-zinc-500">
                                Save the session and unlock review mode to open the compare screen.
                              </p>
                            </Show>
                          </div>
                        </div>
                      </PropEvalPanel>
                    </div>

                    <div class="app-panel overflow-hidden">
                      <div class="border-b border-zinc-700/80 px-4 py-3">
                        <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Execution Tape</p>
                        <p class="mt-1 text-sm text-zinc-400">
                          Synthetic order lifecycle, fills, and ignores ({session().executionEvents.length})
                        </p>
                      </div>
                      <table class="app-table">
                        <thead>
                          <tr>
                            <th>Time</th>
                            <th>Action</th>
                            <th>Role</th>
                            <th class="text-right">Price</th>
                            <th class="text-right">Slip</th>
                            <th>Note</th>
                          </tr>
                        </thead>
                        <tbody>
                          <Show
                            when={(executionAnalytics()?.tape.length ?? 0) > 0}
                            fallback={
                              <tr>
                                <td class="px-3 py-3 text-zinc-500" colSpan={6}>
                                  No execution events yet. The tape fills in once you start placing actions.
                                </td>
                              </tr>
                            }
                          >
                            <For each={[...(executionAnalytics()?.tape ?? [])].reverse().slice(0, 14)}>
                              {(row) => (
                                <tr>
                                  <td class="app-data text-xs text-zinc-500">{row.time}</td>
                                  <td class="text-zinc-200">
                                    {row.action}
                                    <Show when={row.side}>
                                      <span class="ml-2 text-xs uppercase tracking-[0.18em] text-zinc-500">
                                        {row.side}
                                      </span>
                                    </Show>
                                  </td>
                                  <td class="text-zinc-400">
                                    {row.role === "n/a" ? row.category : `${row.role} ${row.liquidity}`}
                                  </td>
                                  <td class="app-data text-right text-zinc-200">
                                    {row.price === null ? "n/a" : row.price.toFixed(2)}
                                  </td>
                                  <td
                                    class={`app-data text-right ${
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
                                  <td class="text-zinc-400">{row.note ?? " "}</td>
                                </tr>
                              )}
                            </For>
                          </Show>
                        </tbody>
                      </table>
                    </div>

                    <div class="app-panel overflow-hidden">
                      <div class="border-b border-zinc-700/80 px-4 py-3">
                        <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Trade Log</p>
                        <p class="mt-1 text-sm text-zinc-400">
                          Replay Trades ({session().trades.length})
                        </p>
                      </div>
                      <table class="app-table">
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>Side</th>
                            <th>Entry Time</th>
                            <th>Exit Time</th>
                            <th class="text-right">Entry $</th>
                            <th class="text-right">Exit $</th>
                            <th class="text-right">PnL</th>
                          </tr>
                        </thead>
                        <tbody>
                          <Show
                            when={session().trades.length > 0}
                            fallback={
                              <tr>
                                <td class="px-3 py-3 text-zinc-500" colSpan={7}>
                                  No replay trades yet. Use the controls above to place manual
                                  decisions.
                                </td>
                              </tr>
                            }
                          >
                            <For each={session().trades}>
                              {(trade: Trade) => (
                                <tr>
                                  <td class="app-data text-zinc-500">{trade.trade_id}</td>
                                  <td
                                    class={`font-medium ${
                                      trade.side === "buy" ? "text-green-400" : "text-red-400"
                                    }`}
                                  >
                                    {formatTradeLabel(trade.side, trade.quantity)}
                                  </td>
                                  <td class="app-data text-xs text-zinc-500">
                                    {trade.entry_time}
                                  </td>
                                  <td class="app-data text-xs text-zinc-500">
                                    {trade.exit_time}
                                  </td>
                                  <td class="app-data text-right">
                                    {trade.entry_price.toFixed(2)}
                                  </td>
                                  <td class="app-data text-right">
                                    {(trade.exit_price ?? 0).toFixed(2)}
                                  </td>
                                  <td
                                    class={`app-data text-right font-semibold ${
                                      trade.pnl >= 0 ? "text-green-400" : "text-red-400"
                                    }`}
                                  >
                                    {trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}
                                  </td>
                                </tr>
                              )}
                            </For>
                          </Show>
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </Show>
            </>
          )}
        </Show>
      </div>
    </AppShell>
  );
}
