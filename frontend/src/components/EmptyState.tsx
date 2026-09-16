import type { JSX } from "solid-js";

type EmptyStateProps = {
  icon: JSX.Element;
  title: string;
  description: JSX.Element;
  actions?: JSX.Element;
  tone?: "neutral" | "error";
  class?: string;
};

// Same shape as the saved-backtests empty state, so every list page explains
// what belongs there and how to get the first item in.
export default function EmptyState(props: EmptyStateProps) {
  const iconClass = () =>
    props.tone === "error"
      ? "border-red-900/70 bg-red-950/40 text-red-300"
      : "border-stone-800 bg-stone-950 text-stone-200";

  return (
    <div class={props.class ?? "app-panel overflow-hidden"}>
      <div
        class={`app-panel-section grid gap-6 ${
          props.actions ? "lg:grid-cols-[minmax(0,1fr)_260px] lg:items-center" : ""
        }`}
      >
        <div>
          <div class={`inline-flex h-10 w-10 items-center justify-center rounded-xl border ${iconClass()}`}>
            {props.icon}
          </div>
          <p class="mt-5 text-lg font-semibold text-stone-100">{props.title}</p>
          <div class="mt-2 max-w-2xl text-sm leading-6 text-stone-400">{props.description}</div>
        </div>

        {props.actions && <div class="flex flex-col gap-2">{props.actions}</div>}
      </div>
    </div>
  );
}
