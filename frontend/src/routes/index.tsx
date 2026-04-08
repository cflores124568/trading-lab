import { A } from "@solidjs/router";
import { batch, createEffect, createMemo } from "solid-js";
import { createStore } from "solid-js/store";
import AppShell from "../components/AppShell";
import WorkspaceGrid from "../components/workspace/WorkspaceGrid";
import WorkspaceToolbar from "../components/workspace/WorkspaceToolbar";
import {
  buildDefaultWorkspaceState,
  createWorkspacePanel,
  MAX_WORKSPACE_PANELS,
  normalizeWorkspaceState,
  reconcileWorkspaceLayout,
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
  const canAddChart = createMemo(() => activePresetState().panels.length < MAX_WORKSPACE_PANELS);

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
    setWorkspace(
      "presets",
      preset,
      "layout",
      reconcileWorkspaceLayout(preset, nextLayout, workspace.presets[preset].panels.length),
    );
  };

  const handleAddChart = () => {
    const preset = workspace.selectedPreset;
    const currentPanels = workspace.presets[preset].panels;

    if (currentPanels.length >= MAX_WORKSPACE_PANELS) {
      return;
    }

    const nextPanels = [...currentPanels, createWorkspacePanel(preset, currentPanels.length)];
    const nextLayout = reconcileWorkspaceLayout(preset, workspace.presets[preset].layout, nextPanels.length);

    batch(() => {
      setWorkspace("presets", preset, "panels", nextPanels);
      setWorkspace("presets", preset, "layout", nextLayout);
    });
  };

  const handleRemovePanel = (panelId: string) => {
    const preset = workspace.selectedPreset;
    const currentPanels = workspace.presets[preset].panels;

    if (currentPanels.length <= 1) {
      return;
    }

    const nextPanels = currentPanels.filter((panel) => panel.id !== panelId);
    const nextLayout = reconcileWorkspaceLayout(preset, workspace.presets[preset].layout, nextPanels.length);

    batch(() => {
      setWorkspace("presets", preset, "panels", nextPanels);
      setWorkspace("presets", preset, "layout", nextLayout);
    });
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
          panelCount={activePresetState().panels.length}
          canAddChart={canAddChart()}
          onPresetChange={handlePresetChange}
          onAddChart={handleAddChart}
        />
      </section>

      <WorkspaceGrid
        preset={workspace.selectedPreset}
        panels={activePresetState().panels}
        layout={activePresetState().layout}
        onLayoutChange={handleLayoutChange}
        onPanelQueryChange={handlePanelQueryChange}
        onPanelRemove={handleRemovePanel}
      />

      <section class="grid gap-4 lg:grid-cols-3">
        <div class="app-panel app-panel-section">
          <p class="app-kicker">Dynamic Workspace</p>
          <p class="mt-2 text-sm font-semibold text-zinc-100">Add charts without leaving the preset flow</p>
          <p class="mt-1 text-sm text-zinc-400">
            Presets still give you a believable starting shape, but now you can grow the active
            workspace up to six panels instead of pretending every real desk stops at `1`, `2`,
            or `4`.
          </p>
        </div>

        <div class="app-panel app-panel-section">
          <p class="app-kicker">Auto Reflow</p>
          <p class="mt-2 text-sm font-semibold text-zinc-100">Remove a chart and the layout heals itself</p>
          <p class="mt-1 text-sm text-zinc-400">
            Rows and resize state rebalance automatically when panel count changes, so the
            workspace still feels intentional instead of collapsing into dead empty slots.
          </p>
        </div>

        <div class="app-panel app-panel-section">
          <p class="app-kicker">Next Step</p>
          <p class="mt-2 text-sm font-semibold text-zinc-100">Named workspaces are the next strong move</p>
          <p class="mt-1 text-sm text-zinc-400">
            Once this interaction feels solid, saving multiple named desk setups is a much better
            trading-product signal than jumping straight into draggable boxes for their own sake.
          </p>
        </div>
      </section>
    </AppShell>
  );
}
