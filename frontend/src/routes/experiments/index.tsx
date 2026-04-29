import { A, useLocation, useNavigate } from "@solidjs/router";
import { batch, createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js";
import AppShell from "../../components/AppShell";
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
  type PropFirmPreset,
} from "../../services/api";

const field =
  "w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 " +
  "focus:outline-none focus:ring-1 focus:ring-zinc-500 disabled:opacity-40";
const label = "mb-1 block text-xs text-zinc-400";
const section = "app-panel app-panel-section space-y-4";

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

function groupPresets(presets: PropFirmPreset[]): Record<string, PropFirmPreset[]> {
  return presets.reduce<Record<string, PropFirmPreset[]>>((acc, preset) => {
    let firm = preset.name.split(/\s+\d/)[0].trim();
    firm = firm
      .replace(/^My Funded Futures (Rapid|Flex)?/i, "My Funded Futures")
      .replace(/^Lucid Trading /i, "Lucid Trading")
      .trim();
    (acc[firm] ??= []).push(preset);
    return acc;
  }, {});
}

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

function countInvalidCombos(
  strategy: StrategyValue,
  grid: Record<string, number[]>,
): number {
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

function statusTone(status: ExperimentResult["status"]): string {
  switch (status) {
    case "completed":
      return "border-emerald-800 bg-emerald-950/40 text-emerald-200";
    case "running":
      return "border-blue-800 bg-blue-950/40 text-blue-200";
    case "failed":
      return "border-red-800 bg-red-950/40 text-red-200";
    default:
      return "border-zinc-700 bg-zinc-900 text-zinc-200";
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

export default function ExperimentsIndexPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const fromBacktestId = createMemo(
    () => new URLSearchParams(location.search).get("fromBacktestId") ?? "",
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
  const [busyAction, setBusyAction] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [appliedSeedId, setAppliedSeedId] = createSignal("");

  const selectedPreset = createMemo(
    () => presets()?.find((preset) => preset.name === selectedPresetName()) ?? null,
  );
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
          errorValue instanceof Error ? errorValue.message : "Parameter grid looks busted.",
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
  const validationError = createMemo(() => {
    if (!name().trim()) {
      return "Give the batch a name so it isn't just mystery meat later.";
    }
    if (selectedSymbols().length === 0) {
      return "Pick at least one symbol.";
    }
    if (selectedIntervals().length === 0) {
      return "Pick at least one interval.";
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
    return null;
  });

  createEffect(() => {
    const availableSymbols = symbols();
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
    const seed = seedBacktest();
    const seedId = fromBacktestId();
    if (!seed || !seedId || appliedSeedId() === seedId) {
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
      setAppliedSeedId(seedId);
    });
  });

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
      scoring_rule: scoringRule(),
    };
  };

  const handleCreate = async (runNow: boolean) => {
    batch(() => {
      setBusyAction(runNow ? "create-run" : "create");
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

  return (
    <AppShell
      title="Experiments"
      subtitle="Parameter sweeps and ranked saved runs."
      actions={
        <>
          <A
            href="/backtests"
            class="rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
          >
            Backtests
          </A>
          <A
            href="/backtests/new"
            class="rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
          >
            Single Backtest
          </A>
        </>
      }
    >
      <div class="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
        <div class="space-y-6">
          <Show when={error()}>
            <div class="rounded-2xl border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-200">
              {error()}
            </div>
          </Show>

          <Show when={seedBacktest()}>
            {(seed) => (
              <section class={section}>
                <p class="app-kicker">Seeded From Backtest</p>
                <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <p class="text-sm font-semibold text-zinc-100">
                      Starting from `{seed().backtest_id.slice(0, 8)}`
                    </p>
                    <p class="mt-1 text-sm text-zinc-400">
                      Symbol, interval, params, dates, and rules are prefilled.
                    </p>
                  </div>
                  <A
                    href={`/backtests/${seed().backtest_id}`}
                    class="rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
                  >
                    Open Source Run
                  </A>
                </div>
              </section>
            )}
          </Show>

          <section class={section}>
            <div class="space-y-2">
              <p class="app-kicker">Batch Builder</p>
              <h2 class="text-lg font-semibold text-zinc-100">Build the next sweep</h2>
              <p class="max-w-3xl text-sm text-zinc-400">
                Choose coverage, params, and scoring.
              </p>
            </div>

            <div class="grid gap-3 md:grid-cols-2">
              <div>
                <label class={label}>Experiment name</label>
                <input
                  class={field}
                  value={name()}
                  onInput={(event) => setName(event.currentTarget.value)}
                  placeholder="Nasdaq crossover sweep"
                />
              </div>

              <div>
                <label class={label}>Scoring rule</label>
                <select
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
                <p class="mt-2 text-xs text-zinc-500">
                  {scoringOptions.find((option) => option.value === scoringRule())?.blurb}
                </p>
              </div>
            </div>

            <div class="grid gap-3 md:grid-cols-2">
              <div>
                <label class={label}>Start date</label>
                <input
                  type="date"
                  class={field}
                  value={startDate()}
                  onInput={(event) => setStartDate(event.currentTarget.value)}
                />
              </div>
              <div>
                <label class={label}>End date</label>
                <input
                  type="date"
                  class={field}
                  value={endDate()}
                  onInput={(event) => setEndDate(event.currentTarget.value)}
                />
              </div>
            </div>
          </section>

          <section class={section}>
            <div class="space-y-1">
              <p class="text-sm font-semibold text-zinc-100">1. Coverage</p>
              <p class="text-xs text-zinc-400">
                Symbols and intervals to sweep.
              </p>
            </div>

            <div>
              <label class={label}>Symbols</label>
              <div class="flex flex-wrap gap-2">
                <For each={symbols() ?? []}>
                  {(symbol) => {
                    const checked = () => selectedSymbols().includes(symbol.symbol);
                    return (
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedSymbols((current) => toggleValue(current, symbol.symbol))
                        }
                        class={`rounded-full border px-3 py-2 text-sm transition-colors ${
                          checked()
                            ? "border-blue-500 bg-blue-500/15 text-blue-100"
                            : "border-zinc-700 bg-zinc-950/60 text-zinc-300 hover:border-zinc-500"
                        }`}
                      >
                        {symbol.symbol}
                      </button>
                    );
                  }}
                </For>
              </div>
            </div>

            <div>
              <label class={label}>Intervals</label>
              <div class="flex flex-wrap gap-2">
                <For each={BACKTEST_INTERVALS}>
                  {(interval) => {
                    const backendValue = getBackendInterval(interval);
                    const checked = () => selectedIntervals().includes(backendValue);
                    return (
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedIntervals((current) => toggleValue(current, backendValue))
                        }
                        class={`rounded-full border px-3 py-2 text-sm transition-colors ${
                          checked()
                            ? "border-blue-500 bg-blue-500/15 text-blue-100"
                            : "border-zinc-700 bg-zinc-950/60 text-zinc-300 hover:border-zinc-500"
                        }`}
                      >
                        {interval.label}
                      </button>
                    );
                  }}
                </For>
              </div>
            </div>
          </section>

          <section class={section}>
            <div class="space-y-1">
              <p class="text-sm font-semibold text-zinc-100">2. Strategy Grid</p>
              <p class="text-xs text-zinc-400">
                Comma-separated values fan out the grid.
              </p>
            </div>

            <div>
              <label class={label}>Strategy type</label>
              <select
                class={field}
                value={strategy()}
                onChange={(event) => {
                  const nextStrategy = event.currentTarget.value as StrategyValue;
                  batch(() => {
                    setStrategy(nextStrategy);
                    setParamInputs(defaultParamInputs(nextStrategy));
                    setError(null);
                  });
                }}
              >
                <For each={STRATEGIES}>
                  {(item) => <option value={item.value}>{item.label}</option>}
                </For>
              </select>
            </div>

            <div class="grid gap-3 md:grid-cols-2">
              <For each={STRATEGY_PARAMS[strategy()]}>
                {(param) => (
                  <div>
                    <label class={label}>{param.label}</label>
                    <input
                      class={field}
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
              <div class="rounded-2xl border border-yellow-800 bg-yellow-950/30 px-4 py-3 text-sm text-yellow-100">
                {validationError()}
              </div>
            </Show>
          </section>

          <section class={section}>
            <div class="space-y-1">
              <p class="text-sm font-semibold text-zinc-100">3. Guardrails + Sizing</p>
              <p class="text-xs text-zinc-400">
                Prop rules and account assumptions.
              </p>
            </div>

            <div>
              <label class={label}>Prop preset</label>
              <select
                class={field}
                value={selectedPresetName()}
                onChange={(event) => setSelectedPresetName(event.currentTarget.value)}
              >
                <option value="">Select a preset...</option>
                <For each={Object.entries(groupPresets(presets() ?? []))}>
                  {([firm, options]) => (
                    <optgroup label={firm}>
                      <For each={options}>
                        {(preset) => <option value={preset.name}>{preset.name}</option>}
                      </For>
                    </optgroup>
                  )}
                </For>
              </select>
            </div>

            <div class="grid gap-3 md:grid-cols-3">
              <div>
                <label class={label}>Initial balance</label>
                <input
                  type="number"
                  min="1"
                  class={field}
                  value={initialBalance()}
                  onInput={(event) => setInitialBalance(Number(event.currentTarget.value) || 0)}
                />
              </div>
              <div>
                <label class={label}>Position size</label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  class={field}
                  value={positionSize()}
                  onInput={(event) => setPositionSize(Number(event.currentTarget.value) || 0)}
                />
              </div>
              <div>
                <label class={label}>Commission</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  class={field}
                  value={commission()}
                  onInput={(event) => setCommission(Number(event.currentTarget.value) || 0)}
                />
              </div>
            </div>
          </section>
        </div>

        <div class="space-y-6">
          <section class={section}>
            <p class="app-kicker">Launch</p>
            <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-1">
              <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Estimated Runs</p>
                <p class="mt-2 text-2xl font-semibold text-zinc-100">{estimatedRunCount()}</p>
                <p class="mt-1 text-xs text-zinc-500">
                  {selectedSymbols().length} symbols x {selectedIntervals().length} intervals x{" "}
                  {parameterComboCount()} param combos
                </p>
              </div>

              <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Scoring Bias</p>
                <p class="mt-2 text-sm font-semibold text-zinc-100">
                  {scoringOptions.find((option) => option.value === scoringRule())?.label}
                </p>
                <p class="mt-1 text-xs text-zinc-500">
                  {scoringOptions.find((option) => option.value === scoringRule())?.blurb}
                </p>
              </div>
            </div>

            <div class="flex flex-col gap-3">
              <button
                type="button"
                disabled={!!validationError() || busyAction() !== null}
                onClick={() => handleCreate(true)}
                class={`rounded-xl px-4 py-3 text-sm font-semibold transition-colors ${
                  validationError() || busyAction()
                    ? "cursor-not-allowed bg-zinc-800 text-zinc-500"
                    : "bg-zinc-100 text-zinc-950 hover:bg-white"
                }`}
              >
                {busyAction() === "create-run" ? "Creating + running..." : "Create and Run Batch"}
              </button>
              <button
                type="button"
                disabled={!!validationError() || busyAction() !== null}
                onClick={() => handleCreate(false)}
                class={`rounded-xl border px-4 py-3 text-sm font-medium transition-colors ${
                  validationError() || busyAction()
                    ? "cursor-not-allowed border-zinc-800 text-zinc-500"
                    : "border-zinc-700 text-zinc-200 hover:border-zinc-500 hover:bg-zinc-900"
                }`}
              >
                {busyAction() === "create" ? "Saving draft..." : "Save Draft First"}
              </button>
            </div>
          </section>

          <section class={section}>
            <div>
              <p class="app-kicker">Saved Batches</p>
            </div>

            <Show when={!experiments.loading} fallback={<div class="app-skeleton h-48" />}>
              <Show
                when={(experiments() ?? []).length > 0}
                fallback={
                  <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-10 text-center text-sm text-zinc-500">
                    No experiments yet. Build one on the left.
                  </div>
                }
              >
                <div class="space-y-3">
                  <For each={experiments()}>
                    {(experiment) => (
                      <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-4">
                        <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div class="space-y-2">
                            <div class="flex flex-wrap items-center gap-2">
                              <A
                                href={`/experiments/${experiment.experiment_id}`}
                                class="text-sm font-semibold text-zinc-100 hover:text-white"
                              >
                                {experiment.name}
                              </A>
                              <span
                                class={`rounded-full border px-2.5 py-1 text-xs font-medium ${statusTone(
                                  experiment.status,
                                )}`}
                              >
                                {describeStatus(experiment.status)}
                              </span>
                            </div>
                            <p class="text-xs text-zinc-500">
                              {experiment.symbols.join(", ")} | {experiment.intervals.join(", ")} |{" "}
                              {formatStrategyLabel(experiment.strategy_type)}
                            </p>
                            <p class="text-xs text-zinc-400">
                              {experiment.total_runs > 0
                                ? `${experiment.completed_runs}/${experiment.total_runs} complete with ${experiment.failed_runs} failed`
                                : "Draft only so far."}
                            </p>
                            <p class="text-xs text-zinc-500">
                              Last activity: {formatDate(experiment.last_run_at ?? experiment.updated_at)}
                            </p>
                          </div>

                          <div class="flex flex-wrap items-center gap-2">
                            <Show when={experiment.best_backtest_id}>
                              <A
                                href={`/backtests/${experiment.best_backtest_id}`}
                                class="rounded-xl border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
                              >
                                Best Backtest
                              </A>
                            </Show>
                            <Show when={experiment.status === "draft" || experiment.status === "failed"}>
                              <button
                                type="button"
                                disabled={busyAction() !== null}
                                onClick={() => handleRunSaved(experiment.experiment_id)}
                                class={`rounded-xl px-3 py-2 text-xs font-semibold transition-colors ${
                                  busyAction() === experiment.experiment_id
                                    ? "cursor-not-allowed bg-zinc-800 text-zinc-500"
                                    : "bg-zinc-100 text-zinc-950 hover:bg-white"
                                }`}
                              >
                                {busyAction() === experiment.experiment_id ? "Running..." : "Run"}
                              </button>
                            </Show>
                            <A
                              href={`/experiments/${experiment.experiment_id}`}
                              class="rounded-xl border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
                            >
                              Open
                            </A>
                          </div>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </section>
        </div>
      </div>
    </AppShell>
  );
}
