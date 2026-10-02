import { A } from "@solidjs/router";
import { For } from "solid-js";

const stages = [
  { href: "/backtests", label: "Backtest", detail: "Inspect one strategy and its trades" },
  { href: "/experiments", label: "Experiment", detail: "Compare a bounded parameter sweep" },
  { href: "/alpha-lab", label: "Validate", detail: "Test robustness and sealed holdouts" },
];

export default function ResearchWorkflow(props: { active: string }) {
  return (
    <nav aria-label="Research workflow" class="research-workflow">
      <For each={stages}>{(stage, index) => (
        <A href={stage.href} aria-current={props.active === stage.href ? "step" : undefined}
          class="research-workflow-step" classList={{ "is-current": props.active === stage.href }}>
          <span class="app-data text-xs text-stone-400">0{index() + 1}</span>
          <span><strong class="block text-sm font-medium">{stage.label}</strong><span class="text-xs text-stone-400">{stage.detail}</span></span>
        </A>
      )}</For>
    </nav>
  );
}
