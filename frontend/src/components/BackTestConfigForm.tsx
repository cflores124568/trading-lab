import { createSignal, createResource, Show, For, batch, createEffect } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { fetchSymbols, fetchPropPresets, loadSymbol, runBacktest, type SymbolInfo, type PropFirmPreset} from "../services/api";
import { BACKTEST_INTERVALS, STRATEGIES, STRATEGY_PARAMS, getBackendInterval, type StrategyValue} from "../constants";

// Shared input styles 
const field =
  "w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm " +
  "focus:outline-none focus:ring-1 focus:ring-zinc-500 disabled:opacity-40";
const label = "block text-xs text-zinc-400 mb-1";
const section = "bg-zinc-900 rounded-lg p-5 space-y-4";

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
    <div class="space-y-5 max-w-2xl">
      {/*  Error banner  */}
      <Show when={error()}>
        <div class="bg-red-950 border border-red-700 rounded-lg px-4 py-3 text-sm text-red-300">
          {error()}
        </div>
      </Show>
      {/* Symbol  & Interval*/}
      <div class={section}>
        <p class="text-sm font-semibold text-zinc-200">Symbol & Interval</p>
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
      </div>

      {/*  Strategy  */}
      <div class={section}>
        <p class="text-sm font-semibold text-zinc-200">Strategy</p>
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
      </div>

      {/* Prop firm preset  */}
      <div class={section}>
        <p class="text-sm font-semibold text-zinc-200">Prop Firm Rules</p>

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
              <div class="grid grid-cols-3 gap-2 mt-1">
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
                  <div class="bg-zinc-800 rounded px-3 py-2">
                    <p class="text-zinc-400 text-xs">{k}</p>
                    <p class="text-zinc-100 text-sm font-mono">{v}</p>
                  </div>
                ))}
              </div>
            )}
          </Show>
        </Show>
      </div>

      {/* Submit  */}
      <button
        class={
          "w-full py-2.5 rounded-lg text-sm font-semibold transition-colors " +
          (loading() ? "bg-zinc-700 text-zinc-400 cursor-not-allowed" : "bg-zinc-100 text-zinc-900 hover:bg-white")
        }
        disabled={!canRun()}
        onClick={handleSubmit}
      >
        {step() === "loading-data"
          ? "Loading market data…": step() === "running"
          ? "Running backtest…": "Run Backtest"}
      </button>
    </div>
  );
}