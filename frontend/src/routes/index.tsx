import { A } from "@solidjs/router";
import { createSignal } from "solid-js";
import AppShell from "../components/AppShell";
import WorkspaceGrid from "../components/workspace/WorkspaceGrid";
import WorkspaceToolbar from "../components/workspace/WorkspaceToolbar";
import {
  buildWorkspacePanels,
  WORKSPACE_PRESET_OPTIONS,
  type WorkspacePreset,
} from "../components/workspace/chartPanelTypes";

export default function Dashboard() {
  const [preset, setPreset] = createSignal<WorkspacePreset>("grid");
  const [panels, setPanels] = createSignal(buildWorkspacePanels("grid"));

  const handlePresetChange = (nextPreset: WorkspacePreset) => {
    setPreset(nextPreset);
    setPanels(buildWorkspacePanels(nextPreset));
  };

  return (
    <AppShell
      title="Dashboard"
      subtitle="Work across live previews and warehouse-backed candles in a modular chart workspace."
      actions={
        <>
          <A
            href="/replay"
            class="rounded-xl bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-white"
          >
            Open Replay Lab
          </A>
          <A
            href="/replay-sessions"
            class="rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
          >
            Saved Replay Sessions
          </A>
          <A
            href="/backtests/new"
            class="rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
          >
            New Backtest
          </A>
        </>
      }
    >
      <section class="app-panel app-panel-section">
        <WorkspaceToolbar
          preset={preset()}
          options={WORKSPACE_PRESET_OPTIONS}
          onPresetChange={handlePresetChange}
        />
      </section>

      <WorkspaceGrid preset={preset()} panels={panels()} />

      <section class="grid gap-4 lg:grid-cols-3">
        <div class="app-panel app-panel-section">
          <p class="app-kicker">Preset MVP</p>
          <p class="mt-2 text-sm font-semibold text-zinc-100">You can switch layouts instantly</p>
          <p class="mt-1 text-sm text-zinc-400">
            The dashboard now starts with `1`, `2`, or `4` independent charts instead of one
            page-level query doing all the work.
          </p>
        </div>

        <div class="app-panel app-panel-section">
          <p class="app-kicker">Independent Panels</p>
          <p class="mt-2 text-sm font-semibold text-zinc-100">Each chart owns its own state</p>
          <p class="mt-1 text-sm text-zinc-400">
            Every tile can point at its own symbol, timeframe, and source, which is the right
            foundation for resizing, persistence, and saved workspaces later.
          </p>
        </div>

        <div class="app-panel app-panel-section">
          <p class="app-kicker">Next Step</p>
          <p class="mt-2 text-sm font-semibold text-zinc-100">Resize and persist the layout</p>
          <p class="mt-1 text-sm text-zinc-400">
            Once this feels good, the next clean upgrade is a resizable grid and saved workspace
            presets instead of jumping straight into drag-and-drop chaos.
          </p>
        </div>
      </section>
    </AppShell>
  );
}
