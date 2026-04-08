import { A } from "@solidjs/router";
import { createEffect, createMemo } from "solid-js";
import { createStore } from "solid-js/store";
import AppShell from "../components/AppShell";
import WorkspaceGrid from "../components/workspace/WorkspaceGrid";
import WorkspaceToolbar from "../components/workspace/WorkspaceToolbar";
import {
  buildDefaultWorkspaceState,
  normalizeWorkspaceState,
  WORKSPACE_PRESET_OPTIONS,
  type ChartPanelQuery,
  type WorkspaceLayout,
  type WorkspacePreset,
} from "../components/workspace/chartPanelTypes";

const WORKSPACE_STORAGE_KEY = "trading-lab.dashboard.workspace.v1";

function loadWorkspaceState() {
  if (typeof window === "undefined") {
    return buildDefaultWorkspaceState();
  }

  const saved = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
  if (!saved) {
    return buildDefaultWorkspaceState();
  }

  try {
    return normalizeWorkspaceState(JSON.parse(saved));
  } catch {
    return buildDefaultWorkspaceState();
  }
}

export default function Dashboard() {
  const [workspace, setWorkspace] = createStore(loadWorkspaceState());
  const activePresetState = createMemo(() => workspace.presets[workspace.selectedPreset]);

  const handlePresetChange = (nextPreset: WorkspacePreset) => {
    setWorkspace("selectedPreset", nextPreset);
  };

  const handlePanelQueryChange = (panelId: string, nextQuery: ChartPanelQuery) => {
    const preset = workspace.selectedPreset;
    const panelIndex = workspace.presets[preset].panels.findIndex((panel) => panel.id === panelId);

    if (panelIndex === -1) {
      return;
    }

    setWorkspace("presets", preset, "panels", panelIndex, "query", nextQuery);
  };

  const handleLayoutChange = (nextLayout: WorkspaceLayout) => {
    const preset = workspace.selectedPreset;
    setWorkspace("presets", preset, "layout", nextLayout);
  };

  createEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
  });

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
          preset={workspace.selectedPreset}
          options={WORKSPACE_PRESET_OPTIONS}
          onPresetChange={handlePresetChange}
        />
      </section>

      <WorkspaceGrid
        preset={workspace.selectedPreset}
        panels={activePresetState().panels}
        layout={activePresetState().layout}
        onLayoutChange={handleLayoutChange}
        onPanelQueryChange={handlePanelQueryChange}
      />

      <section class="grid gap-4 lg:grid-cols-3">
        <div class="app-panel app-panel-section">
          <p class="app-kicker">Resizable Presets</p>
          <p class="mt-2 text-sm font-semibold text-zinc-100">Wide-screen layouts can breathe now</p>
          <p class="mt-1 text-sm text-zinc-400">
            `1`, `2`, and `4` chart workspaces still stay deterministic, but now you can drag the
            dividers on desktop instead of being stuck with one rigid preset ratio.
          </p>
        </div>

        <div class="app-panel app-panel-section">
          <p class="app-kicker">Workspace Memory</p>
          <p class="mt-2 text-sm font-semibold text-zinc-100">Reloads keep your setup intact</p>
          <p class="mt-1 text-sm text-zinc-400">
            Preset choice, resize ratios, and each panel&apos;s query now stick in local storage so
            the dashboard feels more like a real workspace and less like a disposable demo.
          </p>
        </div>

        <div class="app-panel app-panel-section">
          <p class="app-kicker">Next Step</p>
          <p class="mt-2 text-sm font-semibold text-zinc-100">Add and remove charts carefully</p>
          <p class="mt-1 text-sm text-zinc-400">
            The clean follow-up from here is user-controlled panel count within this workspace
            model, then we can decide later if full drag-and-drop is actually worth the pain.
          </p>
        </div>
      </section>
    </AppShell>
  );
}
