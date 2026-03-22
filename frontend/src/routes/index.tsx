import { createSignal, createResource, Show, ErrorBoundary } from "solid-js";
import PriceChart from "../components/PriceChart";
import { fetchCandles } from "../services/api";
import { DATABENTO_SYMBOLS, BACKTEST_INTERVALS, DEFAULT_DATABENTO_SYMBOL, DEFAULT_INTERVAL, type DatabentoSymbol, type Interval}  from "../constants";
 
export default function Dashboard() {
  const [symbol, setSymbol]  = createSignal<DatabentoSymbol>(DEFAULT_DATABENTO_SYMBOL);
  const [interval, setInterval] = createSignal<Interval>(DEFAULT_INTERVAL);

  // Reactive data fetch 
  const resourceKey = () => {
    const rule = interval().resampleRule;
    if(!rule){
      return null;
    }
    return{
      symbol: symbol().key,
      interval: rule,
      limit: 750
    }
  }
  const [candles] = createResource(resourceKey, (args) => fetchCandles(args));

  //Reusable tailwind classes for dropdowns (kept as string to avoid template literal issues)
  const select = "bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm " +
    "focus:outline-none focus:ring-1 focus:ring-zinc-500 cursor-pointer";

  return (
    <div class="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <div class="flex items-center justify-between mb-6">
        <h1 class="text-2xl font-bold tracking-tight">Trading Lab</h1>
        {/* Symbol + timeframe controls */}
        <div class="flex gap-3 flex-wrap justify-end">
          <select class={`${select} min-w-52`}
            value={symbol().key}
            onChange={e => {
              const match = DATABENTO_SYMBOLS.find((s) => s.key === e.currentTarget.value);
              if(match){
                setSymbol(match);
              }
            }}
          >
            {DATABENTO_SYMBOLS.map((s) => (
              <option value={s.key}>{s.label}</option>
            ))}
          </select>

          <select 
            class={select} 
            value={interval().value}
            onChange={(e) => {
              const match = BACKTEST_INTERVALS.find((i) => i.value === e.currentTarget.value);
              if(match){
                setInterval(match);
              }
            }}
          >
            {BACKTEST_INTERVALS.map((i) => (
              <option value={i.value} disabled={i.resampleRule === null}>
              {i.label}{i.resampleRule === null ? " (soon)": ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/*Where the magic happens */}
      <ErrorBoundary fallback={err => (
        <div class="h-96 flex items-center justify-center bg-zinc-900 rounded-lg">
          <p class="text-red-400 text-sm">Failed to load chart: {err.message}</p>
        </div>
      )}>
        <Show
          when={!candles.loading && candles()}
          fallback={<div class="h-96 bg-zinc-900 rounded-lg animate-pulse" />}
        >
          <PriceChart candles={candles()!} />
        </Show>
      </ErrorBoundary>
    </div>
  );
}