import { A, useLocation, useNavigate } from "@solidjs/router";
import { batch, createEffect, createMemo, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { SquareChartGantt } from "lucide-solid";
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
  const activePanels = createMemo(() => activePresetState().panels);
  const symbolMix = createMemo(() => {
    const counts = new Map<string, number>();

    for (const panel of activePanels()) {
      counts.set(panel.query.symbol, (counts.get(panel.query.symbol) ?? 0) + 1);
    }

    return Array.from(counts.entries()).sort((left, right) => right[1] - left[1]);
  });
  const intervalMix = createMemo(() => {
    const counts = new Map<string, number>();

    for (const panel of activePanels()) {
      counts.set(panel.query.interval, (counts.get(panel.query.interval) ?? 0) + 1);
    }

    return Array.from(counts.entries()).sort((left, right) => right[1] - left[1]);
  });
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
      currentWorkspace.accountProfile,
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

  const handlePanelDuplicate = (panelId: string) => {
    const workspaceIndex = activeWorkspaceIndex();
    const preset = workspace.workspaces[workspaceIndex].selectedPreset;
    const currentPanels = workspace.workspaces[workspaceIndex].presets[preset].panels;
    const panelIndex = currentPanels.findIndex((panel) => panel.id === panelId);

    if (panelIndex === -1 || currentPanels.length >= MAX_WORKSPACE_PANELS) {
      return;
    }

    const sourcePanel = currentPanels[panelIndex];
    const duplicateSeed = createWorkspacePanel(preset, currentPanels.length);
    const duplicateQuery =
      sourcePanel.query.mode === "live"
        ? {
            ...sourcePanel.query,
            indicators: sourcePanel.query.indicators
              ? { ...sourcePanel.query.indicators }
              : undefined,
          }
        : {
            ...sourcePanel.query,
            indicators: sourcePanel.query.indicators
              ? { ...sourcePanel.query.indicators }
              : undefined,
          };
    const duplicatePanel = {
      id: duplicateSeed.id,
      title: normalizePanelTitle(`${sourcePanel.title} Copy`, sourcePanel.title),
      query: duplicateQuery,
    };
    const nextPanels = [
      ...currentPanels.slice(0, panelIndex + 1),
      duplicatePanel,
      ...currentPanels.slice(panelIndex + 1),
    ];
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

  const handlePanelMove = (panelId: string, targetPanelId: string) => {
    const workspaceIndex = activeWorkspaceIndex();
    const preset = workspace.workspaces[workspaceIndex].selectedPreset;
    const currentPanels = workspace.workspaces[workspaceIndex].presets[preset].panels;
    const sourceIndex = currentPanels.findIndex((panel) => panel.id === panelId);
    const targetIndex = currentPanels.findIndex((panel) => panel.id === targetPanelId);

    if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) {
      return;
    }

    const nextPanels = [...currentPanels];
    const [movedPanel] = nextPanels.splice(sourceIndex, 1);
    nextPanels.splice(targetIndex, 0, movedPanel);
    setWorkspace("workspaces", workspaceIndex, "presets", preset, "panels", nextPanels);
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
      subtitle="Live and historical chart workspaces tuned for fast setup, replay, and screenshot-worthy analysis."
      mainClass="max-w-none"
      actions={
        <>
          <A
            href="/replay"
            class="app-button-primary rounded-xl"
          >
            Open Replay Lab
          </A>
          <A
            href="/replay-sessions"
            class="app-button-secondary rounded-xl"
          >
            Saved Replay Sessions
          </A>
          <A
            href="/backtests/new"
            class="app-button-secondary rounded-xl"
          >
            New Backtest
          </A>
        </>
      }
    >
      <div class="app-surface-muted rounded-2xl px-4 py-3">
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-2 text-stone-100">
            <SquareChartGantt size={16} class="text-stone-200" />
            <p class="text-sm font-semibold">Panel stack</p>
          </div>
          <p class="text-xs text-stone-500">
            {activePanels().length} panels · {activeWorkspace().selectedPreset}
          </p>
        </div>
        <div class="mt-3 flex flex-wrap gap-2">
          {activePanels().map((panel, index) => (
            <div class="rounded-full border border-white/8 bg-white/[0.04] px-3 py-2 text-xs text-stone-300">
              <span class="font-semibold text-stone-100">Panel {index + 1}</span>
              <span class="mx-2 text-stone-600">·</span>
              <span>{panel.title}</span>
              <span class="mx-2 text-stone-600">·</span>
              <span class="uppercase tracking-[0.16em] text-stone-500">
                {panel.query.symbol} {panel.query.interval}
              </span>
            </div>
          ))}
        </div>
        <div class="mt-4 flex flex-wrap gap-2">
          {symbolMix().map(([symbol, count]) => (
            <span class="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-xs font-medium text-stone-200">
              {symbol} x{count}
            </span>
          ))}
          {intervalMix().map(([interval, count]) => (
            <span class="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-xs font-medium text-stone-200">
              {interval} x{count}
            </span>
          ))}
        </div>
      </div>

      {launchNotice() ? (
        <div class="rounded-2xl border border-green-700/70 bg-green-950/70 px-4 py-3 text-sm text-green-200 shadow-[0_12px_30px_rgba(0,0,0,0.2)]">
          {launchNotice()}
        </div>
      ) : null}

      <div class="flex min-h-0 flex-1 flex-col gap-6">
        <section class="flex min-h-0 w-full flex-1 flex-col overflow-hidden border-y border-white/8 bg-black/18 shadow-[0_18px_50px_rgba(0,0,0,0.24)]">
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
            <div class="min-h-0 flex-1">
              <WorkspaceGrid
                preset={activeWorkspace().selectedPreset}
                panels={activePresetState().panels}
                layout={activePresetState().layout}
                onLayoutChange={handleLayoutChange}
                onPanelTitleChange={handlePanelTitleChange}
                onPanelQueryChange={handlePanelQueryChange}
                onPanelRemove={handleRemovePanel}
                onPanelDuplicate={handlePanelDuplicate}
                onPanelMove={handlePanelMove}
              />
            </div>
        </section>
      </div>
    </AppShell>
  );
}
