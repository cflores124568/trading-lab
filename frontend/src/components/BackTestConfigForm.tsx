import { createSignal, createResource, Show, For, batch, createEffect, createMemo } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { ChevronDown, ChevronRight } from "lucide-solid";
import { fetchSymbols, fetchPropPresets, loadSymbol, runBacktest, type SymbolInfo, type PropFirmPreset} from "../services/api";
import { BACKTEST_INTERVALS, STRATEGIES, STRATEGY_PARAMS, getBackendInterval, type StrategyValue} from "../constants";
import { defaultExecutionConfigForSymbol } from "../services/executionModel";
import { loadActiveWorkspaceContext } from "./workspace/workspacePersistence";

// Shared input styles 
const field =
  "app-input w-full text-sm disabled:cursor-not-allowed disabled:opacity-40";
const numericField = `${field} app-data`;
const label = "mb-1 block text-[11px] uppercase tracking-[0.16em] text-stone-500";
const sectionBase = "app-panel app-panel-section space-y-4 rounded-md p-4 lg:p-5";
const runStatCard = "app-surface-muted px-3 py-2";

const strategyDescriptions: Record<StrategyValue, string> = {
  ma_crossover: "Use fast and slow moving-average crossovers to capture trend shifts.",
  ema_crossover: "React faster to momentum changes with exponential moving averages.",
  rsi_overbought: "Fade stretched momentum when RSI reaches overbought or oversold zones.",
  bollinger_bands: "Trade reversion around volatility bands and mean-reversion pressure.",
};

// Group presets by firm name 
function groupPresets(presets: PropFirmPreset[]): Record<string, PropFirmPreset[]> {
  return presets.reduce<Record<string, PropFirmPreset[]>>((acc, p) => {
    // Handles variety of prop firms
    let firm = p.name.split(/\s+\d/)[0].trim();  // everything before first number
    firm = firm.replace(/^My Funded Futures (Rapid|Flex)?/i, "My Funded Futures")
               .replace(/^Lucid Trading /i, "Lucid Trading").trim();
    (acc[firm] ??= []).push(p);
    return acc;
  }, {});
}

function findPresetByPropFirm(presets: PropFirmPreset[], propFirm: string): PropFirmPreset | null {
  const cleanedFirm = propFirm.trim().toLowerCase();
  if (!cleanedFirm) {
    return null;
  }

  return (
    presets.find((preset) => preset.name.toLowerCase().includes(cleanedFirm)) ?? null
  );
}

function parseOptionalTickInput(raw: string, label: string): { value?: number; error?: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }

  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    return { error: `${label} must be greater than 0.` };
  }

  return { value };
}

function formatBracketSummary(stopLossTicks: string, takeProfitTicks: string): string {
  const stopLoss = stopLossTicks.trim();
  const takeProfit = takeProfitTicks.trim();

  if (!stopLoss && !takeProfit) {
    return "Bracket exits off";
  }

  return [
    stopLoss ? `SL ${stopLoss}t` : null,
    takeProfit ? `TP ${takeProfit}t` : null,
  ]
    .filter(Boolean)
    .join(" / ");
}

function executionModeLabel(mode: "bar" | "synthetic_quotes"): string {
  return mode === "synthetic_quotes" ? "Synthetic quotes" : "Simple bar fills";
}

function formatDailyLossLimit(limit: number | null | undefined): string {
  if (limit == null || limit === 0) {
    return "Off";
  }

  return `${(limit * 100).toFixed(0)}%`;
}

function formatStepValue(value: number, step: number): string {
  const decimals = step.toString().includes(".") ? step.toString().split(".")[1].length : 0;
  return Number(value.toFixed(decimals)).toString();
}

function StatCard(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div class={runStatCard}>
      <p class="text-[11px] uppercase tracking-[0.18em] text-stone-500">{props.label}</p>
      <p class={`mt-1 text-sm font-medium text-stone-100 ${props.mono ? "app-data" : ""}`}>
        {props.value}
      </p>
    </div>
  );
}

function StepperInput(props: {
  label: string;
  value: string;
  step?: number;
  min?: number;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const step = () => props.step ?? 1;
  const min = () => props.min;

  const current = () => {
    const parsed = Number(props.value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }

    return min() ?? 0;
  };

  const bump = (direction: -1 | 1) => {
    const next = current() + direction * step();
    const clamped = min() != null ? Math.max(min()!, next) : next;
    props.onChange(formatStepValue(clamped, step()));
  };

  return (
    <div>
      <label class={label}>{props.label}</label>
      <div class="flex items-stretch gap-2">
        <button
          type="button"
          class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-sm border border-stone-700 bg-stone-950 text-stone-300 transition-colors hover:border-stone-500 hover:bg-stone-900 hover:text-stone-100"
          onClick={() => bump(-1)}
          aria-label={`Decrease ${props.label}`}
        >
          −
        </button>
        <input
          type="number"
          min={props.min}
          step={props.step ?? 1}
          class={`${numericField} h-10 flex-1`}
          value={props.value}
          placeholder={props.placeholder}
          onInput={(e) => props.onChange(e.currentTarget.value)}
        />
        <button
          type="button"
          class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-sm border border-stone-700 bg-stone-950 text-stone-300 transition-colors hover:border-stone-500 hover:bg-stone-900 hover:text-stone-100"
          onClick={() => bump(1)}
          aria-label={`Increase ${props.label}`}
        >
          +
        </button>
      </div>
    </div>
  );
}

export default function BackTestConfigForm() {
  const navigate = useNavigate();
  const workspaceContext = createMemo(() => loadActiveWorkspaceContext());
  const [symbols] = createResource(fetchSymbols);
  const [presets] = createResource(fetchPropPresets);
  const defaultInterval = BACKTEST_INTERVALS.find((i) => i.value === "15m")!;
  const defaultStrategy = STRATEGIES[0].value as StrategyValue;
  const [symbol, setSymbol] = createSignal<SymbolInfo | null>(null);
  const [interval, setInterval] = createSignal(defaultInterval);
  const [strategy, setStrategy] = createSignal<StrategyValue>(defaultStrategy);
  const [params, setParams] = createSignal<Record<string, number>>(
    Object.fromEntries(STRATEGY_PARAMS[defaultStrategy].map((p) => [p.key, p.default]))
  );
  const [preset, setPreset] = createSignal<PropFirmPreset | null>(null);
  const [startDate, setStartDate] = createSignal("");
  const [endDate, setEndDate] = createSignal("");
  const [slippageTicks, setSlippageTicks] = createSignal(1);
  const [stopLossTicks, setStopLossTicks] = createSignal("");
  const [takeProfitTicks, setTakeProfitTicks] = createSignal("");
  const [executionMode, setExecutionMode] = createSignal<"bar" | "synthetic_quotes">("bar");
  const [spreadTicks, setSpreadTicks] = createSignal(1);
  const [volatileBarThresholdTicks, setVolatileBarThresholdTicks] = createSignal(0);
  const [volatileBarExtraTicks, setVolatileBarExtraTicks] = createSignal(0);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [step, setStep] = createSignal<"idle" | "loading-data" | "running">("idle");
  const [showStrategy, setShowStrategy] = createSignal(true);
  const [showExecution, setShowExecution] = createSignal(true);
  const [showPropFirm, setShowPropFirm] = createSignal(true);
  const [marketSeedNotice, setMarketSeedNotice] = createSignal<string | null>(null);
  const selectedStrategy = createMemo(
    () => STRATEGIES.find((item) => item.value === strategy()) ?? STRATEGIES[0]
  );
  const runSummary = createMemo(() => [
    ["Symbol", symbol()?.symbol ?? "Pick a market"],
    ["Interval", interval().label],
    ["Strategy", selectedStrategy().label],
    ["Preset", preset()?.name ?? "Choose a challenge"],
    ["Execution", executionModeLabel(executionMode())],
    ["Brackets", formatBracketSummary(stopLossTicks(), takeProfitTicks())],
  ] as [string, string][]);

  // Seed market defaults from the active workspace, then fall back to first symbol.
  let seededMarketDefaults = false;
  createEffect(() => {
    const loadedSymbols = symbols();
    if (!loadedSymbols || loadedSymbols.length === 0 || seededMarketDefaults) {
      return;
    }

    seededMarketDefaults = true;
    const context = workspaceContext();
    const defaultQuery = context?.query;
    const defaultSymbol = defaultQuery?.symbol
      ? loadedSymbols.find((candidate) => candidate.symbol === defaultQuery.symbol)
      : null;
    const defaultInterval = defaultQuery?.interval
      ? BACKTEST_INTERVALS.find((candidate) => candidate.value === defaultQuery.interval)
      : null;

    batch(() => {
      setSymbol(defaultSymbol ?? loadedSymbols[0]);
      if (defaultInterval) {
        setInterval(defaultInterval);
      }
      if (defaultQuery?.mode === "historical") {
        setStartDate(defaultQuery.startDate ?? "");
        setEndDate(defaultQuery.endDate ?? "");
      }
      if (context?.query) {
        setMarketSeedNotice(`Seeded market defaults from ${context.workspaceName}.`);
      }
    });
  });

  // Seed prop firm defaults from workspace account profile when available.
  let seededPresetDefaults = false;
  createEffect(() => {
    const loadedPresets = presets();
    if (!loadedPresets || loadedPresets.length === 0 || preset() || seededPresetDefaults) {
      return;
    }

    seededPresetDefaults = true;
    const context = workspaceContext();
    const preferred =
      context?.accountProfile.propFirm
        ? findPresetByPropFirm(loadedPresets, context.accountProfile.propFirm)
        : null;

    setPreset(preferred ?? loadedPresets[0]);
  });

  createEffect(() => {
    const defaults = defaultExecutionConfigForSymbol(symbol()?.symbol);
    batch(() => {
      setSpreadTicks(defaults.spreadTicks);
      setVolatileBarThresholdTicks(defaults.volatileBarThresholdTicks);
      setVolatileBarExtraTicks(defaults.volatileBarExtraTicks);
    });
  });

  //Submit guard
  const canRun = () => !!symbol() && !!preset() && !loading();
  // Handlers 
  function handleStrategyChange(val: StrategyValue) {
    batch(() => {
      setStrategy(val);
      setParams(
        Object.fromEntries(STRATEGY_PARAMS[val].map((p) => [p.key, p.default]))
      );
    });
  }

  function handleParamChange(key: string, raw: string) {
    const num = parseFloat(raw);
    if(!isNaN(num)){
        setParams((prev) => ({ ...prev, [key]: num }));
    }
  }

  const strategyParams = createMemo(() => STRATEGY_PARAMS[strategy()]);
  const collapsibleHeader =
    "flex w-full items-start justify-between gap-3 rounded-sm text-left transition-colors " +
    "focus:outline-none focus:ring-1 focus:ring-stone-500";

  async function handleSubmit() {
    const sym = symbol();
    const pre = preset();
    const stopLoss = parseOptionalTickInput(stopLossTicks(), "Stop loss");
    const takeProfit = parseOptionalTickInput(takeProfitTicks(), "Take profit");
    if(!sym){
        setError("Select a symbol.");
        return;
    }
    if(!pre){ 
        setError("Select a prop firm preset."); 
        return;
    }
    if (stopLoss.error) {
      setError(stopLoss.error);
      return;
    }
    if (takeProfit.error) {
      setError(takeProfit.error);
      return;
    }
    
    batch(() => { setLoading(true); setError(null); setStep("loading-data"); });

    try {
      // Register symbol as a dataset
      const dataset = await loadSymbol({
        symbol: sym.symbol,
        interval: getBackendInterval(interval()),
        start_date: startDate() || undefined,
        end_date: endDate() || undefined,
      });
      setStep("running");

      // Run backtest
      const result = await runBacktest({
        dataset_id: dataset.dataset_id,
        strategy: { type: strategy(), params: params() },
        prop_firm_rules: pre,
        start_date: startDate() || undefined,
        end_date: endDate() || undefined,
        initial_balance: pre.account_size,
        position_size: 1,
        commission: 5,
        tick_size: sym.tick_size,
        tick_value: sym.tick_value,
        slippage_ticks: slippageTicks(),
        stop_loss_ticks: stopLoss.value,
        take_profit_ticks: takeProfit.value,
        execution_mode: executionMode(),
        spread_ticks: spreadTicks(),
        volatile_bar_threshold_ticks: volatileBarThresholdTicks(),
        volatile_bar_extra_ticks: volatileBarExtraTicks(),
      });
      navigate(`/backtests/${result.backtest_id}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      batch(() => { 
        setLoading(false);
        setStep("idle"); 
    });
    }
  }

  // ── Render
  return (
    <div class="space-y-4">
      <Show when={error()}>
        <div class="rounded-sm border border-red-700 bg-red-950 px-4 py-3 text-sm text-red-300">
          {error()}
        </div>
      </Show>

      <section class="app-panel rounded-md border-l-4 border-stone-700/80 p-4 space-y-4 lg:p-5">
        <div class="space-y-2">
          <p class="app-kicker">Run Plan</p>
          <h2 class="text-lg font-medium text-stone-100">Build the next saved run</h2>
          <p class="max-w-3xl text-sm text-stone-400">
            Pick a market, set the strategy, and score it against prop-firm rules.
          </p>
          <Show when={marketSeedNotice()}>
            <p class="text-xs text-cyan-300">{marketSeedNotice()}</p>
          </Show>
        </div>

        <div class="grid gap-2 md:grid-cols-3 xl:grid-cols-5">
          <For each={runSummary()}>
            {([key, value]) => <StatCard label={key} value={value} mono />}
          </For>
        </div>
      </section>

      <section class={`${sectionBase} border-l-4 border-stone-700/80`}>
        <div class="space-y-1">
          <p class="text-sm font-medium text-stone-100">1. Market</p>
          <p class="text-xs text-stone-400">Contract, interval, and optional date range.</p>
        </div>

        <Show
          when={!symbols.loading && symbols() && symbols()!.length > 0}
          fallback={
            <Show
              when={!symbols.loading}
              fallback={<div class="h-9 rounded-sm bg-stone-800 animate-pulse" />}
            >
              <div class="rounded-sm border border-yellow-700 bg-yellow-950 px-4 py-3 text-sm text-yellow-300">
                No symbols found. Make sure your database is configured and data has been imported
                via <code class="font-mono text-yellow-200">fetch_databento.py</code>.
              </div>
            </Show>
          }
        >
          <div>
            <label class={label}>Symbol</label>
            <select
              class={field}
              value={symbol()?.symbol ?? ""}
              onChange={(e) => {
                const found = symbols()!.find((s) => s.symbol === e.currentTarget.value);
                setSymbol(found ?? null);
              }}
            >
              <option value="" disabled>
                Select a symbol…
              </option>
              <For each={symbols()}>
                {(s) => (
                  <option value={s.symbol}>
                    {s.symbol} — {s.full_name} ({s.rows.toLocaleString()} bars)
                  </option>
                )}
              </For>
            </select>
          </div>
        </Show>

        <div>
          <label class={label}>Interval</label>
          <select
            class={field}
            value={interval().value}
            onChange={(e) => {
              const found = BACKTEST_INTERVALS.find((i) => i.value === e.currentTarget.value);
              if (found) setInterval(found);
            }}
          >
            <For each={BACKTEST_INTERVALS}>
              {(i) => <option value={i.value}>{i.label}</option>}
            </For>
          </select>
        </div>

        <div class="grid gap-2 md:grid-cols-2">
          <div>
            <label class={label}>Start date (optional)</label>
            <input
              type="date"
              class={`${field} app-data`}
              value={startDate()}
              onInput={(e) => setStartDate(e.currentTarget.value)}
            />
          </div>
          <div>
            <label class={label}>End date (optional)</label>
            <input
              type="date"
              class={`${field} app-data`}
              value={endDate()}
              onInput={(e) => setEndDate(e.currentTarget.value)}
            />
          </div>
        </div>
      </section>

      <section class={`${sectionBase} border-l-4 border-stone-700/80`}>
        <button
          type="button"
          class={collapsibleHeader}
          aria-expanded={showStrategy()}
          aria-label={`${showStrategy() ? "Collapse" : "Expand"} strategy section`}
          onClick={() => setShowStrategy((value) => !value)}
        >
          <div class="space-y-1">
            <p class="text-sm font-medium text-stone-100">2. Strategy</p>
            <p class="text-xs text-stone-400">Signal model and execution parameters.</p>
          </div>
          {showStrategy() ? (
            <ChevronDown size={16} class="mt-1 shrink-0 text-stone-500" />
          ) : (
            <ChevronRight size={16} class="mt-1 shrink-0 text-stone-500" />
          )}
        </button>

        <Show when={showStrategy()}>
          <div class="space-y-4">
            <div>
              <label class={label}>Type</label>
              <select
                class={field}
                value={strategy()}
                onChange={(e) => handleStrategyChange(e.currentTarget.value as StrategyValue)}
              >
                <For each={STRATEGIES}>
                  {(s) => <option value={s.value}>{s.label}</option>}
                </For>
              </select>
            </div>

            <div class="rounded-sm border border-stone-800 bg-stone-950/60 px-4 py-3">
              <p class="text-[11px] uppercase tracking-[0.18em] text-stone-500">
                Selected Strategy
              </p>
              <p class="mt-2 text-sm font-medium text-stone-100">{selectedStrategy().label}</p>
              <p class="mt-1 text-sm text-stone-400">{strategyDescriptions[strategy()]}</p>
            </div>

            <div class="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              <For each={strategyParams()}>
                {(p) => (
                  <StepperInput
                    label={p.label}
                    value={String(params()[p.key] ?? p.default)}
                    step={p.step}
                    min={p.min}
                    onChange={(raw) => handleParamChange(p.key, raw)}
                  />
                )}
              </For>
            </div>
          </div>
        </Show>
      </section>

      <section class={`${sectionBase} border-l-4 border-stone-700/80`}>
        <button
          type="button"
          class={collapsibleHeader}
          aria-expanded={showExecution()}
          aria-label={`${showExecution() ? "Collapse" : "Expand"} execution section`}
          onClick={() => setShowExecution((value) => !value)}
        >
          <div class="space-y-1">
            <p class="text-sm font-medium text-stone-100">3. Execution</p>
            <p class="text-xs text-stone-400">
              Futures contract specs and conservative fill assumptions.
            </p>
          </div>
          {showExecution() ? (
            <ChevronDown size={16} class="mt-1 shrink-0 text-stone-500" />
          ) : (
            <ChevronRight size={16} class="mt-1 shrink-0 text-stone-500" />
          )}
        </button>

        <Show when={showExecution()}>
          <div class="space-y-4">
            <div class="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              <StatCard label="Tick size" value={symbol()?.tick_size?.toString() ?? "—"} mono />
              <StatCard
                label="Tick value"
                value={symbol() ? `$${symbol()!.tick_value.toFixed(2)}` : "—"}
                mono
              />
              <StatCard label="Commission" value="$5.00" mono />
              <StatCard label="Fill model" value={executionModeLabel(executionMode())} />
            </div>

            <div>
              <label class={label}>Execution mode</label>
              <select
                class={field}
                value={executionMode()}
                onChange={(e) => setExecutionMode(e.currentTarget.value as "bar" | "synthetic_quotes")}
              >
                <option value="bar">Simple bar fills</option>
                <option value="synthetic_quotes">Synthetic bid/ask quotes</option>
              </select>
            </div>

            <Show when={executionMode() === "synthetic_quotes"}>
              <div class="grid gap-2 md:grid-cols-3">
                <StepperInput
                  label="Base spread (ticks)"
                  value={String(spreadTicks())}
                  step={1}
                  min={1}
                  onChange={(raw) => {
                    const value = Number(raw);
                    if (!Number.isNaN(value) && value >= 1) setSpreadTicks(Math.round(value));
                  }}
                />
                <StepperInput
                  label="Volatile bar threshold (ticks)"
                  value={String(volatileBarThresholdTicks())}
                  step={1}
                  min={0}
                  onChange={(raw) => {
                    const value = Number(raw);
                    if (!Number.isNaN(value) && value >= 0) setVolatileBarThresholdTicks(Math.round(value));
                  }}
                />
                <StepperInput
                  label="Volatile bar extra spread (ticks)"
                  value={String(volatileBarExtraTicks())}
                  step={1}
                  min={0}
                  onChange={(raw) => {
                    const value = Number(raw);
                    if (!Number.isNaN(value) && value >= 0) setVolatileBarExtraTicks(Math.round(value));
                  }}
                />
              </div>
            </Show>

            <StepperInput
              label="Slippage ticks per fill"
              value={String(slippageTicks())}
              step={0.25}
              min={0}
              onChange={(raw) => {
                const value = Number(raw);
                if (!Number.isNaN(value) && value >= 0) setSlippageTicks(value);
              }}
            />

            <div class="grid gap-2 md:grid-cols-2">
              <StepperInput
                label="Stop loss ticks (optional)"
                value={stopLossTicks()}
                step={0.25}
                min={0.25}
                placeholder="Off"
                onChange={setStopLossTicks}
              />
              <StepperInput
                label="Take profit ticks (optional)"
                value={takeProfitTicks()}
                step={0.25}
                min={0.25}
                placeholder="Off"
                onChange={setTakeProfitTicks}
              />
            </div>

            <p class="text-xs text-stone-500">
              Brackets are measured from entry in ticks. If one candle tags both the stop and
              target, I treat it as stop-first so the sim stays conservative.
            </p>
            <Show when={executionMode() === "synthetic_quotes"}>
              <p class="text-xs text-stone-500">
                Synthetic mode prices market fills off bid/ask. Slippage still applies on bracket
                exits so old configs stay comparable.
              </p>
            </Show>
          </div>
        </Show>
      </section>

      <section class={`${sectionBase} border-l-4 border-stone-700/80`}>
        <button
          type="button"
          class={collapsibleHeader}
          aria-expanded={showPropFirm()}
          aria-label={`${showPropFirm() ? "Collapse" : "Expand"} prop firm section`}
          onClick={() => setShowPropFirm((value) => !value)}
        >
          <div class="space-y-1">
            <p class="text-sm font-medium text-stone-100">4. Prop Firm Rules</p>
            <p class="text-xs text-stone-400">
              Select the evaluation ruleset you want this strategy run to survive.
            </p>
          </div>
          {showPropFirm() ? (
            <ChevronDown size={16} class="mt-1 shrink-0 text-stone-500" />
          ) : (
            <ChevronRight size={16} class="mt-1 shrink-0 text-stone-500" />
          )}
        </button>

        <Show when={showPropFirm()}>
          <Show
            when={presets() && presets()!.length > 0}
            fallback={<div class="h-9 rounded-sm bg-stone-800 animate-pulse" />}
          >
            <div class="space-y-4">
              <div>
                <label class={label}>Preset</label>
                <select
                  class={field}
                  value={preset()?.name ?? ""}
                  onChange={(e) => {
                    const found = presets()?.find((p) => p.name === e.currentTarget.value);
                    setPreset(found ?? null);
                  }}
                >
                  <option value="" disabled>
                    Select a preset…
                  </option>
                  <For each={Object.entries(groupPresets(presets() ?? []))}>
                    {([firm, firmPresets]) => (
                      <optgroup label={firm}>
                        <For each={firmPresets}>
                          {(p) => <option value={p.name}>{p.name}</option>}
                        </For>
                      </optgroup>
                    )}
                  </For>
                </select>
              </div>

              <Show when={preset()}>
                {(p) => (
                  <div class="space-y-3">
                    <div class="rounded-sm border border-stone-800 bg-stone-950/60 px-4 py-3">
                      <p class="text-[11px] uppercase tracking-[0.18em] text-stone-500">
                        Evaluation Preset
                      </p>
                      <p class="mt-2 text-sm font-medium text-stone-100">{p().name}</p>
                      <p class="mt-1 text-xs text-stone-500">
                        This block is the evaluation stage only. Funded payout/account rules live separately.
                      </p>
                    </div>

                    <div class="grid gap-2 md:grid-cols-3">
                      <StatCard label="Account" value={`$${p().account_size.toLocaleString()}`} mono />
                      <StatCard label="Daily loss" value={formatDailyLossLimit(p().daily_loss_limit)} />
                      <StatCard label="Max DD" value={`${(p().max_drawdown * 100).toFixed(0)}%`} mono />
                      <StatCard label="Eval target" value={`${(p().profit_target * 100).toFixed(0)}%`} mono />
                      <StatCard label="Eval min days" value={String(p().min_trading_days ?? "—")} mono />
                      <StatCard label="Drawdown type" value={p().drawdown_type ?? "eod"} mono />
                    </div>

                    <Show when={p().funded_account_label || (p().funded_account_notes?.length ?? 0) > 0}>
                      <div class="rounded-sm border border-stone-800 bg-stone-950/40 px-4 py-3">
                        <p class="text-[11px] uppercase tracking-[0.18em] text-stone-500">Funded stage</p>
                        <p class="mt-2 text-sm font-medium text-stone-100">
                          {p().funded_account_label ?? "Separate funded-account rules"}
                        </p>
                        <For each={p().funded_account_notes ?? []}>
                          {(note) => <p class="mt-1 text-xs leading-5 text-stone-400">{note}</p>}
                        </For>
                      </div>
                    </Show>
                  </div>
                )}
              </Show>
            </div>
          </Show>
        </Show>
      </section>

      <section class={`${sectionBase} border-l-4 border-stone-700/80`}>
        <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div class="space-y-1">
            <p class="text-sm font-medium text-stone-100">5. Launch</p>
            <p class="text-xs text-stone-400">Run and save the result.</p>
          </div>

          <button
            class={
              "w-full rounded-sm px-5 py-3 text-sm font-semibold transition-colors md:w-auto " +
              (loading()
                ? "cursor-not-allowed bg-stone-700 text-stone-400"
                : "bg-stone-100 text-stone-900 hover:bg-white")
            }
            disabled={!canRun()}
            onClick={handleSubmit}
          >
            {step() === "loading-data"
              ? "Loading market data…"
              : step() === "running"
                ? "Running backtest…"
                : "Run Backtest"}
          </button>
        </div>
      </section>
    </div>
  );
}
