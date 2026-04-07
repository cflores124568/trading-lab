import { For } from "solid-js";
import ChartPanel from "./ChartPanel";
import type { ChartPanelConfig, WorkspacePreset } from "./chartPanelTypes";

interface Props {
  preset: WorkspacePreset;
  panels: ChartPanelConfig[];
}

function gridClass(preset: WorkspacePreset): string {
  if (preset === "focus") {
    return "grid-cols-1";
  }

  if (preset === "split") {
    return "grid-cols-1 xl:grid-cols-2";
  }

  return "grid-cols-1 md:grid-cols-2";
}

export default function WorkspaceGrid(props: Props) {
  return (
    <div class={`grid gap-4 ${gridClass(props.preset)}`}>
      <For each={props.panels}>{(panel) => <ChartPanel panel={panel} />}</For>
    </div>
  );
}
