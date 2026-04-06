import { createSignal, createResource, Show, For, batch, createEffect, createMemo } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { fetchSymbols, fetchPropPresets, loadSymbol, runBacktest, type SymbolInfo, type PropFirmPreset} from "../services/api";
import { BACKTEST_INTERVALS, STRATEGIES, STRATEGY_PARAMS, getBackendInterval, type StrategyValue} from "../constants";

// Shared input styles 
const field =
  "w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm " +
  "focus:outline-none focus:ring-1 focus:ring-zinc-500 disabled:opacity-40";
const label = "block text-xs text-zinc-400 mb-1";
const section = "app-panel app-panel-section space-y-4";

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

export default function BackTestConfigForm() {
  const navigate = useNavigate();
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
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [step, setStep] = createSignal<"idle" | "loading-data" | "running">("idle");
  const selectedStrategy = createMemo(
    () => STRATEGIES.find((item) => item.value === strategy()) ?? STRATEGIES[0]
  );
  const runSummary = createMemo(() => [
    ["Symbol", symbol()?.symbol ?? "Pick a market"],
    ["Interval", interval().label],
    ["Strategy", selectedStrategy().label],
    ["Preset", preset()?.name ?? "Choose a challenge"],
  ] as [string, string][]);

  // Auto select first symbol upon load
  createEffect(() => {
    const loadedSymbols = symbols();
    if(loadedSymbols && loadedSymbols.length > 0 && !symbol()){
      setSymbol(loadedSymbols[0]); // Change to loadedSymbols.find(s => s.symbol === "NQ") for other defaults
    }
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

  async function handleSubmit() {
    const sym = symbol();
    const pre = preset();
    if(!sym){
        setError("Select a symbol.");
        return;
    }
    if(!pre){ 
        setError("Select a prop firm preset."); 
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
    <div class="space-y-6">
      {/*  Error banner  */}
      <Show when={error()}>
        <div class="bg-red-950 border border-red-700 rounded-lg px-4 py-3 text-sm text-red-300">
          {error()}
        </div>
      </Show>

      <section class={section}>
        <div class="space-y-2">
          <p class="app-kicker">Run Plan</p>
          <h2 class="text-lg font-semibold text-zinc-100">Build the next saved run</h2>
          <p class="max-w-3xl text-sm text-zinc-400">
            Pick a market, choose the strategy parameters, then apply the prop-firm rules you
            want to test against. The backtest opens straight into the saved replay view once it
            finishes.
          </p>
        </div>

        <div class="grid gap-3 md:grid-cols-4">
          <For each={runSummary()}>
            {([key, value]) => (
              <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">{key}</p>
                <p class="mt-2 text-sm font-medium text-zinc-100">{value}</p>
              </div>
            )}
          </For>
        </div>
      </section>

      {/* Symbol  & Interval*/}
      <section class={section}>
        <div class="space-y-1">
          <p class="text-sm font-semibold text-zinc-100">1. Market</p>
          <p class="text-xs text-zinc-400">
            Choose the contract, candle interval, and optional historical window to load for the run.
          </p>
        </div>
        <Show
          when={!symbols.loading && symbols() && symbols()!.length > 0}
          fallback={
            <Show
              when={!symbols.loading}
              fallback={<div class="h-9 bg-zinc-800 rounded animate-pulse" />}
            >
              {/* DB not configured shows warning banner instead of picker */}
              <div class="bg-yellow-950 border border-yellow-700 rounded-lg px-4 py-3 text-sm text-yellow-300">
                No symbols found. Make sure your database is configured and
                data has been imported via{" "}
                <code class="font-mono text-yellow-200">fetch_databento.py</code>.
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
                const found = symbols()!.find(
                  (s) => s.symbol === e.currentTarget.value
                );
                setSymbol(found ?? null);
              }}
            >
              <option value="" disabled>Select a symbol… </option>
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
              const found = BACKTEST_INTERVALS.find(
                (i) => i.value === e.currentTarget.value
              );
              if (found) setInterval(found);
            }}
          >
            <For each={BACKTEST_INTERVALS}>
              {(i) => <option value={i.value}>{i.label}</option>}
            </For>
          </select>
        </div>

        {/* Date range  */}
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class={label}>Start date (optional)</label>
            <input
              type="date"
              class={field}
              value={startDate()}
              onInput={(e) => setStartDate(e.currentTarget.value)}
            />
          </div>
          <div>
            <label class={label}>End date (optional)</label>
            <input
              type="date"
              class={field}
              value={endDate()}
              onInput={(e) => setEndDate(e.currentTarget.value)}
            />
          </div>
        </div>
      </section>

      {/*  Strategy  */}
      <section class={section}>
        <div class="space-y-1">
          <p class="text-sm font-semibold text-zinc-100">2. Strategy</p>
          <p class="text-xs text-zinc-400">
            Pick the signal model and tune the parameters used during bar-by-bar execution.
          </p>
        </div>
        <div>
          <label class={label}>Type</label>
          <select
            class={field}
            value={strategy()}
            onChange={(e) =>
              handleStrategyChange(e.currentTarget.value as StrategyValue)
            }
          >
            <For each={STRATEGIES}>
              {(s) => <option value={s.value}>{s.label}</option>}
            </For>
          </select>
        </div>

        <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
          <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Selected Strategy</p>
          <p class="mt-2 text-sm font-semibold text-zinc-100">{selectedStrategy().label}</p>
          <p class="mt-1 text-sm text-zinc-400">{strategyDescriptions[strategy()]}</p>
        </div>

        {/* Dynamic param inputs */}
        <div class="grid grid-cols-2 gap-3">
          <For each={STRATEGY_PARAMS[strategy()]}>
            {(p) => (
              <div>
                <label class={label}>{p.label}</label>
                <input
                  type="number"
                  class={field}
                  value={params()[p.key] ?? p.default}
                  onInput={(e) => handleParamChange(p.key, e.currentTarget.value)}
                />
              </div>
            )}
          </For>
        </div>
      </section>

      {/* Prop firm preset  */}
      <section class={section}>
        <div class="space-y-1">
          <p class="text-sm font-semibold text-zinc-100">3. Prop Firm Rules</p>
          <p class="text-xs text-zinc-400">
            Select the evaluation ruleset you want this strategy run to survive.
          </p>
        </div>

        <Show
          when={presets() && presets()!.length > 0}
          fallback={<div class="h-9 bg-zinc-800 rounded animate-pulse" />}
        >
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
              <option value="" disabled>Select a preset…</option>
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

          {/* Summary of selected preset */}
          <Show when={preset()}>
            {(p) => (
              <div class="space-y-3">
                <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                  <p class="text-xs uppercase tracking-[0.18em] text-zinc-500">Selected Challenge</p>
                  <p class="mt-2 text-sm font-semibold text-zinc-100">{p().name}</p>
                  <p class="mt-1 text-sm text-zinc-400">
                    Evaluate this run against the same guardrails you would see in a funded challenge.
                  </p>
                </div>

                <div class="grid grid-cols-2 gap-2 md:grid-cols-3">
                {(
                  [
                    ["Account", `$${p().account_size.toLocaleString()}`],
                    ["Daily loss", `${(p().daily_loss_limit * 100).toFixed(0)}%`],
                    ["Max DD", `${(p().max_drawdown * 100).toFixed(0)}%`],
                    ["Target", `${(p().profit_target * 100).toFixed(0)}%`],
                    ["Min days", p().min_trading_days ?? "—"],
                    ["Drawdown type", p().drawdown_type ?? "eod"],
                  ] as [string, string | number][]
                ).map(([k, v]) => (
                  <div class="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                    <p class="text-zinc-400 text-xs">{k}</p>
                    <p class="text-zinc-100 text-sm font-mono">{v}</p>
                  </div>
                ))}
                </div>
              </div>
            )}
          </Show>
        </Show>
      </section>

      {/* Submit  */}
      <section class={section}>
        <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div class="space-y-1">
            <p class="text-sm font-semibold text-zinc-100">4. Launch</p>
            <p class="text-xs text-zinc-400">
              Run the backtest and open the saved result in the replay-first detail view.
            </p>
          </div>

          <button
            class={
              "w-full rounded-xl px-5 py-3 text-sm font-semibold transition-colors md:w-auto " +
              (loading()
                ? "cursor-not-allowed bg-zinc-700 text-zinc-400"
                : "bg-zinc-100 text-zinc-900 hover:bg-white")
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
