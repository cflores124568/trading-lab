import { createSignal, createResource, Show, ErrorBoundary } from "solid-js";
import PriceChart from "../components/PriceChart";
import { fetchCandles } from "../services/api";
import { YFINANCE_SYMBOLS, LIVE_CHART_INTERVALS, PERIODS, DEFAULT_YFINANCE_SYMBOL, DEFAULT_INTERVAL,  DEFAULT_PERIOD,
  type YFinanceSymbol, type Interval, type Period}  from "../constants";
 
export default function Dashboard() {
  const [symbol, setSymbol]  = createSignal<YFinanceSymbol>(DEFAULT_YFINANCE_SYMBOL);
  const [interval, setInterval] = createSignal<Interval & {yfinanceInterval: string}>(DEFAULT_INTERVAL as Interval & {yfinanceInterval: string});
  const [period, setPeriod]  = createSignal<Period>(DEFAULT_PERIOD);

  //Yfinance's supported chosen interval
  //maxLiveDays should always be non-null on LIVE_CHART_INTERVALS
  const safePeriod = () => {
    const maxDays = interval().maxLiveDays ?? 60;
    return period().days <= maxDays ? period().value: `${maxDays}d`;
  }

  // Reactive data fetch 
  const [candles] = createResource(
    () => ({key: symbol().key, interval: interval().yfinanceInterval, period: safePeriod() }),
    ({ key, interval, period }) => fetchCandles(key, interval, period)
  );

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
              const match = YFINANCE_SYMBOLS.find(s => s.key === e.currentTarget.value);
              if(match){
                setSymbol(match);
              }
            }}
          >
            {YFINANCE_SYMBOLS.map(s => (
              <option value={s.key}>{s.label}</option>
            ))}
          </select>

          <select 
            class={select} 
            value={interval().value}
            onChange={e => {
              const match = LIVE_CHART_INTERVALS.find(i => i.value === e.currentTarget.value);
              if(match){
                setInterval(match);
              }
            }}
          >
            {LIVE_CHART_INTERVALS.map(i => (
              <option value={i.value}>{i.label}</option>
            ))}
          </select>

          <select 
            class={select} 
            value={period().value}
            onChange={e => {
              const match = PERIODS.find(p => p.value === e.currentTarget.value);
              if(match){
                setPeriod(match);
              }
            }}
          >
            {PERIODS.map(p => (
              <option value={p.value}>{p.label}</option>
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