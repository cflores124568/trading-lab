import { A, useNavigate, useParams, useSearchParams } from "@solidjs/router";
import {
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { CircleCheck, CircleX, TriangleAlert } from "lucide-solid";
import AppShell from "../components/AppShell";
import ChartIndicatorToggleBar from "../components/ChartIndicatorToggleBar";
import EquityCurve from "../components/EquityCurve";
import PriceChart, { type PriceChartMarker } from "../components/PriceChart";
import ReplayControls from "../components/ReplayControls";
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
import type { WorkspaceLaunchIntent } from "../components/workspace/workspacePersistence";
import {
  defaultExecutionConfigForSymbol,
  normalizeRestingFillMode,
  type RestingOrder,
} from "../services/executionModel";
import { buildReplayExecutionAnalytics } from "../services/executionAnalytics";

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

function formatTicks(value?: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "n/a";
  }
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}t`;
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

function formatRestingFillMode(mode: string | undefined): string {
  if (mode === "penetrate") return "penetrate";
  if (mode === "touch_plus_1_bar") return "touch + 1 bar";
  return "touch";
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

export default function ReplayLabPage() {
  const params = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams<{ backtestId?: string }>();
  const navigate = useNavigate();
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
  const [bannerError, setBannerError] = createSignal<string | null>(null);
  const [bannerNotice, setBannerNotice] = createSignal<string | null>(null);
  const [launchConfig, setLaunchConfig] = createSignal<ReplayLaunchConfig | null>(null);
  const [isSaving, setIsSaving] = createSignal(false);

  const [isReplayActive, setIsReplayActive] = createSignal(false);
  const [isReviewMode, setIsReviewMode] = createSignal(false);
  const [speed, setSpeed] = createSignal(8);
  const [currentIndex, setCurrentIndex] = createSignal(0);
  const [replayActions, setReplayActions] = createSignal<ReplayAction[]>([]);
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
      spreadTicks: config.spreadTicks,
      volatileBarThresholdTicks: config.volatileBarThresholdTicks,
      volatileBarExtraTicks: config.volatileBarExtraTicks,
      restingFillMode: config.restingFillMode,
      propFirmRules: config.propFirmRules,
    });
  });

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
      !replaySession()?.activeOrder,
  );
  const canRestExit = createMemo(
    () =>
      !isReviewMode() &&
      replayIndex() < totalBars() - 1 &&
      !!replaySession()?.position &&
      !replaySession()?.activeOrder,
  );
  const canExitPosition = createMemo(
    () => !!replaySession()?.position && !isReviewMode(),
  );
  const canCancelOrder = createMemo(
    () => !!replaySession()?.activeOrder && !isReviewMode(),
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
      ["Position", session.position ? session.position.side.toUpperCase() : "FLAT"],
      [
        "Order",
        session.activeOrder
          ? `${session.activeOrder.intent === "exit" ? "EXIT" : "ENTRY"} ${session.activeOrder.side.toUpperCase()} @ $${session.activeOrder.price.toFixed(2)}`
          : "NONE",
      ],
      ["Resting Fill", formatRestingFillMode(config.restingFillMode)],
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

    return `${session.position.side.toUpperCase()} from $${session.position.entry_price.toFixed(2)} (${formatCurrency(session.position.unrealized_pnl)})`;
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
    const order = replaySession()?.activeOrder as RestingOrder | null | undefined;
    if (!order) {
      return "None";
    }
    const armed = order.first_touch_bar_index !== undefined ? " [armed]" : "";
    const intent = order.intent === "exit" ? "EXIT" : "ENTRY";
    return `${intent} ${order.side.toUpperCase()} @ $${order.price.toFixed(2)}${armed}`;
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
        text: `YOU ${trade.side.toUpperCase()} @ ${trade.entry_price.toFixed(2)}`,
      });

      if (trade.exit_time) {
        markers.push({
          time: markerTimeFromIso(trade.exit_time),
          position: trade.side === "buy" ? "aboveBar" : "belowBar",
          color: "#f8fafc",
          shape: "square",
          text: `EXIT ${trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}`,
        });
      }
    }

    if (session.position && currentCandle()) {
      markers.push({
        time: Number(currentCandle()!.time),
        position: session.position.side === "buy" ? "belowBar" : "aboveBar",
        color: session.position.side === "buy" ? "#34d399" : "#f43f5e",
        shape: "circle",
        text: `OPEN ${session.position.side.toUpperCase()} ${formatCurrency(session.position.unrealized_pnl)}`,
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

  const recordReplayAction = (type: ReplayAction["type"]) => {
    if (!candles() || totalBars() === 0 || isReviewMode()) {
      return;
    }

    if (
      ["lift_ask", "hit_bid", "join_bid", "join_ask", "rest_exit", "buy", "sell"].includes(type) &&
      replayIndex() >= totalBars() - 1
    ) {
      return;
    }

    setBannerNotice(null);
    setIsReplayActive(false);
    setReplayActions((previous) => [...previous, createReplayAction(type, replayIndex())]);
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
      })),
      active_order: session.activeOrder ? { ...session.activeOrder } : null,
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

        <section class={section}>
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
                <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                  <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">{key}</p>
                  <p class="mt-2 text-sm font-medium text-zinc-100">{value}</p>
                </div>
              )}
            </For>
            <Show when={!launchConfig()}>
              <div class="rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-3 md:col-span-3 xl:col-span-6">
                <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Next Move</p>
                <p class="mt-2 text-sm text-zinc-300">
                  {sourceBacktestId()
                    ? "Loading the saved backtest context, then locking the sim to that exact historical run."
                    : `Launch a simulated-live session to load up to ${SESSION_LIMIT.toLocaleString()} bars from the selected historical window.`}
                </p>
              </div>
            </Show>
          </div>
        </section>

        <div class="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
          <section class={`${section} h-full`}>
            <div class="space-y-1">
              <p class="text-sm font-semibold text-zinc-100">1. Session Setup</p>
              <p class="text-xs text-zinc-400">
                {activeSourceBacktest() || sourceBacktestId()
                  ? "Symbol, range, and rules come from the source run."
                  : "Name the sim and choose the market window."}
              </p>
            </div>

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
                    No DB-backed symbols found. Import market data first to launch a replay session.
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

            <div class="grid gap-3 md:grid-cols-3">
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
                <label class={label}>Start date (optional)</label>
                <input
                  type="date"
                  class={field}
                  value={startDate()}
                  disabled={!canEditSetup()}
                  onInput={(event) => setStartDate(event.currentTarget.value)}
                />
              </div>

              <div>
                <label class={label}>End date (optional)</label>
                <input
                  type="date"
                  class={field}
                  value={endDate()}
                  disabled={!canEditSetup()}
                  onInput={(event) => setEndDate(event.currentTarget.value)}
                />
              </div>
            </div>

            <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
              <p class="text-sm text-zinc-400">
                {activeSourceBacktest() || sourceBacktestId()
                  ? "Replay stays linked to the saved system run."
                  : `Limit: ${SESSION_LIMIT.toLocaleString()} bars. Future candles stay hidden while you trade.`}
              </p>
            </div>
          </section>

          <section class={`${section} h-full`}>
            <div class="space-y-1">
              <p class="text-sm font-semibold text-zinc-100">2. Ruleset And Launch</p>
              <p class="text-xs text-zinc-400">
                Choose guardrails, then launch or save.
              </p>
            </div>

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
                    <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-4">
                      <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Selected Challenge</p>
                      <p class="mt-2 text-sm font-semibold text-zinc-100">{selectedPreset().name}</p>
                    </div>

                    <div class="grid grid-cols-2 gap-2">
                      {([
                        ["Account", `$${selectedPreset().account_size.toLocaleString()}`],
                        ["Daily loss", `${(selectedPreset().daily_loss_limit * 100).toFixed(0)}%`],
                        ["Max DD", `${(selectedPreset().max_drawdown * 100).toFixed(0)}%`],
                        ["Target", `${(selectedPreset().profit_target * 100).toFixed(0)}%`],
                        ["Min days", selectedPreset().min_trading_days ?? "—"],
                        ["Drawdown", selectedPreset().drawdown_type ?? "eod"],
                      ] as [string, string | number][]).map(([key, value]) => (
                        <div class="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3">
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
              <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-4 text-sm text-zinc-400">
                {activeSourceBacktest()
                  ? "This session is pinned to its source backtest. Use `Restart` to trade the same tape again or `New Replay` for a different run."
                  : "This market window is locked for the active run. Use `Restart` to trade it again or `New Replay` to build a different session."}
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
          </section>
        </div>

        <Show when={launchConfig()}>
          {(config) => (
            <>
              <section id="replay" class="app-panel app-panel-section scroll-mt-24">
                <div class="space-y-6">
                  <div class="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
                    <div class="space-y-2">
                      <p class="text-xs uppercase tracking-[0.18em] text-sky-300">Replay In Progress</p>
                      <h2 class="text-2xl font-semibold text-zinc-100">
                        {sessionName() || defaultSessionName(config())}
                      </h2>
                      <p class="max-w-3xl text-sm text-zinc-400">
                        {config().sourceBacktest
                          ? "Trading the saved backtest window."
                          : "Trading a historical window forward-only."}
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
                      <div class="rounded-full border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs font-medium uppercase tracking-[0.16em] text-zinc-400">
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

                  <div class="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.65fr)]">
                    <div class="space-y-5">
                      <ChartIndicatorToggleBar
                        settings={indicatorSettings()}
                        onToggle={toggleIndicator}
                      />

                      <div class="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950/70 p-3">
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
                        <ReplayControls
                          isPlaying={isReplayActive()}
                          speed={speed()}
                          statusLabel={formatReplaySessionStatus(replayStatus())}
                          statusDetail={replayStatusDetail()}
                          progress={replayProgress()}
                          currentBar={totalBars() === 0 ? 0 : replayIndex() + 1}
                          totalBars={totalBars()}
                          currentTimeLabel={currentTimeLabel()}
                          currentPriceLabel={currentPriceLabel()}
                          bidAskLabel={bidAskLabel()}
                          positionLabel={positionLabel()}
                          activeOrderLabel={activeOrderLabel()}
                          canSeek={canSeek()}
                          canStartPlayback={canStartPlayback()}
                          canStepBack={canStepBack()}
                          canStepForward={canStepForward()}
                          canJumpPrevTrade={canJumpPrevTrade()}
                          canJumpNextTrade={canJumpNextTrade()}
                          canLiftAsk={!isReviewMode()}
                          canHitBid={!isReviewMode()}
                          canJoinBid={canPlaceEntries()}
                          canJoinAsk={canPlaceEntries()}
                          canRestExit={canRestExit()}
                          canCancelOrder={canCancelOrder()}
                          canFlatten={canExitPosition() || canCancelOrder()}
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
                          onSpeedChange={setSpeed}
                          onSeek={(progress) =>
                            canSeek() ? seekToIndex(getReplayIndexFromProgress(progress, totalBars())) : undefined
                          }
                          onRestart={() => {
                            batch(() => {
                              setBannerNotice(null);
                              setIsReplayActive(false);
                              setIsReviewMode(false);
                              setCurrentIndex(0);
                              setReplayActions([]);
                            });
                          }}
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
                          onLiftAsk={() => recordReplayAction("lift_ask")}
                          onHitBid={() => recordReplayAction("hit_bid")}
                          onJoinBid={() => recordReplayAction("join_bid")}
                          onJoinAsk={() => recordReplayAction("join_ask")}
                          onRestExit={() => recordReplayAction("rest_exit")}
                          onCancel={() => recordReplayAction("cancel")}
                          onFlatten={() => recordReplayAction("flatten")}
                        />
                      </Show>
                    </div>

                    <div class="space-y-4">
                      <div class="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
                        <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Session Pulse</p>
                        <div class="mt-4 grid gap-3">
                          <ReplayStatCard
                            label="Current Price"
                            value={currentPriceLabel()}
                            detail="Most recent visible close in the replay tape."
                          />
                          <ReplayStatCard
                            label="Position"
                            value={positionLabel()}
                            tone={replaySession()?.position ? "good" : "default"}
                            detail="Open position state and unrealized mark-to-market."
                          />
                          <ReplayStatCard
                            label="Replay Status"
                            value={formatReplaySessionStatus(replayStatus())}
                            detail={replayStatusDetail()}
                          />
                        </div>
                      </div>

                      <div class="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
                        <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Run Context</p>
                        <div class="mt-4 grid gap-3">
                          <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
                            <p class="text-xs text-zinc-500">Commission</p>
                            <p class="mt-1 font-mono text-sm font-semibold text-zinc-100">
                              ${config().commission.toFixed(2)}
                            </p>
                          </div>
                          <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
                            <p class="text-xs text-zinc-500">Tick Value</p>
                            <p class="mt-1 font-mono text-sm font-semibold text-zinc-100">
                              ${config().tickValue.toFixed(2)}
                            </p>
                          </div>
                          <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
                            <p class="text-xs text-zinc-500">Ruleset</p>
                            <p class="mt-1 text-sm font-semibold text-zinc-100">
                              {config().propFirmRules.name}
                            </p>
                          </div>
                          <Show when={config().sourceBacktest}>
                            {(source) => (
                              <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
                                <p class="text-xs text-zinc-500">Source Backtest</p>
                                <p class="mt-1 font-mono text-sm font-semibold text-zinc-100">
                                  {source().backtest_id}
                                </p>
                                <p class="mt-1 text-xs text-zinc-500">
                                  {source().strategy_type?.replace(/_/g, " ") ?? "Saved run"}
                                </p>
                              </div>
                            )}
                          </Show>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              <Show when={replaySession()}>
                {(session) => (
                  <>
                    <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
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

                      <div class="grid gap-4">
                        <PropEvalPanel title="Replay Prop Eval" evaluation={session().propEvaluation} />
                        <div class="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
                          <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Persistence And Review</p>
                          <p class="mt-2 text-sm text-zinc-400">Save the run, then review after completion.</p>
                          <Show when={activeSourceBacktest()}>
                            {(source) => (
                              <p class="mt-3 text-sm text-zinc-400">
                                Linked to backtest `{source().backtest_id.slice(0, 8)}`.
                              </p>
                            )}
                          </Show>
                          <div class="mt-4 flex flex-wrap gap-2">
                            <Show when={compareHref()}>
                              {(href) => (
                                <A
                                  href={href()}
                                  class="app-button-compact-primary"
                                >
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
                      </div>
                    </div>

                    <div class="app-panel overflow-hidden">
                      <div class="border-b border-zinc-800 p-4">
                        <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Execution Tape</p>
                        <p class="mt-1 text-sm text-zinc-400">
                          Synthetic order lifecycle, fills, and ignores ({session().executionEvents.length})
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
                                  No execution events yet. The tape fills in once you start placing actions.
                                </td>
                              </tr>
                            }
                          >
                            <For each={[...(executionAnalytics()?.tape ?? [])].reverse().slice(0, 14)}>
                              {(row) => (
                                <tr class="border-t border-zinc-800 transition-colors hover:bg-zinc-800">
                                  <td class="p-3 font-mono text-xs text-zinc-400">{row.time}</td>
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

                    <div class="app-panel overflow-hidden">
                      <div class="border-b border-zinc-800 p-4">
                        <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Trade Log</p>
                        <p class="mt-1 text-sm text-zinc-400">
                          Replay Trades ({session().trades.length})
                        </p>
                      </div>
                      <table class="w-full text-sm">
                        <thead class="text-xs text-zinc-400">
                          <tr>
                            <th class="p-3 text-left">#</th>
                            <th class="p-3 text-left">Side</th>
                            <th class="p-3 text-left">Entry Time</th>
                            <th class="p-3 text-left">Exit Time</th>
                            <th class="p-3 text-right">Entry $</th>
                            <th class="p-3 text-right">Exit $</th>
                            <th class="p-3 text-right">PnL</th>
                          </tr>
                        </thead>
                        <tbody>
                          <Show
                            when={session().trades.length > 0}
                            fallback={
                              <tr class="border-t border-zinc-800">
                                <td class="p-4 text-zinc-500" colSpan={7}>
                                  No replay trades yet. Use the controls above to place manual
                                  decisions.
                                </td>
                              </tr>
                            }
                          >
                            <For each={session().trades}>
                              {(trade: Trade) => (
                                <tr class="border-t border-zinc-800 transition-colors hover:bg-zinc-800">
                                  <td class="p-3 text-zinc-400">{trade.trade_id}</td>
                                  <td
                                    class={`p-3 font-medium ${
                                      trade.side === "buy" ? "text-green-400" : "text-red-400"
                                    }`}
                                  >
                                    {trade.side}
                                  </td>
                                  <td class="p-3 font-mono text-xs text-zinc-400">
                                    {trade.entry_time}
                                  </td>
                                  <td class="p-3 font-mono text-xs text-zinc-400">
                                    {trade.exit_time}
                                  </td>
                                  <td class="p-3 text-right font-mono">
                                    {trade.entry_price.toFixed(2)}
                                  </td>
                                  <td class="p-3 text-right font-mono">
                                    {(trade.exit_price ?? 0).toFixed(2)}
                                  </td>
                                  <td
                                    class={`p-3 text-right font-mono font-semibold ${
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
