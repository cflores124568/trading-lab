import { A } from "@solidjs/router";
import { batch, createEffect, createMemo } from "solid-js";
import { createStore } from "solid-js/store";
import AppShell from "../components/AppShell";
import WorkspaceGrid from "../components/workspace/WorkspaceGrid";
import WorkspaceToolbar from "../components/workspace/WorkspaceToolbar";
import {
  buildSavedWorkspace,
  cloneWorkspaceState,
  createWorkspaceCopyName,
  createWorkspacePanel,
  normalizeWorkspaceCollectionState,
  normalizeWorkspaceName,
  MAX_WORKSPACE_PANELS,
  reconcileWorkspaceLayout,
  WORKSPACE_PRESET_OPTIONS,
  type ChartPanelQuery,
  type WorkspaceLayout,
  type WorkspacePreset,
} from "../components/workspace/chartPanelTypes";

const WORKSPACE_STORAGE_KEY = "trading-lab.dashboard.workspace.v1";

function loadWorkspaceState() {
  if (typeof window === "undefined") {
    return normalizeWorkspaceCollectionState(null);
  }

  const saved = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
  if (!saved) {
    return normalizeWorkspaceCollectionState(null);
  }

  try {
    return normalizeWorkspaceCollectionState(JSON.parse(saved));
  } catch {
    return normalizeWorkspaceCollectionState(null);
  }
}

export default function Dashboard() {
  const [workspace, setWorkspace] = createStore(loadWorkspaceState());
  const activeWorkspaceIndex = createMemo(() => {
    const index = workspace.workspaces.findIndex(
      (candidate) => candidate.id === workspace.selectedWorkspaceId,
    );

    return index === -1 ? 0 : index;
  });
  const activeWorkspace = createMemo(() => workspace.workspaces[activeWorkspaceIndex()]);
  const activePresetState = createMemo(() => {
    const currentWorkspace = activeWorkspace();
    return currentWorkspace.presets[currentWorkspace.selectedPreset];
  });
  const canAddChart = createMemo(() => activePresetState().panels.length < MAX_WORKSPACE_PANELS);
  const canDeleteWorkspace = createMemo(() => workspace.workspaces.length > 1);

  const handleWorkspaceChange = (workspaceId: string) => {
    setWorkspace("selectedWorkspaceId", workspaceId);
  };

  const handleWorkspaceNameChange = (nextName: string) => {
    const workspaceIndex = activeWorkspaceIndex();
    const currentName = workspace.workspaces[workspaceIndex]?.name;
    setWorkspace(
      "workspaces",
      workspaceIndex,
      "name",
      normalizeWorkspaceName(nextName, currentName),
    );
  };

  const handleCreateWorkspace = () => {
    const currentWorkspace = activeWorkspace();
    const nextWorkspace = buildSavedWorkspace(
      createWorkspaceCopyName(
        currentWorkspace.name,
        workspace.workspaces.map((candidate) => candidate.name),
      ),
      cloneWorkspaceState(currentWorkspace),
    );

    batch(() => {
      setWorkspace("workspaces", (current) => [...current, nextWorkspace]);
      setWorkspace("selectedWorkspaceId", nextWorkspace.id);
    });
  };

  const handleDeleteWorkspace = () => {
    if (workspace.workspaces.length <= 1) {
      return;
    }

    const workspaceIndex = activeWorkspaceIndex();
    const nextWorkspaces = workspace.workspaces.filter((_, index) => index !== workspaceIndex);
    const fallbackWorkspace =
      nextWorkspaces[workspaceIndex] ??
      nextWorkspaces[workspaceIndex - 1] ??
      nextWorkspaces[0];

    batch(() => {
      setWorkspace("workspaces", nextWorkspaces);
      setWorkspace("selectedWorkspaceId", fallbackWorkspace.id);
    });
  };

  const handlePresetChange = (nextPreset: WorkspacePreset) => {
    setWorkspace("workspaces", activeWorkspaceIndex(), "selectedPreset", nextPreset);
  };

  const handlePanelQueryChange = (panelId: string, nextQuery: ChartPanelQuery) => {
    const workspaceIndex = activeWorkspaceIndex();
    const preset = workspace.workspaces[workspaceIndex].selectedPreset;
    const panelIndex = workspace.workspaces[workspaceIndex].presets[preset].panels.findIndex(
      (panel) => panel.id === panelId,
    );

    if (panelIndex === -1) {
      return;
    }

    setWorkspace("workspaces", workspaceIndex, "presets", preset, "panels", panelIndex, "query", nextQuery);
  };

  const handleLayoutChange = (nextLayout: WorkspaceLayout) => {
    const workspaceIndex = activeWorkspaceIndex();
    const preset = workspace.workspaces[workspaceIndex].selectedPreset;
    setWorkspace(
      "workspaces",
      workspaceIndex,
      "presets",
      preset,
      "layout",
      reconcileWorkspaceLayout(
        preset,
        nextLayout,
        workspace.workspaces[workspaceIndex].presets[preset].panels.length,
      ),
    );
  };

  const handleAddChart = () => {
    const workspaceIndex = activeWorkspaceIndex();
    const preset = workspace.workspaces[workspaceIndex].selectedPreset;
    const currentPanels = workspace.workspaces[workspaceIndex].presets[preset].panels;

    if (currentPanels.length >= MAX_WORKSPACE_PANELS) {
      return;
    }

    const nextPanels = [...currentPanels, createWorkspacePanel(preset, currentPanels.length)];
    const nextLayout = reconcileWorkspaceLayout(
      preset,
      workspace.workspaces[workspaceIndex].presets[preset].layout,
      nextPanels.length,
    );

    batch(() => {
      setWorkspace("workspaces", workspaceIndex, "presets", preset, "panels", nextPanels);
      setWorkspace("workspaces", workspaceIndex, "presets", preset, "layout", nextLayout);
    });
  };

  const handleRemovePanel = (panelId: string) => {
    const workspaceIndex = activeWorkspaceIndex();
    const preset = workspace.workspaces[workspaceIndex].selectedPreset;
    const currentPanels = workspace.workspaces[workspaceIndex].presets[preset].panels;

    if (currentPanels.length <= 1) {
      return;
    }

    const nextPanels = currentPanels.filter((panel) => panel.id !== panelId);
    const nextLayout = reconcileWorkspaceLayout(
      preset,
      workspace.workspaces[workspaceIndex].presets[preset].layout,
      nextPanels.length,
    );

    batch(() => {
      setWorkspace("workspaces", workspaceIndex, "presets", preset, "panels", nextPanels);
      setWorkspace("workspaces", workspaceIndex, "presets", preset, "layout", nextLayout);
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
          workspaceId={activeWorkspace().id}
          workspaceName={activeWorkspace().name}
          workspaceCount={workspace.workspaces.length}
          workspaces={workspace.workspaces.map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
          }))}
          preset={activeWorkspace().selectedPreset}
          options={WORKSPACE_PRESET_OPTIONS}
          panelCount={activePresetState().panels.length}
          canAddChart={canAddChart()}
          canDeleteWorkspace={canDeleteWorkspace()}
          onWorkspaceChange={handleWorkspaceChange}
          onWorkspaceNameChange={handleWorkspaceNameChange}
          onCreateWorkspace={handleCreateWorkspace}
          onDeleteWorkspace={handleDeleteWorkspace}
          onPresetChange={handlePresetChange}
          onAddChart={handleAddChart}
        />
      </section>

      <WorkspaceGrid
        preset={activeWorkspace().selectedPreset}
        panels={activePresetState().panels}
        layout={activePresetState().layout}
        onLayoutChange={handleLayoutChange}
        onPanelQueryChange={handlePanelQueryChange}
        onPanelRemove={handleRemovePanel}
      />

      <section class="grid gap-4 lg:grid-cols-3">
        <div class="app-panel app-panel-section">
          <p class="app-kicker">Saved Desks</p>
          <p class="mt-2 text-sm font-semibold text-zinc-100">Keep separate setups without losing presets</p>
          <p class="mt-1 text-sm text-zinc-400">
            Fork the current desk, give it a real name, and keep one version for replay, one for
            backtest review, and another for live scan work without turning the dashboard into
            generic floating widgets.
          </p>
        </div>

        <div class="app-panel app-panel-section">
          <p class="app-kicker">Dynamic Panels</p>
          <p class="mt-2 text-sm font-semibold text-zinc-100">Every saved desk still grows and heals itself</p>
          <p class="mt-1 text-sm text-zinc-400">
            Add or remove charts inside any desk and the row weights plus column ratios rebalance
            automatically, so your layout keeps feeling intentional instead of leaving behind dead
            space.
          </p>
        </div>

        <div class="app-panel app-panel-section">
          <p class="app-kicker">What Matters</p>
          <p class="mt-2 text-sm font-semibold text-zinc-100">The preset model stays in charge</p>
          <p class="mt-1 text-sm text-zinc-400">
            This still starts from `1`, `2`, and `4` chart trading setups, then lets each saved
            desk bend from there. That keeps the product opinionated instead of sliding straight
            into a widget playground.
          </p>
        </div>
      </section>
    </AppShell>
  );
}
