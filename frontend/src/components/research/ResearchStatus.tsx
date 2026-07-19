import type { ResearchCampaignStatus } from "../../services/api";

const tones: Record<ResearchCampaignStatus, string> = {
  draft: "border-stone-700 bg-stone-900 text-stone-300",
  queued: "border-sky-800 bg-sky-950/35 text-sky-200",
  running: "border-emerald-800 bg-emerald-950/35 text-emerald-200",
  paused: "border-amber-800 bg-amber-950/35 text-amber-200",
  completed: "border-stone-600 bg-stone-800/70 text-stone-100",
  failed: "border-red-800 bg-red-950/35 text-red-200",
};

export default function ResearchStatus(props: { status: ResearchCampaignStatus }) {
  return (
    <span class={`rounded-sm border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${tones[props.status]}`}>
      {props.status}
    </span>
  );
}
