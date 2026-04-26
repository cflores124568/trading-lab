import { A, useLocation, useNavigate } from "@solidjs/router";
import { batch, createEffect, createMemo, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import AppShell from "../components/AppShell";
import WorkspaceGrid from "../components/workspace/WorkspaceGrid";
import WorkspaceToolbar from "../components/workspace/WorkspaceToolbar";
import {
  buildSavedWorkspace,
  cloneWorkspaceState,
  createWorkspaceCopyName,
  createWorkspacePanel,
  normalizeWorkspaceCollectionState,
  normalizePanelTitle,
  normalizeWorkspaceName,
  MAX_WORKSPACE_PANELS,
  reconcileWorkspaceLayout,
  WORKSPACE_PRESET_OPTIONS,
  type ChartPanelQuery,
  type WorkspaceLayout,
  type WorkspacePreset,
} from "../components/workspace/chartPanelTypes";
import {
  applyWorkspaceLaunch,
  describeWorkspaceLaunchSource,
  loadWorkspaceCollectionState,
  parseWorkspaceLaunchSearch,
  saveWorkspaceCollectionState,
} from "../components/workspace/workspacePersistence";

export default function Dashboard() {
  const navigate = useNavigate();
  const location = useLocation();
  const [workspace, setWorkspace] = createStore(loadWorkspaceCollectionState());
  const [launchNotice, setLaunchNotice] = createSignal<string | null>(null);
  let hydratedLaunchSearch: string | null = null;
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

  const handleDefaultWorkspaceChange = (workspaceId: string) => {
    setWorkspace("defaultWorkspaceId", workspaceId);
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
      if (workspace.defaultWorkspaceId === workspace.workspaces[workspaceIndex].id) {
        setWorkspace("defaultWorkspaceId", fallbackWorkspace.id);
      }
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

  const handlePanelTitleChange = (panelId: string, nextTitle: string) => {
    const workspaceIndex = activeWorkspaceIndex();
    const preset = workspace.workspaces[workspaceIndex].selectedPreset;
    const panelIndex = workspace.workspaces[workspaceIndex].presets[preset].panels.findIndex(
      (panel) => panel.id === panelId,
    );

    if (panelIndex === -1) {
      return;
    }

    const currentTitle =
      workspace.workspaces[workspaceIndex].presets[preset].panels[panelIndex]?.title ?? "Chart";
    setWorkspace(
      "workspaces",
      workspaceIndex,
      "presets",
      preset,
      "panels",
      panelIndex,
      "title",
      normalizePanelTitle(nextTitle, currentTitle),
    );
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
    const nextLaunch = parseWorkspaceLaunchSearch(location.search);
    if (!nextLaunch || hydratedLaunchSearch === location.search) {
      return;
    }

    hydratedLaunchSearch = location.search;
    const nextState = applyWorkspaceLaunch(workspace, nextLaunch);
    const workspaceName =
      nextState.workspaces.find((candidate) => candidate.id === nextState.selectedWorkspaceId)?.name ??
      "workspace";

    batch(() => {
      setWorkspace(reconcile(nextState));
      setLaunchNotice(`Opened ${describeWorkspaceLaunchSource(nextLaunch.source)} in ${workspaceName}.`);
    });

    navigate("/", { replace: true });
  });

  createEffect(() => {
    saveWorkspaceCollectionState(normalizeWorkspaceCollectionState(workspace));
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
      {launchNotice() ? (
        <div class="rounded-lg border border-emerald-700 bg-emerald-950 px-4 py-3 text-sm text-emerald-300">
          {launchNotice()}
        </div>
      ) : null}

      <section class="app-panel overflow-hidden">
        <WorkspaceToolbar
          workspaceId={activeWorkspace().id}
          defaultWorkspaceId={workspace.defaultWorkspaceId}
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
          onDefaultWorkspaceChange={handleDefaultWorkspaceChange}
          onWorkspaceNameChange={handleWorkspaceNameChange}
          onCreateWorkspace={handleCreateWorkspace}
          onDeleteWorkspace={handleDeleteWorkspace}
          onPresetChange={handlePresetChange}
          onAddChart={handleAddChart}
        />
        <div class="p-3 lg:p-4">
          <WorkspaceGrid
            preset={activeWorkspace().selectedPreset}
            panels={activePresetState().panels}
            layout={activePresetState().layout}
            onLayoutChange={handleLayoutChange}
            onPanelTitleChange={handlePanelTitleChange}
            onPanelQueryChange={handlePanelQueryChange}
            onPanelRemove={handleRemovePanel}
          />
        </div>
      </section>

      <section class="grid gap-4 lg:grid-cols-3">
        <div class="app-panel app-panel-section">
          <p class="app-kicker">Saved Workspaces</p>
          <p class="mt-2 text-sm font-semibold text-zinc-100">Keep separate setups without losing presets</p>
          <p class="mt-1 text-sm text-zinc-400">
            Fork the current workspace, give it a real name, and keep one version for replay, one
            for backtest review, and another for live scan work without turning the dashboard into
            generic floating widgets.
          </p>
        </div>

        <div class="app-panel app-panel-section">
          <p class="app-kicker">Dynamic Panels</p>
          <p class="mt-2 text-sm font-semibold text-zinc-100">Every saved workspace still grows and heals itself</p>
          <p class="mt-1 text-sm text-zinc-400">
            Add or remove charts inside any workspace and the row weights plus column ratios
            rebalance automatically, so your layout keeps feeling intentional instead of leaving
            behind dead space.
          </p>
        </div>

        <div class="app-panel app-panel-section">
          <p class="app-kicker">What Matters</p>
          <p class="mt-2 text-sm font-semibold text-zinc-100">The preset model stays in charge</p>
          <p class="mt-1 text-sm text-zinc-400">
            This still starts from `1`, `2`, and `4` chart trading setups, then lets each saved
            workspace bend from there. That keeps the product opinionated instead of sliding
            straight into a widget playground.
          </p>
        </div>
      </section>
    </AppShell>
  );
}
