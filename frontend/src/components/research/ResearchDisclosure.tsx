import { ShieldAlert } from "lucide-solid";

export default function ResearchDisclosure() {
  return (
    <aside class="flex items-start gap-3 rounded-md border border-amber-800/70 bg-amber-950/25 px-4 py-3 text-sm text-amber-100">
      <ShieldAlert class="mt-0.5 shrink-0 text-amber-400" size={18} />
      <div>
        <p class="font-semibold">Research evidence, not a profitability guarantee</p>
        <p class="mt-1 max-w-5xl text-xs leading-5 text-amber-200/70">
          Alpha Lab results are historical research artifacts. Promotion is a manual review record only and does not create a paper session, place an order, or authorize live trading.
        </p>
      </div>
    </aside>
  );
}
