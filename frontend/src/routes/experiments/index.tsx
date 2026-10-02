import ResearchWorkflow from "../../components/ResearchWorkflow";
import DataLoadError from "../../components/DataLoadError";
import { A, useLocation, useNavigate } from "@solidjs/router";
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
import AppShell from "../../components/AppShell";
import PropPresetSelect from "../../components/PropPresetSelect";
import {
  BACKTEST_INTERVALS,
  STRATEGIES,
  STRATEGY_PARAMS,
  getBackendInterval,
  type StrategyValue,
} from "../../constants";
import {
  createExperiment,
  fetchBacktest,
  fetchExperiments,
  fetchPropPresets,
  fetchSymbols,
  runExperiment,
  type BacktestResult,
  type ExperimentCreateRequest,
  type ExperimentResult,
  type ExperimentScoringRule,
  type ExperimentStatus,
} from "../../services/api";

const field = "app-input-quiet w-full text-sm";
const label = "mb-1.5 block text-[11px] uppercase tracking-[0.18em] text-stone-500";
const section = "app-panel app-panel-elevated app-panel-section space-y-5";

const intervalMinutesMap: Record<string, number> = {
  "1m": 1,
  "1min": 1,
  "5m": 5,
  "5min": 5,
  "10m": 10,
  "10min": 10,
  "15m": 15,
  "15min": 15,
  "30m": 30,
  "30min": 30,
  "1h": 60,
  "4h": 240,
  "1d": 1440,
  "1w": 10_080,
};

const strategyProfiles: Record<
  StrategyValue,
  {
    glyph: string;
    description: string;
    note: string;
    formula: string;
    spark: number[];
    family: string;
  }
> = {
  ma_crossover: {
    glyph: "MA",
    description: "Classic trend handoff",
    note: "Fast/slow pairs that stay readable when you fan out the grid.",
    formula: "SMA(close, fast) > SMA(close, slow)",
    spark: [3, 6, 8, 5, 9, 6],
    family: "momentum",
  },
  ema_crossover: {
    glyph: "EMA",
    description: "Faster trend response",
    note: "A little twitchier, good when you want quicker handoffs.",
    formula: "EMA(close, fast) > EMA(close, slow)",
    spark: [2, 5, 9, 7, 6, 8],
    family: "momentum",
  },
  rsi_overbought: {
    glyph: "RSI",
    description: "Mean-revert stretched moves",
    note: "Works best when the thresholds stay sane and the cadence is stable.",
    formula: "RSI(close, n) < oversold or RSI(close, n) > overbought",
    spark: [8, 6, 4, 7, 5, 3],
    family: "mean reversion",
  },
  bollinger_bands: {
    glyph: "BB",
    description: "Volatility envelope fades",
    note: "Nice for seeing where parameter sensitivity gets weird fast.",
    formula: "close crosses Bollinger(close, n, std_dev) bands",
    spark: [4, 7, 5, 9, 4, 6],
    family: "volatility",
  },
};

const scoringOptions: { value: ExperimentScoringRule; label: string; blurb: string }[] = [
  {
    value: "prop_score_v1",
    label: "Prop Score v1",
    blurb: "Bias toward challenge passes, cleaner drawdown, and decent payoff quality.",
  },
  {
    value: "total_pnl",
    label: "Total PnL",
    blurb: "Rank by raw money when you mostly care about the bottom line.",
  },
  {
    value: "sharpe_ratio",
    label: "Sharpe Ratio",
    blurb: "Push cleaner risk-adjusted runs toward the top of the pile.",
  },
  {
    value: "profit_factor",
    label: "Profit Factor",
    blurb: "Favor setups that keep losses tight relative to gains.",
  },
];

const numberFormatter = new Intl.NumberFormat();
const compactFormatter = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

type SortKey = "updated" | "name" | "runs" | "status";
type SortDirection = "asc" | "desc";
type PreflightTone = "pass" | "warn";

function defaultParamInputs(strategy: StrategyValue): Record<string, string> {
  return Object.fromEntries(
    STRATEGY_PARAMS[strategy].map((param) => [param.key, String(param.default)]),
  );
}

function paramsFromBacktest(
  strategy: StrategyValue,
  values: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    STRATEGY_PARAMS[strategy].map((param) => {
      const raw = values[param.key];
      return [param.key, raw === undefined ? String(param.default) : String(raw)];
    }),
  );
}

function paramsFromSpace(
  strategy: StrategyValue,
  values: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    STRATEGY_PARAMS[strategy].map((param) => {
      const raw = values[param.key];
      if (Array.isArray(raw)) {
        return [param.key, raw.join(", ")];
      }
      return [param.key, raw === undefined ? String(param.default) : String(raw)];
    }),
  );
}

function parseNumericGrid(raw: string, key: string): number[] {
  const tokens = raw
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    throw new Error(`Add at least one value for \`${key}\`.`);
  }

  const parsed = tokens.map((token) => {
    const value = Number(token);
    if (Number.isNaN(value)) {
      throw new Error(`\`${key}\` only accepts comma-separated numbers right now.`);
    }
    return value;
  });

  return parsed.filter((value, index) => parsed.indexOf(value) === index);
}

function parseParameterSpace(
  strategy: StrategyValue,
  inputs: Record<string, string>,
): Record<string, number[]> {
  return Object.fromEntries(
    STRATEGY_PARAMS[strategy].map((param) => [
      param.key,
      parseNumericGrid(inputs[param.key] ?? "", param.key),
    ]),
  );
}

function countParameterCombos(grid: Record<string, number[]>): number {
  return Object.values(grid).reduce((count, values) => count * Math.max(values.length, 1), 1);
}

function countInvalidCombos(strategy: StrategyValue, grid: Record<string, number[]>): number {
  if (strategy === "ma_crossover" || strategy === "ema_crossover") {
    const fast = grid.fast_period ?? [];
    const slow = grid.slow_period ?? [];
    return fast.reduce(
      (count, fastValue) =>
        count + slow.filter((slowValue) => Number(fastValue) >= Number(slowValue)).length,
      0,
    );
  }

  if (strategy === "rsi_overbought") {
    const oversold = grid.oversold ?? [];
    const overbought = grid.overbought ?? [];
    return oversold.reduce(
      (count, oversoldValue) =>
        count +
        overbought.filter((overboughtValue) => Number(oversoldValue) >= Number(overboughtValue))
          .length,
      0,
    );
  }

  return 0;
}

function describeStatus(status: ExperimentStatus): string {
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

function statusTone(status: ExperimentStatus): string {
  switch (status) {
    case "completed":
      return "border-green-800/80 bg-green-950/50 text-green-200";
    case "running":
      return "border-green-800/80 bg-green-950/45 text-green-200";
    case "failed":
      return "border-red-800/80 bg-red-950/45 text-red-200";
    default:
      return "border-stone-700 bg-stone-900 text-stone-200";
  }
}

function statusSortValue(status: ExperimentStatus): number {
  switch (status) {
    case "running":
      return 0;
    case "completed":
      return 1;
    case "draft":
      return 2;
    default:
      return 3;
  }
}

function formatDate(value?: string | null): string {
  if (!value) {
    return "Not run yet";
  }

  return new Date(value).toLocaleString();
}

function formatStrategyLabel(value: string): string {
  return value.replace(/_/g, " ");
}

function formatCount(value: number): string {
  return numberFormatter.format(value);
}

function formatCompactCount(value: number): string {
  return compactFormatter.format(value);
}

function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return "<1 min";
  }
  if (minutes < 60) {
    return `${Math.max(1, Math.round(minutes))} min`;
  }
  if (minutes < 24 * 60) {
    return `${(minutes / 60).toFixed(minutes >= 120 ? 0 : 1)} hr`;
  }
  return `${(minutes / (24 * 60)).toFixed(1)} d`;
}

function resolveBackendInterval(raw?: string | null): string | null {
  if (!raw) {
    return null;
  }

  const match = BACKTEST_INTERVALS.find(
    (interval) => interval.value === raw || getBackendInterval(interval) === raw,
  );

  return match ? getBackendInterval(match) : null;
}

function buildSeedName(backtest: BacktestResult): string {
  return `${backtest.symbol} ${formatStrategyLabel(backtest.strategy.type)} sweep`;
}

function intervalMinutes(interval: string): number {
  return intervalMinutesMap[interval] ?? 60;
}

function describeComplexity(runCount: number): {
  label: string;
  tone: string;
  note: string;
} {
  if (runCount >= 180) {
    return {
      label: "Extreme",
      tone: "text-red-300",
      note: "This is getting expensive. Great for a real sweep, not great for casual poking.",
    };
  }
  if (runCount >= 90) {
    return {
      label: "High",
      tone: "text-amber-300",
      note: "Still sane, but you're definitely committing real compute now.",
    };
  }
  if (runCount >= 30) {
    return {
      label: "Medium",
      tone: "text-emerald-300",
      note: "Good middle ground for directional exploration.",
    };
  }
  return {
    label: "Low",
    tone: "text-emerald-300",
    note: "Cheap enough to validate ideas fast without much drama.",
  };
}

function buildParameterPreview(
  grid: Record<string, number[]>,
  limit: number,
): Record<string, number>[] {
  const entries = Object.entries(grid);
  const rows: Record<string, number>[] = [];

  const walk = (index: number, current: Record<string, number>) => {
    if (rows.length >= limit) {
      return;
    }

    if (index >= entries.length) {
      rows.push({ ...current });
      return;
    }

    const [key, values] = entries[index];
    for (const value of values) {
      current[key] = value;
      walk(index + 1, current);
      if (rows.length >= limit) {
        return;
      }
    }
  };

  walk(0, {});
  return rows;
}

function encodeTemplatePayload(payload: ExperimentCreateRequest): string {
  return window.btoa(JSON.stringify(payload));
}

function decodeTemplatePayload(raw: string): ExperimentCreateRequest | null {
  try {
    const parsed = JSON.parse(window.atob(raw)) as ExperimentCreateRequest;
    return parsed;
  } catch {
    return null;
  }
}

function availabilityBadge(interval: string, rows: number): {
  label: string;
  tone: string;
} {
  const minutes = intervalMinutes(interval);

  if (minutes <= 60) {
    if (rows >= 60_000) {
      return { label: "Full", tone: "bg-green-400" };
    }
    if (rows >= 20_000) {
      return { label: "Partial", tone: "bg-amber-400" };
    }
    return { label: "Sparse", tone: "bg-red-400" };
  }

  if (minutes <= 1440) {
    if (rows >= 15_000) {
      return { label: "Full", tone: "bg-green-400" };
    }
    if (rows >= 4_000) {
      return { label: "Partial", tone: "bg-amber-400" };
    }
    return { label: "Sparse", tone: "bg-red-400" };
  }

  if (rows >= 10_000) {
    return { label: "Partial", tone: "bg-amber-400" };
  }
  return { label: "Sparse", tone: "bg-red-400" };
}

export default function ExperimentsIndexPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const fromBacktestId = createMemo(
    () => new URLSearchParams(location.search).get("fromBacktestId") ?? "",
  );
  const templateSeed = createMemo(
    () => new URLSearchParams(location.search).get("template") ?? "",
  );

  const [symbols] = createResource(fetchSymbols);
  const [presets] = createResource(fetchPropPresets);
  const [experiments, { refetch: refetchExperiments }] = createResource(fetchExperiments);
  const [seedBacktest] = createResource(
    () => fromBacktestId() || undefined,
    async (id) => (id ? fetchBacktest(id) : null),
  );

  const defaultStrategy = STRATEGIES[0].value as StrategyValue;
  const defaultInterval = getBackendInterval(
    BACKTEST_INTERVALS.find((interval) => interval.value === "15m") ?? BACKTEST_INTERVALS[0],
  );

  const [name, setName] = createSignal("Momentum sweep");
  const [selectedSymbols, setSelectedSymbols] = createSignal<string[]>([]);
  const [selectedIntervals, setSelectedIntervals] = createSignal<string[]>([defaultInterval]);
  const [strategy, setStrategy] = createSignal<StrategyValue>(defaultStrategy);
  const [paramInputs, setParamInputs] = createSignal<Record<string, string>>(
    defaultParamInputs(defaultStrategy),
  );
  const [selectedPresetName, setSelectedPresetName] = createSignal("");
  const [startDate, setStartDate] = createSignal("");
  const [endDate, setEndDate] = createSignal("");
  const [scoringRule, setScoringRule] = createSignal<ExperimentScoringRule>("prop_score_v1");
  const [initialBalance, setInitialBalance] = createSignal(100_000);
  const [positionSize, setPositionSize] = createSignal(1);
  const [commission, setCommission] = createSignal(5);
  const [slippageTicks, setSlippageTicks] = createSignal(1);
  const [executionMode, setExecutionMode] = createSignal<"bar" | "synthetic_quotes">("bar");
  const [spreadTicks, setSpreadTicks] = createSignal(1);
  const [volatileBarThresholdTicks, setVolatileBarThresholdTicks] = createSignal(0);
  const [volatileBarExtraTicks, setVolatileBarExtraTicks] = createSignal(0);
  const [busyAction, setBusyAction] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [appliedSeedId, setAppliedSeedId] = createSignal("");
  const [appliedTemplate, setAppliedTemplate] = createSignal("");
  const [sweepIntervals, setSweepIntervals] = createSignal(false);
  const [validatedSignature, setValidatedSignature] = createSignal("");
  const [sortKey, setSortKey] = createSignal<SortKey>("updated");
  const [sortDirection, setSortDirection] = createSignal<SortDirection>("desc");
  const [showShortcuts, setShowShortcuts] = createSignal(false);
  const [copiedTemplate, setCopiedTemplate] = createSignal(false);

  const selectedPreset = createMemo(
    () => (presets.error ? undefined : presets())?.find((preset) => preset.name === selectedPresetName()) ?? null,
  );
  const selectedStrategyProfile = createMemo(() => strategyProfiles[strategy()]);
  const selectedSymbolRecords = createMemo(() => {
    const lookup = new Set(selectedSymbols());
    return ((symbols.error ? undefined : symbols()) ?? []).filter((symbol) => lookup.has(symbol.symbol));
  });
  const coverageStats = createMemo(() => {
    const records = selectedSymbolRecords();
    if (records.length === 0) {
      return {
        hasCoverage: false,
        minRows: 0,
        overlapDays: 0,
        overlapStart: null as string | null,
        overlapEnd: null as string | null,
      };
    }

    const minRows = Math.min(...records.map((record) => record.rows));
    const overlapStartMs = Math.max(...records.map((record) => Date.parse(record.start_date)));
    const overlapEndMs = Math.min(...records.map((record) => Date.parse(record.end_date)));
    const overlapDays = Math.max(
      0,
      Math.round((overlapEndMs - overlapStartMs) / (1000 * 60 * 60 * 24)),
    );

    return {
      hasCoverage: overlapEndMs > overlapStartMs,
      minRows,
      overlapDays,
      overlapStart: Number.isFinite(overlapStartMs) ? new Date(overlapStartMs).toISOString() : null,
      overlapEnd: Number.isFinite(overlapEndMs) ? new Date(overlapEndMs).toISOString() : null,
    };
  });
  const parsedGrid = createMemo(() => {
    try {
      return {
        grid: parseParameterSpace(strategy(), paramInputs()),
        error: null as string | null,
      };
    } catch (errorValue) {
      return {
        grid: null as Record<string, number[]> | null,
        error:
          errorValue instanceof Error ? errorValue.message : "Check the parameter grid values.",
      };
    }
  });
  const parameterComboCount = createMemo(() =>
    parsedGrid().grid ? countParameterCombos(parsedGrid().grid!) : 0,
  );
  const invalidComboCount = createMemo(() =>
    parsedGrid().grid ? countInvalidCombos(strategy(), parsedGrid().grid!) : 0,
  );
  const estimatedRunCount = createMemo(
    () => selectedSymbols().length * selectedIntervals().length * parameterComboCount(),
  );
  const requestedRangeDays = createMemo(() => {
    if (startDate() && endDate()) {
      const diff =
        (Date.parse(endDate()) - Date.parse(startDate())) / (1000 * 60 * 60 * 24);
      return Math.max(1, Math.round(diff) + 1);
    }
    if (coverageStats().overlapDays > 0) {
      return Math.max(30, Math.min(coverageStats().overlapDays, 365));
    }
    return 90;
  });
  const runtimeEstimateMinutes = createMemo(() => {
    const runs = estimatedRunCount();
    if (runs === 0) {
      return 0;
    }
    const secondsPerRun =
      3.2 +
      STRATEGY_PARAMS[strategy()].length * 0.65 +
      requestedRangeDays() / 120 +
      selectedIntervals().length * 0.3;
    return (runs * secondsPerRun) / 60;
  });
  const complexity = createMemo(() => describeComplexity(estimatedRunCount()));
  const queueDepth = createMemo(
    () => ((experiments.error ? undefined : experiments()) ?? []).filter((experiment) => experiment.status === "running").length,
  );
  const builderSignature = createMemo(() =>
    JSON.stringify({
      name: name().trim(),
      selectedSymbols: selectedSymbols(),
      selectedIntervals: selectedIntervals(),
      strategy: strategy(),
      paramInputs: paramInputs(),
      selectedPresetName: selectedPresetName(),
      startDate: startDate(),
      endDate: endDate(),
      scoringRule: scoringRule(),
      initialBalance: initialBalance(),
      positionSize: positionSize(),
      commission: commission(),
      slippageTicks: slippageTicks(),
      executionMode: executionMode(),
      spreadTicks: spreadTicks(),
      volatileBarThresholdTicks: volatileBarThresholdTicks(),
      volatileBarExtraTicks: volatileBarExtraTicks(),
    }),
  );
  const isValidated = createMemo(
    () => validatedSignature() !== "" && validatedSignature() === builderSignature(),
  );
  const correlationRisk = createMemo(() => {
    if (selectedIntervals().length < 2) {
      return false;
    }
    const indices = selectedIntervals()
      .map((interval) =>
        BACKTEST_INTERVALS.findIndex((candidate) => getBackendInterval(candidate) === interval),
      )
      .filter((index) => index >= 0)
      .sort((a, b) => a - b);

    if (indices.length < 2) {
      return false;
    }

    const clustered =
      indices[indices.length - 1] - indices[0] <= Math.max(indices.length, 2) &&
      (strategy() === "ma_crossover" || strategy() === "ema_crossover");

    return clustered;
  });
  const nyquistWarning = createMemo(() => {
    const grid = parsedGrid().grid;
    if (!grid || selectedIntervals().length === 0) {
      return null;
    }

    const baseKey =
      strategy() === "ma_crossover" || strategy() === "ema_crossover"
        ? "fast_period"
        : strategy() === "rsi_overbought"
          ? "rsi_period"
          : "bb_period";
    const periods = grid[baseKey] ?? [];
    const minPeriod = periods.length > 0 ? Math.min(...periods) : 0;
    const maxInterval = Math.max(...selectedIntervals().map((interval) => intervalMinutes(interval)));

    if ((maxInterval >= 240 && minPeriod < 6) || (maxInterval >= 1440 && minPeriod < 12)) {
      return "The shortest lookback uses very few bars at this interval. Review signal stability before comparing results.";
    }

    return null;
  });
  const previewRuns = createMemo(() => {
    const grid = parsedGrid().grid;
    if (!grid || selectedSymbols().length === 0 || selectedIntervals().length === 0) {
      return [] as {
        symbol: string;
        interval: string;
        params: Record<string, number>;
      }[];
    }

    const params = buildParameterPreview(grid, 10);
    const rows: { symbol: string; interval: string; params: Record<string, number> }[] = [];

    for (const symbol of selectedSymbols()) {
      for (const interval of selectedIntervals()) {
        for (const combo of params) {
          rows.push({ symbol, interval, params: combo });
          if (rows.length >= 10) {
            return rows;
          }
        }
      }
    }

    return rows;
  });
  const preflightChecks = createMemo(
    () =>
      [
        {
          label: "Sufficient data coverage",
          tone: coverageStats().hasCoverage && coverageStats().minRows >= 20_000 ? "pass" : "warn",
          detail: coverageStats().hasCoverage
            ? `${formatCompactCount(coverageStats().minRows)} overlapping bars across the selected symbols.`
            : "Selected symbols do not share a clean date overlap yet.",
        },
        {
          label: "Strategy grid within bounds",
          tone: parsedGrid().error || invalidComboCount() > 0 ? "warn" : "pass",
          detail:
            parsedGrid().error ??
            (invalidComboCount() > 0
              ? "Some parameter pairs violate the basic ordering rules."
              : "Parameter relationships look internally consistent."),
        },
        {
          label: "Cross-run correlation watch",
          tone: correlationRisk() ? "warn" : "pass",
          detail: correlationRisk()
            ? "Nearby intervals with the same trend family will likely tell a very similar story."
            : "No adjacent-interval flag for this configuration. Return correlations have not been measured.",
        },
        {
          label: "Lookback / interval check",
          tone: nyquistWarning() ? "warn" : "pass",
          detail:
            nyquistWarning() ??
            "No coarse-interval flag for these lookbacks. This check does not test data leakage.",
        },
        {
          label: "Out-of-sample evidence",
          tone: "warn",
          detail: "A parameter sweep does not establish robustness. Review walk-forward and holdout evidence in Alpha Lab.",
        },
      ] as { label: string; tone: PreflightTone; detail: string }[],
  );
  const launchGaugeRatio = createMemo(() => Math.min(estimatedRunCount() / 250, 1));
  const launchGaugeColor = createMemo(() => {
    if (estimatedRunCount() >= 180) {
      return "#f97316";
    }
    if (estimatedRunCount() >= 90) {
      return "#facc15";
    }
    return "#a1a1aa";
  });
  const recentWinner = createMemo(
    () => ((experiments.error ? undefined : experiments()) ?? []).find((experiment) => experiment.status === "completed") ?? null,
  );
  const sortedExperiments = createMemo(() => {
    const direction = sortDirection() === "asc" ? 1 : -1;
    const list = [...((experiments.error ? undefined : experiments()) ?? [])];

    list.sort((left, right) => {
      if (sortKey() === "name") {
        return left.name.localeCompare(right.name) * direction;
      }
      if (sortKey() === "runs") {
        return (left.total_runs - right.total_runs) * direction;
      }
      if (sortKey() === "status") {
        return (statusSortValue(left.status) - statusSortValue(right.status)) * direction;
      }
      return (
        (Date.parse(left.last_run_at ?? left.updated_at) -
          Date.parse(right.last_run_at ?? right.updated_at)) * direction
      );
    });

    return list;
  });
  const validationError = createMemo(() => {
    if (!name().trim()) {
      return "Experiment name is required.";
    }
    if (selectedSymbols().length === 0) {
      return "Pick at least one symbol.";
    }
    if (selectedIntervals().length === 0) {
      return "Pick at least one interval.";
    }
    if (startDate() && endDate() && Date.parse(endDate()) < Date.parse(startDate())) {
      return "Your end date is earlier than your start date.";
    }
    if (!selectedPreset()) {
      return "Choose a prop-firm preset.";
    }
    if (parsedGrid().error) {
      return parsedGrid().error;
    }
    if (initialBalance() <= 0) {
      return "Initial balance has to be above zero.";
    }
    if (positionSize() <= 0) {
      return "Position size has to be above zero.";
    }
    if (commission() < 0) {
      return "Commission can't be negative.";
    }
    if (slippageTicks() < 0) {
      return "Slippage ticks can't be negative.";
    }
    if (spreadTicks() < 1) {
      return "Spread ticks has to be at least 1.";
    }
    if (volatileBarThresholdTicks() < 0 || volatileBarExtraTicks() < 0) {
      return "Volatility spread settings can't be negative.";
    }
    if (invalidComboCount() > 0) {
      return strategy() === "rsi_overbought"
        ? "The RSI grid includes oversold values that are not below overbought."
        : "The grid includes fast periods that are not below slow periods.";
    }
    if (estimatedRunCount() === 0) {
      return "This batch doesn't expand to any runs yet.";
    }
    if (estimatedRunCount() > 250) {
      return `This expands to ${estimatedRunCount()} runs. Keep it under 250 so it stays usable.`;
    }
    if (!coverageStats().hasCoverage) {
      return "Those symbols do not share enough overlapping coverage for a clean sweep.";
    }
    return null;
  });

  const hydrateFromRequest = (request: ExperimentCreateRequest, titleSuffix = "") => {
    const nextStrategy = request.strategy_type as StrategyValue;

    batch(() => {
      setName(titleSuffix ? `${request.name} ${titleSuffix}`.trim() : request.name);
      setSelectedSymbols(request.symbols);
      setSelectedIntervals(request.intervals);
      setStrategy(nextStrategy);
      setParamInputs(paramsFromSpace(nextStrategy, request.parameter_space));
      setSelectedPresetName(request.prop_firm_rules.name);
      setStartDate(request.start_date ?? "");
      setEndDate(request.end_date ?? "");
      setScoringRule(request.scoring_rule);
      setInitialBalance(request.initial_balance);
      setPositionSize(request.position_size);
      setCommission(request.commission);
      setSlippageTicks(request.slippage_ticks ?? 1);
      setExecutionMode(request.execution_mode ?? "bar");
      setSpreadTicks(request.spread_ticks ?? 1);
      setVolatileBarThresholdTicks(request.volatile_bar_threshold_ticks ?? 0);
      setVolatileBarExtraTicks(request.volatile_bar_extra_ticks ?? 0);
      setError(null);
      setValidatedSignature("");
    });
  };

  const hydrateFromExperiment = (experiment: ExperimentResult) => {
    hydrateFromRequest(
      {
        name: experiment.name,
        symbols: experiment.symbols,
        intervals: experiment.intervals,
        strategy_type: experiment.strategy_type,
        parameter_space: experiment.parameter_space,
        start_date: experiment.start_date,
        end_date: experiment.end_date,
        prop_firm_rules: experiment.prop_firm_rules,
        initial_balance: experiment.initial_balance,
        position_size: experiment.position_size,
        commission: experiment.commission,
        slippage_ticks: experiment.slippage_ticks,
        execution_mode: experiment.execution_mode,
        spread_ticks: experiment.spread_ticks,
        volatile_bar_threshold_ticks: experiment.volatile_bar_threshold_ticks,
        volatile_bar_extra_ticks: experiment.volatile_bar_extra_ticks,
        scoring_rule: experiment.scoring_rule,
      },
      "clone",
    );
  };

  const toggleValue = (values: string[], nextValue: string) => {
    if (values.includes(nextValue)) {
      return values.filter((value) => value !== nextValue);
    }
    return [...values, nextValue];
  };

  const buildPayload = (): ExperimentCreateRequest => {
    const preset = selectedPreset();
    const grid = parsedGrid().grid;
    if (!preset || !grid || validationError()) {
      throw new Error(validationError() ?? "Experiment form is missing something important.");
    }

    return {
      name: name().trim(),
      symbols: selectedSymbols(),
      intervals: selectedIntervals(),
      strategy_type: strategy(),
      parameter_space: grid,
      start_date: startDate() || undefined,
      end_date: endDate() || undefined,
      prop_firm_rules: preset,
      initial_balance: initialBalance(),
      position_size: positionSize(),
      commission: commission(),
      slippage_ticks: slippageTicks(),
      execution_mode: executionMode(),
      spread_ticks: spreadTicks(),
      volatile_bar_threshold_ticks: volatileBarThresholdTicks(),
      volatile_bar_extra_ticks: volatileBarExtraTicks(),
      scoring_rule: scoringRule(),
    };
  };

  const handleValidate = () => {
    const nextError = validationError();
    if (nextError) {
      setError(nextError);
      setValidatedSignature("");
      return;
    }

    batch(() => {
      setError(null);
      setValidatedSignature(builderSignature());
    });
  };

  const handleCreate = async (runNow: boolean) => {
    batch(() => {
      setBusyAction(runNow ? "launch" : "save");
      setError(null);
    });

    try {
      const created = await createExperiment(buildPayload());
      if (runNow) {
        await runExperiment(created.experiment_id);
      }
      await refetchExperiments();
      navigate(`/experiments/${created.experiment_id}`);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : "Experiment create failed.");
    } finally {
      setBusyAction(null);
    }
  };

  const handleRunSaved = async (experimentId: string) => {
    batch(() => {
      setBusyAction(experimentId);
      setError(null);
    });

    try {
      await runExperiment(experimentId);
      await refetchExperiments();
      navigate(`/experiments/${experimentId}`);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : "Experiment run failed.");
    } finally {
      setBusyAction(null);
    }
  };

  const handleCopyTemplate = async () => {
    try {
      const payload = buildPayload();
      const url = new URL(window.location.href);
      url.searchParams.set("template", encodeTemplatePayload(payload));
      url.searchParams.delete("fromBacktestId");
      await navigator.clipboard.writeText(url.toString());
      setCopiedTemplate(true);
      window.setTimeout(() => setCopiedTemplate(false), 1800);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : "Template copy failed.");
    }
  };

  const toggleSort = (nextKey: SortKey) => {
    if (sortKey() === nextKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }

    setSortKey(nextKey);
    setSortDirection(nextKey === "name" ? "asc" : "desc");
  };

  createEffect(() => {
    const availableSymbols = (symbols.error ? undefined : symbols());
    if (!availableSymbols || availableSymbols.length === 0 || selectedSymbols().length > 0) {
      return;
    }

    setSelectedSymbols([availableSymbols[0].symbol]);
  });

  createEffect(() => {
    const preset = selectedPreset();
    if (!preset) {
      return;
    }

    setInitialBalance(preset.account_size);
  });

  createEffect(() => {
    const seed = (seedBacktest.error ? undefined : seedBacktest());
    const seedId = fromBacktestId();
    if (!seed || !seedId || appliedSeedId() === seedId || templateSeed()) {
      return;
    }

    const nextStrategy = seed.strategy.type as StrategyValue;
    const nextInterval = resolveBackendInterval(seed.replay_context?.interval) ?? defaultInterval;

    batch(() => {
      setName(buildSeedName(seed));
      setSelectedSymbols(seed.symbol ? [seed.symbol] : selectedSymbols());
      setSelectedIntervals([nextInterval]);
      setStrategy(nextStrategy);
      setParamInputs(paramsFromBacktest(nextStrategy, seed.strategy.params));
      setSelectedPresetName(seed.prop_firm_rules.name);
      setInitialBalance(seed.prop_firm_rules.account_size);
      setStartDate(seed.replay_context?.start_date ?? "");
      setEndDate(seed.replay_context?.end_date ?? "");
      setSlippageTicks(seed.run_config?.slippage_ticks ?? 1);
      setExecutionMode(seed.run_config?.execution_mode ?? "bar");
      setSpreadTicks(seed.run_config?.spread_ticks ?? 1);
      setVolatileBarThresholdTicks(seed.run_config?.volatile_bar_threshold_ticks ?? 0);
      setVolatileBarExtraTicks(seed.run_config?.volatile_bar_extra_ticks ?? 0);
      setAppliedSeedId(seedId);
      setValidatedSignature("");
    });
  });

  createEffect(() => {
    const template = templateSeed();
    if (!template || appliedTemplate() === template) {
      return;
    }

    const decoded = decodeTemplatePayload(template);
    if (!decoded) {
      setError("Invalid template link.");
      setAppliedTemplate(template);
      return;
    }

    hydrateFromRequest(decoded);
    setAppliedTemplate(template);
  });

  createEffect(() => {
    const signature = builderSignature();
    if (validatedSignature() && validatedSignature() !== signature) {
      setValidatedSignature("");
    }
  });

  createEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isTyping = tag === "input" || tag === "textarea" || tag === "select";

      if (event.key === "?" && !isTyping) {
        event.preventDefault();
        setShowShortcuts((current) => !current);
      }

      if (event.key === "Escape") {
        setShowShortcuts(false);
      }
    };

    window.addEventListener("keydown", handleShortcut);
    onCleanup(() => window.removeEventListener("keydown", handleShortcut));
  });

  return (
    <AppShell
      title="Experiments"
      subtitle="Compare strategy settings, review the trade-offs, then validate promising results in Alpha Lab."
      actions={
        <>
          <A href="/backtests" class="app-button-secondary">
            Backtests
          </A>
          <A href="/backtests/new" class="app-button-secondary">
            Single Backtest
          </A>
        </>
      }
    >
      <ResearchWorkflow active="/experiments" />
      <nav class="research-section-nav" aria-label="Experiment sections"><a href="#sweep-builder">Build a sweep</a><a href="#sweep-review">Review & launch</a><a href="#saved-experiments">Saved experiments</a></nav>
      <Show when={experiments.error || symbols.error || presets.error}><DataLoadError title="Research data could not load" error={experiments.error || symbols.error || presets.error} onRetry={() => window.location.reload()} /></Show>
      <div id="sweep-builder" class="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
        <div class="space-y-6">
          <Show when={error()}>
            <div class="rounded-md border border-red-800/80 bg-red-950/40 px-4 py-3 text-sm text-red-200">
              {error()}
            </div>
          </Show>

          <Show when={(seedBacktest.error ? undefined : seedBacktest())}>
            {(seed) => (
              <section class={section}>
                <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div class="space-y-2">
                    <p class="app-kicker">Seeded From Backtest</p>
                    <p class="text-sm font-semibold text-stone-100">
                      Starting from `{seed().backtest_id.slice(0, 8)}`
                    </p>
                    <p class="text-sm text-stone-400">
                      Symbol, interval, params, dates, and prop rules are already loaded.
                    </p>
                  </div>
                  <A href={`/backtests/${seed().backtest_id}`} class="app-button-secondary">
                    Open Source Run
                  </A>
                </div>
              </section>
            )}
          </Show>

          <section class={section}>
            <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div class="space-y-2">
                <p class="app-kicker">Batch Builder</p>
                <h2 class="text-xl font-semibold text-stone-100">Configure a parameter sweep</h2>
              </div>
              <div class="flex flex-wrap gap-2">
                <Show when={recentWinner()}>
                  {(winner) => (
                    <button
                      type="button"
                      onClick={() => hydrateFromExperiment(winner())}
                      class="app-button-secondary"
                    >
                      Use latest completed sweep
                    </button>
                  )}
                </Show>
                <button
                  type="button"
                  onClick={() => setShowShortcuts(true)}
                  class="app-button-secondary"
                >
                  Shortcut Guide
                </button>
              </div>
            </div>

            <div class="app-hairline" />

            <div class="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(260px,0.9fr)]">
              <div
                class={`rounded-lg border px-5 py-5 ${
                  estimatedRunCount() >= 180
                    ? "app-shake-soft border-amber-700/60 bg-amber-950/15"
                    : "border-stone-700/60 bg-stone-900/40"
                }`}
              >
                <div class="flex items-center justify-between gap-3">
                  <p class="text-xs uppercase tracking-[0.22em] text-stone-500">Live Scope Preview</p>
                  <p class="app-data shrink-0 whitespace-nowrap text-xs uppercase tracking-[0.16em] text-stone-600">
                    <span class={`font-semibold ${complexity().tone}`}>{complexity().label}</span>
                    <span class="text-stone-600"> complexity</span>
                  </p>
                </div>
                <div class="mt-3 flex items-baseline gap-3">
                  <span class="app-data text-4xl font-semibold text-white">
                    {formatCount(estimatedRunCount())}
                  </span>
                  <span class="text-sm text-stone-400">total backtests</span>
                </div>
                <p class="app-data mt-2 text-xs text-stone-400">
                  <span class="text-stone-100">{selectedSymbols().length}</span> sym
                  <span class="text-stone-600"> · </span>
                  <span class="text-stone-100">{selectedIntervals().length}</span> int
                  <span class="text-stone-600"> · </span>
                  <span class="text-stone-100">{parameterComboCount()}</span> params
                </p>
              </div>

              <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                <div class="rounded-md border border-stone-800 bg-stone-950/80 px-4 py-4">
                  <p class="text-xs uppercase tracking-[0.18em] text-stone-500">Runtime</p>
                  <p class="app-data mt-2 text-2xl font-semibold text-stone-100">
                    {formatDuration(runtimeEstimateMinutes())}
                  </p>
                </div>
                <div class="rounded-md border border-stone-800 bg-stone-950/80 px-4 py-4">
                  <p class="text-xs uppercase tracking-[0.18em] text-stone-500">Coverage Overlap</p>
                  <p class="app-data mt-2 text-2xl font-semibold text-stone-100">
                    {coverageStats().hasCoverage ? `${coverageStats().overlapDays}d` : "0d"}
                  </p>
                </div>
              </div>
            </div>

            <div class="grid gap-3 md:grid-cols-2">
              <div>
                <label for="experiment-field-1" class={label}>Experiment name</label>
                <input id="experiment-field-1"
                  class={field}
                  value={name()}
                  onInput={(event) => setName(event.currentTarget.value)}
                  placeholder="Nasdaq crossover sweep"
                />
              </div>

              <div>
                <label for="experiment-field-2" class={label}>Scoring rule</label>
                <select id="experiment-field-2"
                  class={field}
                  value={scoringRule()}
                  onChange={(event) =>
                    setScoringRule(event.currentTarget.value as ExperimentScoringRule)
                  }
                >
                  <For each={scoringOptions}>
                    {(option) => <option value={option.value}>{option.label}</option>}
                  </For>
                </select>
              </div>
            </div>

            <div class="grid gap-3 md:grid-cols-2">
              <div>
                <label for="experiment-field-3" class={label}>Start date</label>
                <input id="experiment-field-3"
                  type="date"
                  class={field}
                  value={startDate()}
                  onInput={(event) => setStartDate(event.currentTarget.value)}
                />
              </div>
              <div>
                <label for="experiment-field-4" class={label}>End date</label>
                <input id="experiment-field-4"
                  type="date"
                  class={field}
                  value={endDate()}
                  onInput={(event) => setEndDate(event.currentTarget.value)}
                />
              </div>
            </div>
          </section>

          <section class={section}>
            <div class="space-y-2">
              <p class="text-sm font-semibold text-stone-100">1. Coverage</p>
              <div class="app-hairline" />
            </div>

            <div>
              <label class={label}>Symbols</label>
              <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                <For each={(symbols.error ? undefined : symbols()) ?? []}>
                  {(symbol) => {
                    const checked = () => selectedSymbols().includes(symbol.symbol);
                    return (
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedSymbols((current) => toggleValue(current, symbol.symbol))
                        }
                        class={`rounded-md border px-4 py-3 text-left transition-all ${
                          checked()
                            ? "app-card-glow"
                            : "border-white/8 bg-white/[0.03] text-stone-300 hover:border-white/16"
                        }`}
                      >
                        <div class="flex items-start justify-between gap-3">
                          <div>
                            <p class="text-sm font-semibold">{symbol.symbol}</p>
                            <p class="mt-1 text-xs text-stone-400">{symbol.full_name}</p>
                          </div>
                          <span class="app-data text-xs text-stone-500">{formatCompactCount(symbol.rows)}</span>
                        </div>
                      </button>
                    );
                  }}
                </For>
              </div>
              <Show when={!symbols.loading && ((symbols.error ? undefined : symbols()) ?? []).length === 0}>
                <p class="rounded-sm border border-yellow-700 bg-yellow-950 px-4 py-3 text-sm text-yellow-300">
                  No market data is loaded yet, so there are no symbols to sweep. Import historical
                  candles, then refresh this page.
                </p>
              </Show>
            </div>

            <div class="app-surface-muted p-4">
              <div class="flex items-center justify-between gap-3">
                <label class={label}>Interval</label>
                <button
                  type="button"
                  onClick={() =>
                    setSweepIntervals((current) => {
                      const next = !current;
                      if (!next && selectedIntervals().length > 1) {
                        setSelectedIntervals([selectedIntervals()[0]]);
                      }
                      return next;
                    })
                  }
                  class="text-[11px] uppercase tracking-[0.18em] text-stone-500 hover:text-stone-300"
                >
                  {sweepIntervals() ? "− Single" : "+ Sweep multiple"}
                </button>
              </div>

              <div class="mt-3 flex flex-wrap gap-1.5">
                <For each={BACKTEST_INTERVALS}>
                  {(interval) => {
                    const backendValue = getBackendInterval(interval);
                    const checked = () => selectedIntervals().includes(backendValue);
                    const sparse = () =>
                      availabilityBadge(backendValue, coverageStats().minRows || 0).label === "Sparse";

                    return (
                      <button
                        type="button"
                        disabled={sparse() && !checked()}
                        onClick={() => {
                          if (sweepIntervals()) {
                            setSelectedIntervals((current) =>
                              current.includes(backendValue)
                                ? current.length === 1
                                  ? current
                                  : current.filter((v) => v !== backendValue)
                                : [...current, backendValue],
                            );
                          } else {
                            setSelectedIntervals([backendValue]);
                          }
                        }}
                        class={`app-data rounded-sm border px-3 py-1.5 text-xs transition-colors ${
                          checked()
                            ? "border-[rgba(232,223,209,0.86)] bg-[rgba(235,227,213,1)] text-[#171411]"
                            : sparse()
                              ? "cursor-not-allowed border-white/6 bg-white/[0.02] text-stone-700"
                              : "border-white/8 bg-white/[0.03] text-stone-300 hover:border-white/16"
                        }`}
                        title={sparse() ? "Not enough bars at this timeframe" : undefined}
                      >
                        {interval.value}
                      </button>
                    );
                  }}
                </For>
              </div>
            </div>
          </section>

          <section class={section}>
            <div class="space-y-2">
              <p class="text-sm font-semibold text-stone-100">2. Strategy Grid</p>
              <div class="app-hairline" />
            </div>

            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <p class="text-sm text-stone-200">
                {STRATEGIES.find((item) => item.value === strategy())?.label}
                <span class="ml-2 text-xs text-stone-500">
                  {STRATEGY_PARAMS[strategy()].length} params
                </span>
              </p>
              <p class="app-data text-xs text-stone-500">
                {selectedStrategyProfile().formula}
              </p>
            </div>

            <div class="grid gap-3 md:grid-cols-2">
              <For each={STRATEGIES}>
                {(item) => {
                  const profile = strategyProfiles[item.value];
                  const checked = () => strategy() === item.value;
                  return (
                    <button
                      type="button"
                      title={profile.formula}
                      onClick={() => {
                        const nextStrategy = item.value as StrategyValue;
                        batch(() => {
                          setStrategy(nextStrategy);
                          setParamInputs(defaultParamInputs(nextStrategy));
                          setError(null);
                        });
                      }}
                      class={`rounded-md border p-4 text-left transition-all ${
                        checked()
                          ? "app-card-glow"
                          : "border-stone-800 bg-stone-950/75 text-stone-300 hover:border-stone-600"
                      }`}
                    >
                      <div class="flex items-start justify-between gap-4">
                        <div>
                          <div class="flex items-center gap-3">
                            <span class="rounded-sm border border-stone-700 bg-stone-950/70 px-2.5 py-1.5 app-data text-xs text-stone-200">
                              {profile.glyph}
                            </span>
                            <div>
                              <p class="text-sm font-semibold text-stone-100">{item.label}</p>
                              <p class="mt-1 text-xs text-stone-400">{profile.description}</p>
                            </div>
                          </div>
                        </div>
                        <span class="rounded-full border border-stone-800 bg-stone-950/80 px-2.5 py-1 text-xs text-stone-300">
                          {STRATEGY_PARAMS[item.value].length} params
                        </span>
                      </div>

                      <div class="mt-4 flex items-end gap-1">
                        <For each={profile.spark}>
                          {(value) => (
                            <span
                              class={`w-5 ${
                                checked() ? "bg-stone-200/90" : "bg-stone-700/80"
                              }`}
                              style={{ height: `${12 + value * 3}px` }}
                            />
                          )}
                        </For>
                      </div>

                      <p class="mt-3 app-data text-[11px] text-stone-500">{profile.formula}</p>
                    </button>
                  );
                }}
              </For>
            </div>

            <div class="grid gap-3 md:grid-cols-2">
              <For each={STRATEGY_PARAMS[strategy()]}>
                {(param) => (
                  <div>
                    <label for={`experiment-param-${param.key}`} class={label}>{param.label}</label>
                    <input id={`experiment-param-${param.key}`}
                      class={`${field} app-data`}
                      value={paramInputs()[param.key] ?? ""}
                      onInput={(event) =>
                        setParamInputs((current) => ({
                          ...current,
                          [param.key]: event.currentTarget.value,
                        }))
                      }
                      placeholder={String(param.default)}
                    />
                  </div>
                )}
              </For>
            </div>

            <Show when={validationError()}>
              <div class="w-fit rounded-md border border-red-700/70 bg-red-950/30 px-4 py-3 text-sm text-red-200">
                {validationError()}
              </div>
            </Show>
            <Show when={!validationError() && nyquistWarning()}>
              <div class="w-fit rounded-md border border-amber-800/70 bg-amber-950/25 px-4 py-3 text-sm text-amber-100">
                {nyquistWarning()}
              </div>
            </Show>
          </section>

          <section class={section}>
            <div class="space-y-2">
              <p class="text-sm font-semibold text-stone-100">3. Guardrails + Sizing</p>
              <div class="app-hairline" />
            </div>

            <div>
              <label class={label}>Prop preset</label>
              <PropPresetSelect
                presets={(presets.error ? undefined : presets()) ?? []}
                value={selectedPresetName()}
                onChange={setSelectedPresetName}
              />
            </div>

            <div class="grid gap-3 md:grid-cols-3">
              <div>
                <label for="experiment-field-5" class={label}>Initial balance</label>
                <input id="experiment-field-5"
                  type="number"
                  min="1"
                  class={`${field} app-data`}
                  value={initialBalance()}
                  onInput={(event) => setInitialBalance(Number(event.currentTarget.value) || 0)}
                />
              </div>
              <div>
                <label for="experiment-field-6" class={label}>Position size</label>
                <input id="experiment-field-6"
                  type="number"
                  min="0.01"
                  step="0.01"
                  class={`${field} app-data`}
                  value={positionSize()}
                  onInput={(event) => setPositionSize(Number(event.currentTarget.value) || 0)}
                />
              </div>
              <div>
                <label for="experiment-field-7" class={label}>Commission</label>
                <input id="experiment-field-7"
                  type="number"
                  min="0"
                  step="0.01"
                  class={`${field} app-data`}
                  value={commission()}
                  onInput={(event) => setCommission(Number(event.currentTarget.value) || 0)}
                />
              </div>
            </div>

            <div class="grid gap-3 md:grid-cols-2">
              <div>
                <label for="experiment-field-8" class={label}>Execution mode</label>
                <select id="experiment-field-8"
                  class={field}
                  value={executionMode()}
                  onChange={(event) =>
                    setExecutionMode(event.currentTarget.value as "bar" | "synthetic_quotes")
                  }
                >
                  <option value="bar">Simple bar fills</option>
                  <option value="synthetic_quotes">Synthetic bid/ask quotes</option>
                </select>
              </div>
              <div>
                <label for="experiment-field-9" class={label}>Slippage ticks per fill</label>
                <input id="experiment-field-9"
                  type="number"
                  min="0"
                  step="0.25"
                  class={`${field} app-data`}
                  value={slippageTicks()}
                  onInput={(event) => setSlippageTicks(Number(event.currentTarget.value) || 0)}
                />
              </div>
            </div>

            <Show when={executionMode() === "synthetic_quotes"}>
              <div class="grid gap-3 md:grid-cols-3">
                <div>
                  <label for="experiment-field-10" class={label}>Base spread (ticks)</label>
                  <input id="experiment-field-10"
                    type="number"
                    min="1"
                    step="1"
                    class={`${field} app-data`}
                    value={spreadTicks()}
                    onInput={(event) => setSpreadTicks(Math.max(1, Math.round(Number(event.currentTarget.value) || 1)))}
                  />
                </div>
                <div>
                  <label for="experiment-field-11" class={label}>Volatile threshold (ticks)</label>
                  <input id="experiment-field-11"
                    type="number"
                    min="0"
                    step="1"
                    class={`${field} app-data`}
                    value={volatileBarThresholdTicks()}
                    onInput={(event) =>
                      setVolatileBarThresholdTicks(Math.max(0, Math.round(Number(event.currentTarget.value) || 0)))
                    }
                  />
                </div>
                <div>
                  <label for="experiment-field-12" class={label}>Volatile extra spread (ticks)</label>
                  <input id="experiment-field-12"
                    type="number"
                    min="0"
                    step="1"
                    class={`${field} app-data`}
                    value={volatileBarExtraTicks()}
                    onInput={(event) =>
                      setVolatileBarExtraTicks(Math.max(0, Math.round(Number(event.currentTarget.value) || 0)))
                    }
                  />
                </div>
              </div>
            </Show>
          </section>
        </div>

        <div class="space-y-6">
          <section id="sweep-review" class={section}>
            <h2 class="text-lg font-semibold">Review &amp; launch</h2>

            <div class="rounded-lg border border-stone-800 bg-stone-950/80 p-4 lg:p-5">
              <div class="mb-1">
                <div class="flex items-baseline justify-between">
                  <p class="text-[11px] uppercase tracking-[0.18em] text-stone-500">Capacity</p>
                  <p class="app-data text-sm text-stone-300">
                    {formatCount(estimatedRunCount())}
                    <span class="text-stone-500"> / 250</span>
                  </p>
                </div>
                <div class="mt-2 h-1 w-full rounded-full bg-stone-800">
                  <div
                    class="h-1 rounded-full transition-all"
                    style={{
                      width: `${launchGaugeRatio() * 100}%`,
                      "background-color": launchGaugeColor(),
                    }}
                  />
                </div>
                <p class="mt-2 text-[11px] text-stone-600">{queueDepth()} batches currently running · Timing is a heuristic, not a queue reservation</p>
              </div>

              <div class="mt-4 space-y-2">
                <div class="flex items-center justify-between gap-4 rounded-md border border-stone-800 bg-stone-950/75 px-4 py-3">
                  <div class="min-w-0">
                    <p class="text-[11px] uppercase tracking-[0.18em] text-stone-500">Rough runtime estimate</p>
                  </div>
                  <p class="app-data shrink-0 text-xl font-semibold text-stone-100">
                    {formatDuration(runtimeEstimateMinutes())}
                  </p>
                </div>
                <div class="flex items-center justify-between gap-4 rounded-md border border-stone-800 bg-stone-950/75 px-4 py-3">
                  <div class="min-w-0">
                    <p class="text-[11px] uppercase tracking-[0.18em] text-stone-500">Validation</p>
                  </div>
                  <p class="app-data shrink-0 text-xl font-semibold text-stone-100">
                    Not yet assessed
                  </p>
                </div>
              </div>
            </div>

            <div class="rounded-md border border-stone-800 bg-stone-950/80 p-4">
              <div class="flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <p class="text-sm font-semibold text-stone-100">Sweep diagnostics</p>
                </div>
                <span
                  class={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-semibold ${
                    isValidated()
                      ? "border-green-800/80 bg-green-950/45 text-green-200"
                      : "border-stone-700 bg-stone-900 text-stone-300"
                  }`}
                >
                  {isValidated() ? "Validated" : "Needs validation"}
                </span>
              </div>

              <div class="mt-4 space-y-3">
                <For each={preflightChecks()}>
                  {(check) => (
                    <div class="rounded-md border border-stone-800 bg-stone-950/70 px-4 py-3">
                      <div class="flex items-start gap-3">
                        <span class="mt-0.5 shrink-0">
                          {check.tone === "pass" ? (
                            <svg class="h-5 w-5 text-green-400" viewBox="0 0 20 20" fill="currentColor">
                              <path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clip-rule="evenodd" />
                            </svg>
                          ) : (
                            <svg class="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
                            </svg>
                          )}
                        </span>
                        <div>
                          <p class="text-sm font-medium text-stone-100">{check.label}</p>
                          <p class="mt-1 text-sm text-stone-400">{check.detail}</p>
                        </div>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </div>

            <div class="grid gap-3">
              <button
                type="button"
                disabled={!!validationError() || busyAction() !== null}
                onClick={handleValidate}
                class={`app-button-primary w-full justify-center py-3 ${
                  validationError() || busyAction() ? "cursor-not-allowed opacity-50" : ""
                }`}
              >
                {isValidated() ? "Validated for launch" : "Validate Experiment"}
              </button>

              <button
                type="button"
                disabled={!isValidated() || busyAction() !== null}
                onClick={() => handleCreate(true)}
                class={`rounded-sm px-4 py-3 text-sm font-semibold transition-colors ${
                  !isValidated() || busyAction()
                    ? "cursor-not-allowed bg-stone-800 text-stone-500"
                    : "bg-stone-100 text-stone-950 hover:bg-white"
                }`}
              >
                {busyAction() === "launch" ? "Launching batch..." : "Launch Batch"}
              </button>

              <Show when={validationError()}>
                {(reason) => (
                  <p class="text-xs text-stone-400" role="status">
                    Can't validate yet: {reason()}
                  </p>
                )}
              </Show>
              <Show when={!validationError() && !isValidated() && busyAction() === null}>
                <p class="text-xs text-stone-500">Validate the sweep to unlock Launch Batch.</p>
              </Show>

              <div class="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  disabled={!!validationError() || busyAction() !== null}
                  onClick={() => handleCreate(false)}
                  class={`app-button-secondary justify-center ${
                    validationError() || busyAction() ? "cursor-not-allowed opacity-50" : ""
                  }`}
                >
                  {busyAction() === "save" ? "Saving draft..." : "Save Draft"}
                </button>
                <button
                  type="button"
                  disabled={!!validationError() || busyAction() !== null}
                  onClick={handleCopyTemplate}
                  class={`app-button-secondary justify-center ${
                    validationError() || busyAction() ? "cursor-not-allowed opacity-50" : ""
                  }`}
                >
                  {copiedTemplate() ? "Template link copied" : "Copy Template Link"}
                </button>
              </div>
            </div>

            <Show when={isValidated()}>
              <div class="rounded-md border border-stone-800 bg-stone-950/80 p-4">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <p class="text-sm font-semibold text-stone-100">First 10 runs</p>
                    </div>
                  <span class="rounded-full border border-green-800/70 bg-green-950/40 px-3 py-1 text-xs text-green-100">
                    Preview
                  </span>
                </div>

                <div class="mt-4 overflow-x-auto">
                  <table class="min-w-full text-left text-sm">
                    <thead class="text-xs uppercase tracking-[0.18em] text-stone-500">
                      <tr>
                        <th class="pb-2 pr-4">Symbol</th>
                        <th class="pb-2 pr-4">Interval</th>
                        <For each={STRATEGY_PARAMS[strategy()]}>
                          {(param) => <th class="pb-2 pr-4">{param.label}</th>}
                        </For>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={previewRuns()}>
                        {(row) => (
                          <tr class="border-t border-stone-800/80">
                            <td class="py-3 pr-4 font-medium text-stone-100">{row.symbol}</td>
                            <td class="py-3 pr-4 text-stone-300">{row.interval}</td>
                            <For each={STRATEGY_PARAMS[strategy()]}>
                              {(param) => (
                                <td class="py-3 pr-4 app-data text-stone-300">{row.params[param.key]}</td>
                              )}
                            </For>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </div>
            </Show>

          </section>

        </div>
      </div>
          <section class={section}>
            <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 id="saved-experiments" class="text-lg font-semibold">Saved experiments</h2>
              </div>
              <div class="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => toggleSort("updated")}
                  class={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                    sortKey() === "updated"
                      ? "app-card-glow"
                      : "border-stone-700 bg-stone-950 text-stone-300 hover:border-stone-500"
                  }`}
                >
                  Last activity
                </button>
                <button
                  type="button"
                  onClick={() => toggleSort("runs")}
                  class={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                    sortKey() === "runs"
                      ? "app-card-glow"
                      : "border-stone-700 bg-stone-950 text-stone-300 hover:border-stone-500"
                  }`}
                >
                  Runs
                </button>
                <button
                  type="button"
                  onClick={() => toggleSort("status")}
                  class={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                    sortKey() === "status"
                      ? "app-card-glow"
                      : "border-stone-700 bg-stone-950 text-stone-300 hover:border-stone-500"
                  }`}
                >
                  Status
                </button>
              </div>
            </div>

            <Show when={!experiments.loading && !experiments.error} fallback={<Show when={experiments.loading}><div class="app-skeleton h-56" /></Show>}>
              <Show
                when={sortedExperiments().length > 0}
                fallback={
                  <div class="rounded-md border border-stone-800 bg-stone-950/60 px-4 py-10 text-center text-sm text-stone-500">
                    No experiments yet. Configure your first sweep above.
                  </div>
                }
              >
                <div class="overflow-x-auto rounded-md border border-stone-800 bg-stone-950/70">
                  <table class="min-w-full text-left text-sm">
                    <thead class="bg-stone-950/95 text-xs uppercase tracking-[0.18em] text-stone-500">
                      <tr>
                        <th class="px-4 py-3">Name</th>
                        <th class="px-4 py-3">Status</th>
                        <th class="px-4 py-3">Mix</th>
                        <th class="px-4 py-3">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={sortedExperiments()}>
                        {(experiment) => {
                          const completedRatio =
                            experiment.total_runs > 0
                              ? experiment.completed_runs / experiment.total_runs
                              : 0;
                          const failedRatio =
                            experiment.total_runs > 0 ? experiment.failed_runs / experiment.total_runs : 0;
                          const pendingRatio = Math.max(0, 1 - completedRatio - failedRatio);

                          return (
                            <tr class="border-t border-stone-800/80 align-top">
                              <td class="px-4 py-2.5">
                                <div class="space-y-0.5">
                                  <A
                                    href={`/experiments/${experiment.experiment_id}`}
                                    class="text-sm font-semibold text-stone-100 hover:text-white"
                                  >
                                    {experiment.name}
                                  </A>
                                  <p class="text-xs text-stone-500">
                                    {experiment.symbols.join(", ")} · {experiment.intervals.join(", ")} ·{" "}
                                    {formatStrategyLabel(experiment.strategy_type)}
                                  </p>
                                  <p class="text-[10px] uppercase tracking-[0.2em] text-stone-600">
                                    {formatDate(experiment.last_run_at ?? experiment.updated_at)}
                                  </p>
                                </div>
                              </td>
                              <td class="px-4 py-2.5">
                                <div class="space-y-1">
                                  <span
                                    class={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${statusTone(
                                      experiment.status,
                                    )}`}
                                  >
                                    {describeStatus(experiment.status)}
                                  </span>
                                  <Show when={experiment.total_runs > 0}>
                                    <p class="app-data text-xs text-stone-500">
                                      {experiment.completed_runs}/{experiment.total_runs} runs
                                    </p>
                                  </Show>
                                </div>
                              </td>
                              <td class="px-4 py-2.5">
                                <div class="w-20">
                                  <div class="flex h-2 overflow-hidden rounded-full bg-stone-900">
                                    <div
                                      class="bg-green-400"
                                      style={{ width: `${completedRatio * 100}%` }}
                                    />
                                    <div
                                      class="bg-red-400"
                                      style={{ width: `${failedRatio * 100}%` }}
                                    />
                                    <div
                                      class="bg-stone-700"
                                      style={{ width: `${pendingRatio * 100}%` }}
                                    />
                                  </div>
                                  <p class="mt-1 text-xs text-stone-500">
                                    {experiment.failed_runs} failed
                                  </p>
                                </div>
                              </td>
                              <td class="px-4 py-2.5">
                                <div class="flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    onClick={() => hydrateFromExperiment(experiment)}
                                    class="app-button-compact-secondary"
                                  >
                                    Clone
                                  </button>
                                  <Show when={experiment.status === "draft" || experiment.status === "failed"}>
                                    <button
                                      type="button"
                                      disabled={busyAction() !== null}
                                      onClick={() => handleRunSaved(experiment.experiment_id)}
                                      class={`app-button-compact-primary ${
                                        busyAction() === experiment.experiment_id
                                          ? "cursor-not-allowed opacity-50"
                                          : ""
                                      }`}
                                    >
                                      {busyAction() === experiment.experiment_id ? "Running..." : "Run"}
                                    </button>
                                  </Show>
                                  <A href={`/experiments/${experiment.experiment_id}`} class="app-button-compact-secondary">
                                    Open
                                  </A>
                                </div>
                              </td>
                            </tr>
                          );
                        }}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
            </Show>
          </section>

      <Show when={showShortcuts()}>
        <div class="fixed inset-0 z-40 flex items-center justify-center bg-stone-950/80 px-4 backdrop-blur-sm">
          <div class="w-full max-w-md rounded-[28px] border border-stone-800 bg-stone-950 p-6 shadow-2xl">
            <div class="flex items-start justify-between gap-4">
              <div>
                <p class="app-kicker">Power User</p>
                <h3 class="mt-2 text-lg font-semibold text-stone-100">Keyboard shortcuts</h3>
              </div>
              <button type="button" onClick={() => setShowShortcuts(false)} class="app-button-secondary">
                Close
              </button>
            </div>

            <div class="mt-5 space-y-3">
              <div class="flex items-center justify-between rounded-md border border-stone-800 bg-stone-950/80 px-4 py-3">
                <span class="text-sm text-stone-300">Open or close this overlay</span>
                <span class="app-kbd">?</span>
              </div>
              <div class="flex items-center justify-between rounded-md border border-stone-800 bg-stone-950/80 px-4 py-3">
                <span class="text-sm text-stone-300">Dismiss modal overlays</span>
                <span class="app-kbd">Esc</span>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </AppShell>
  );
}
