import { createResource, createSignal, For, Show } from "solid-js";
import { fetchMffuCatalog } from "../services/api";

const dollars = (amount: number | null) => amount === null ? "—" : `$${amount.toLocaleString()}`;

/** Published evaluation reference only; never constructs executable rules. */
export default function MffuCatalog() {
  const [expanded, setExpanded] = createSignal(false);
  const [catalog] = createResource(expanded, (open) => open ? fetchMffuCatalog() : undefined);

  return (
    <details class="rounded-sm border border-stone-800 bg-stone-950/40 px-4 py-3" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary class="cursor-pointer text-sm font-medium text-stone-200">Compare MFFU evaluation accounts</summary>
      <Show when={catalog()} fallback={<p class="mt-3 text-xs text-stone-400">{catalog.error ? "Could not load the MFFU account reference." : "Loading account reference…"}</p>}>
        {(data) => (
          <div class="mt-3 space-y-3">
            <p class="text-xs leading-5 text-stone-400">Published terms reviewed {data().reviewed_on}. Presets are approximate and use observed bar closes; confirm your own account terms.</p>
            <div class="overflow-x-auto">
              <table class="w-full min-w-[780px] text-left text-xs text-stone-300">
                <thead class="text-stone-500"><tr><th class="py-2 pr-4">Plan</th><th class="py-2 pr-4">Target</th><th class="py-2 pr-4">Max loss</th><th class="py-2 pr-4">Daily pause</th><th class="py-2 pr-4">Minis / micros</th><th class="py-2 pr-4">Consistency</th><th class="py-2 pr-4">Days</th><th class="py-2">Simulation</th></tr></thead>
                <tbody><For each={data().plans}>{(plan) => (
                  <tr class="border-t border-stone-800">
                    <td class="py-2 pr-4"><a class="text-stone-200 underline decoration-stone-600 underline-offset-2" href={plan.source_url} target="_blank" rel="noreferrer">{plan.name}</a></td>
                    <td class="py-2 pr-4 tabular-nums">{dollars(plan.profit_target)}</td>
                    <td class="py-2 pr-4 tabular-nums">{dollars(plan.max_loss)} {plan.drawdown === "static" ? "static" : "EOD"}</td>
                    <td class="py-2 pr-4 tabular-nums">{dollars(plan.daily_soft_pause)}</td>
                    <td class="py-2 pr-4 tabular-nums">{plan.max_mini_contracts} / {plan.max_micro_contracts}</td>
                    <td class="py-2 pr-4">{plan.consistency_threshold === null ? "None" : `${plan.consistency_threshold * 100}%`}</td>
                    <td class="py-2 pr-4">{plan.min_trading_days ?? "None"}</td>
                    <td class="py-2">{plan.simulation_status === "reference_only" ? "Reference only" : "Approximate preset"}</td>
                  </tr>
                )}</For></tbody>
              </table>
            </div>
            <p class="text-xs leading-5 text-stone-500">Limits are enforced for supported mini and micro symbols. Session gaps, news and inactivity are not enforced. Rapid's intraday drawdown describes its sim-funded stage; the published evaluation maximum loss is EOD.</p>
          </div>
        )}
      </Show>
    </details>
  );
}
