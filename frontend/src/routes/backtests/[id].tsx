import { useParams } from "@solidjs/router";
import { createResource, Show, For } from "solid-js";
import { fetchBacktest } from "../../services/api";
import EquityCurve from "../../components/EquityCurve";

//Inline svgs from Lucide to avoid dependencies
interface IconProps {
  size?: number;
  class?: string;
}

const CheckCircle = (props: IconProps) => (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" 
        fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" 
        class={`lucide lucide-circle-check-icon lucide-circle-check ${props.class || ""}`}>
      <circle cx="12" cy="12" r="10"/>
      <path d="m9 12 2 2 4-4"/>
    </svg>
)

const XCircle = (props: IconProps) => (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" 
        fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" 
        class={`lucide lucide-circle-x-icon lucide-circle-x ${props.class || ""}`}>
      <circle cx="12" cy="12" r="10"/>
      <path d="m15 9-6 6"/>
      <path d="m9 9 6 6"/>
    </svg>
)

const AlertTriangle = (props: IconProps) => (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" 
        fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" 
        class={`lucide lucide-triangle-alert-icon lucide-triangle-alert ${props.class || ""}`}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>
      <path d="M12 9v4"/>
      <path d="M12 17h.01"/>
    </svg>
)


export default function BacktestDetail() {
  const params = useParams<{ id: string }>();
  const [result] = createResource(() => params.id, fetchBacktest);

  return (
    <Show
      when={result()}
      fallback={
        <div class="min-h-screen bg-zinc-950 flex items-center justify-center">
          <p class="text-zinc-400">Loading backtest…</p>
        </div>
      }
    >
      {bt => (
        <div class="min-h-screen bg-zinc-950 text-zinc-100 p-6 space-y-6">

          <h1 class="text-xl font-bold tracking-tight">
            Backtest — <span class="text-zinc-400 font-mono text-sm">{bt().backtest_id}</span>
          </h1>

          {/* Metrics strip */}
          <div class="grid grid-cols-3 gap-4">
            {([
              ["Total PnL", `$${bt().metrics.total_pnl.toFixed(2)}`],
              ["Win Rate", `${(bt().metrics.win_rate * 100).toFixed(1)}%`],
              ["Max Drawdown", `${(bt().metrics.max_drawdown * 100).toFixed(1)}%`],
              ["Sharpe", bt().metrics.sharpe_ratio.toFixed(2)],
              ["Profit Factor", bt().metrics.profit_factor.toFixed(2)],
              ["Total Trades", String(bt().metrics.total_trades)],
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
            <EquityCurve data={bt().equity_curve} />
          </div>

          {/* Prop firm eval */}
          <div class={`rounded-lg p-4 border ${
            bt().prop_firm_eval.passed ? "bg-green-950 border-green-700": "bg-red-950  border-red-700"
          }`}>
            <div class="flex items-center gap-2 mb-2">
                {bt().prop_firm_eval.passed ? <CheckCircle/>: <XCircle size={18} class="text-red-400"/>}
              <p class="font-semibold">
                Prop Eval: {bt().prop_firm_eval.passed ? "Passed" : "Failed"}
              </p>
            </div>
            <Show when={!bt().prop_firm_eval.passed}>
              <ul class="mt-2 text-sm text-red-300 space-y-1">
                <Show when={bt().prop_firm_eval.daily_loss_breached}>
                  <li class="flex items-center gap-1.5"><AlertTriangle size={13} /> Daily loss limit breached</li>
                </Show>
                <Show when={bt().prop_firm_eval.drawdown_breached}>
                  <li class="flex items-center gap-1.5"><AlertTriangle size={13} /> Max drawdown breached</li>
                </Show>
                <Show when={!bt().prop_firm_eval.consistency_passed}>
                  <li class="flex items-center gap-1.5"><AlertTriangle size={13} /> Consistency rule failed</li>
                </Show>
              </ul>
            </Show>
          </div>

          {/* Trades table */}
          <div class="bg-zinc-900 rounded-lg overflow-hidden">
            <p class="text-sm text-zinc-400 p-4 border-b border-zinc-800">
              Trades ({bt().trades.length})
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
                <For each={bt().trades}>{trade => (
                  <tr class="border-t border-zinc-800 hover:bg-zinc-800 transition-colors">
                    <td class="p-3 text-zinc-400">{trade.trade_id}</td>
                    <td class={`p-3 font-medium ${trade.side === "buy" ? "text-green-400" : "text-red-400"}`}>
                      {trade.side}
                    </td>
                    <td class="p-3 text-zinc-400 text-xs font-mono">{trade.entry_time}</td>
                    <td class="p-3 text-zinc-400 text-xs font-mono">{trade.exit_time}</td>
                    <td class="p-3 text-right font-mono">{trade.entry_price.toFixed(2)}</td>
                    <td class="p-3 text-right font-mono">{trade.exit_price.toFixed(2)}</td>
                    <td class={`p-3 text-right font-mono font-semibold ${trade.pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}
                    </td>
                  </tr>
                )}</For>
              </tbody>
            </table>
          </div>

        </div>
      )}
    </Show>
  );
}