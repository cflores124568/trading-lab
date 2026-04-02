import { useParams } from "@solidjs/router";
import { createResource, Show, For, createSignal } from "solid-js";
import { fetchBacktest, fetchBacktestCandles } from "../../services/api";
import type { Candle } from "../../services/api";
import EquityCurve from "../../components/EquityCurve";
import PriceChart from "../../components/PriceChart";
import ReplayControls from "../../components/ReplayControls";
import { CircleCheck, CircleX, TriangleAlert } from "lucide-solid";

export default function BacktestDetail() {
  const params = useParams<{ id: string }>();
  const [result] = createResource(() => params.id, fetchBacktest);

  // Replay candles now come from the backtest id itself so the backend can
  // rebuild them from persisted replay context after a restart.
  const [candles] = createResource(
    () => result()?.backtest_id,
    (backtestId) => fetchBacktestCandles(backtestId)
  );

  const [isReplayActive, setIsReplayActive] = createSignal(false);
  const [speed, setSpeed] = createSignal(8);
  const [progress, setProgress] = createSignal(0);
  const [currentBar, setCurrentBar] = createSignal(0);

  return (
    <Show
      when={result()}
      fallback={
        <div class="min-h-screen bg-zinc-950 flex items-center justify-center">
          <p class="text-zinc-400">Loading backtest…</p>
        </div>
      }
    >
      {(bt) => {
        const { metrics, prop_firm_eval, trades, equity_curve, backtest_id } = bt();

        const tradesForChart = trades.map((trade) => ({
          time: Math.floor(new Date(trade.entry_time).getTime() / 1000),
          price: trade.entry_price,
          side: trade.side as "buy" | "sell",
          quantity: 1,
        }));

        return (
          <div class="min-h-screen bg-zinc-950 text-zinc-100 p-6 space-y-6">

            <h1 class="text-xl font-bold tracking-tight">
              {bt().symbol} • {bt().strategy.type}
              <span class="block text-zinc-500 text-xs font-mono mt-1">
                {backtest_id}
              </span>
            </h1>

            {/* Metrics strip */}
            <div class="grid grid-cols-3 gap-4">
              {([
                ["Total PnL",     `$${metrics.total_pnl.toFixed(2)}`],
                ["Win Rate",      `${(metrics.win_rate * 100).toFixed(1)}%`],
                ["Max Drawdown",  `${(metrics.max_drawdown * 100).toFixed(1)}%`],
                ["Sharpe",        metrics.sharpe_ratio.toFixed(2)],
                ["Profit Factor", metrics.profit_factor.toFixed(2)],
                ["Total Trades",  String(metrics.total_trades)],
              ] as [string, string][]).map(([label, value]) => (
                <div class="bg-zinc-900 rounded-lg p-4">
                  <p class="text-zinc-400 text-xs mb-1">{label}</p>
                  <p class="text-xl font-semibold font-mono">{value}</p>
                </div>
              ))}
            </div>

            {/* Equity curve */}
            <div class="bg-zinc-900 rounded-lg p-4">
              <p class="text-sm text-zinc-400 mb-3">Equity Curve</p>
              <EquityCurve data={equity_curve} />
            </div>

            {/* Replay — waits for candles to load independently, shows a skeleton in the meantime */}
            <div class="bg-zinc-900 rounded-lg p-4 space-y-4">
              <p class="text-sm text-zinc-400">Price Chart Replay</p>

              <Show
                when={!candles.loading && candles() && candles()!.length > 0}
                fallback={
                  <div class="h-[450px] bg-zinc-800 rounded-lg animate-pulse flex items-center justify-center">
                    <p class="text-zinc-500 text-sm">
                      {candles.loading ? "Loading chart data…" : "No candles available for this dataset."}
                    </p>
                  </div>
                }
              >
                <PriceChart
                  candles={candles() as Candle[]}
                  trades={tradesForChart}
                  isReplayActive={isReplayActive()}
                  playbackSpeed={speed()}
                  onProgress={(p) => {
                    setProgress(p);
                    setCurrentBar(Math.floor(p * candles()!.length));
                  }}
                  onComplete={() => setIsReplayActive(false)}
                  height={450}
                />

                <ReplayControls
                  isPlaying={isReplayActive()}
                  speed={speed()}
                  progress={progress()}
                  currentBar={currentBar()}
                  totalBars={candles()?.length ?? 0}
                  onPlayPause={() => setIsReplayActive(!isReplayActive())}
                  onSpeedChange={setSpeed}
                  onSeek={(p) => {
                    setProgress(p);
                    setCurrentBar(Math.floor(p * candles()!.length));
                  }}
                  onRestart={() => {
                    setProgress(0);
                    setCurrentBar(0);
                    setIsReplayActive(true);
                  }}
                />
              </Show>
            </div>

            {/* Prop firm eval */}
            <div class={`rounded-lg p-4 border ${
              prop_firm_eval.passed
                ? "bg-green-950 border-green-700"
                : "bg-red-950 border-red-700"
            }`}>
              <div class="flex items-center gap-2 mb-2">
                {prop_firm_eval.passed
                  ? <CircleCheck class="text-green-400" />
                  : <CircleX size={18} class="text-red-400" />
                }
                <p class="font-semibold">
                  Prop Eval: {prop_firm_eval.passed ? "Passed" : "Failed"}
                </p>
              </div>
              <Show when={!prop_firm_eval.passed}>
                <ul class="mt-2 text-sm text-red-300 space-y-1">
                  <Show when={prop_firm_eval.daily_loss_breached}>
                    <li class="flex items-center gap-1.5">
                      <TriangleAlert size={13} /> Daily loss limit breached
                    </li>
                  </Show>
                  <Show when={prop_firm_eval.drawdown_breached}>
                    <li class="flex items-center gap-1.5">
                      <TriangleAlert size={13} /> Max drawdown breached
                    </li>
                  </Show>
                  <Show when={!prop_firm_eval.consistency_passed}>
                    <li class="flex items-center gap-1.5">
                      <TriangleAlert size={13} /> Consistency rule failed
                    </li>
                  </Show>
                </ul>
              </Show>
            </div>

            {/* Trades table */}
            <div class="bg-zinc-900 rounded-lg overflow-hidden">
              <p class="text-sm text-zinc-400 p-4 border-b border-zinc-800">
                Trades ({trades.length})
              </p>
              <table class="w-full text-sm">
                <thead class="text-zinc-400 text-xs">
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
                  <For each={trades}>{(trade) => (
                    <tr class="border-t border-zinc-800 hover:bg-zinc-800 transition-colors">
                      <td class="p-3 text-zinc-400">{trade.trade_id}</td>
                      <td class={`p-3 font-medium ${trade.side === "buy" ? "text-green-400" : "text-red-400"}`}>
                        {trade.side}
                      </td>
                      <td class="p-3 text-zinc-400 text-xs font-mono">{trade.entry_time}</td>
                      <td class="p-3 text-zinc-400 text-xs font-mono">{trade.exit_time}</td>
                      <td class="p-3 text-right font-mono">{trade.entry_price.toFixed(2)}</td>
                      <td class="p-3 text-right font-mono">{(trade.exit_price ?? 0).toFixed(2)}</td>
                      <td class={`p-3 text-right font-mono font-semibold ${trade.pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}
                      </td>
                    </tr>
                  )}</For>
                </tbody>
              </table>
            </div>

          </div>
        );
      }}
    </Show>
  );
}
