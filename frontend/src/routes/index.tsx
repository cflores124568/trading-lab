import { A, useLocation, useNavigate } from "@solidjs/router";
import { batch, createEffect, createMemo, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Gauge, LayoutPanelTop, PanelRight, Radio, SquareChartGantt } from "lucide-solid";
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
  const [showUtilityRail, setShowUtilityRail] = createSignal(true);
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
  const livePanelCount = createMemo(
    () => activePanels().filter((panel) => panel.query.mode === "live").length,
  );
  const historicalPanelCount = createMemo(
    () => activePanels().filter((panel) => panel.query.mode === "historical").length,
  );
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
  const layoutRead = createMemo(() => {
    const panelCount = activePanels().length;
    if (panelCount === 3) {
      return "One anchor chart on the left with two stacked support panels on the right.";
    }

    if (panelCount === 1) {
      return "Single-chart focus mode. No wasted chrome, just one strong read.";
    }

    if (panelCount === 2) {
      return "Balanced split view for side-by-side timeframe or symbol work.";
    }

    return "Dense multi-panel grid that still keeps everything inside one shell.";
  });
  const railIconNote = createMemo(() =>
    activePanels().length >= 3
      ? "Now is the right moment for icons on repeated panel actions, symbol chips, and future trade controls."
      : "Keep icons limited to workspace actions until the panel workflow settles down a bit more.",
  );
  const railFocusNote = createMemo(() => {
    if (activePanels().length === 3) {
      return "Anchor your main read on the left and use the stacked right side for confirmation and failure checks.";
    }

    if (activePanels().length >= 4) {
      return "Once you go wider than three charts, the rail should carry summary stats so the panels can stay visually quiet.";
    }

    return "With one or two charts, keep the shell simple and let the chart body do most of the talking.";
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
          showUtilityRail={showUtilityRail()}
          onWorkspaceChange={handleWorkspaceChange}
          onDefaultWorkspaceChange={handleDefaultWorkspaceChange}
          onWorkspaceNameChange={handleWorkspaceNameChange}
          onCreateWorkspace={handleCreateWorkspace}
          onDeleteWorkspace={handleDeleteWorkspace}
          onPresetChange={handlePresetChange}
          onAddChart={handleAddChart}
          onToggleUtilityRail={() => setShowUtilityRail((current) => !current)}
        />
        <div class="p-3 lg:p-4">
          <div class={`grid gap-3 ${showUtilityRail() ? "xl:grid-cols-[minmax(0,1fr)_280px]" : ""}`}>
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

            {showUtilityRail() ? (
              <aside class="hidden xl:flex min-h-[640px] flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-950/55 p-4">
                <div class="rounded-2xl border border-zinc-800 bg-zinc-950/85 p-4">
                  <div class="flex items-center gap-2 text-zinc-100">
                    <LayoutPanelTop size={16} class="text-sky-300" />
                    <p class="text-sm font-semibold">Layout Read</p>
                  </div>
                  <p class="mt-3 text-sm text-zinc-300">{layoutRead()}</p>
                  <p class="mt-2 text-xs text-zinc-500">
                    {activePanels().length} panels in `{activeWorkspace().selectedPreset}` mode.
                  </p>
                </div>

                <div class="rounded-2xl border border-zinc-800 bg-zinc-950/85 p-4">
                  <div class="flex items-center gap-2 text-zinc-100">
                    <Radio size={16} class="text-emerald-300" />
                    <p class="text-sm font-semibold">Workspace Pulse</p>
                  </div>
                  <div class="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                    <div class="rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-3">
                      <p class="text-xs uppercase tracking-[0.16em] text-zinc-500">Live Panels</p>
                      <p class="mt-2 text-xl font-semibold text-zinc-100">{livePanelCount()}</p>
                    </div>
                    <div class="rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-3">
                      <p class="text-xs uppercase tracking-[0.16em] text-zinc-500">Historical Panels</p>
                      <p class="mt-2 text-xl font-semibold text-zinc-100">{historicalPanelCount()}</p>
                    </div>
                    <div class="rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-3">
                      <p class="text-xs uppercase tracking-[0.16em] text-zinc-500">Symbols In Play</p>
                      <p class="mt-2 text-xl font-semibold text-zinc-100">{symbolMix().length}</p>
                    </div>
                    <div class="rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-3">
                      <p class="text-xs uppercase tracking-[0.16em] text-zinc-500">Intervals In Play</p>
                      <p class="mt-2 text-xl font-semibold text-zinc-100">{intervalMix().length}</p>
                    </div>
                  </div>
                </div>

                <div class="rounded-2xl border border-zinc-800 bg-zinc-950/85 p-4">
                  <div class="flex items-center gap-2 text-zinc-100">
                    <SquareChartGantt size={16} class="text-amber-300" />
                    <p class="text-sm font-semibold">Panel Stack</p>
                  </div>
                  <div class="mt-3 space-y-2">
                    {activePanels().map((panel, index) => (
                      <div class="rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-2">
                        <div class="flex items-center justify-between gap-3">
                          <p class="text-xs uppercase tracking-[0.16em] text-zinc-500">Panel {index + 1}</p>
                          <span class="rounded-full border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] uppercase tracking-[0.16em] text-zinc-500">
                            {panel.query.mode}
                          </span>
                        </div>
                        <p class="mt-1 text-sm font-medium text-zinc-100">{panel.title}</p>
                        <p class="mt-1 text-xs text-zinc-500">
                          {panel.query.symbol} · {panel.query.interval}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                <div class="rounded-2xl border border-zinc-800 bg-zinc-950/85 p-4">
                  <div class="flex items-center gap-2 text-zinc-100">
                    <PanelRight size={16} class="text-fuchsia-300" />
                    <p class="text-sm font-semibold">Mix Read</p>
                  </div>
                  <div class="mt-3">
                    <p class="text-xs uppercase tracking-[0.16em] text-zinc-500">Symbols</p>
                    <div class="mt-2 flex flex-wrap gap-2">
                      {symbolMix().map(([symbol, count]) => (
                        <span class="rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-200">
                          {symbol} x{count}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div class="mt-4">
                    <p class="text-xs uppercase tracking-[0.16em] text-zinc-500">Intervals</p>
                    <div class="mt-2 flex flex-wrap gap-2">
                      {intervalMix().map(([interval, count]) => (
                        <span class="rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-200">
                          {interval} x{count}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div class="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-3">
                    <div class="flex items-center gap-2 text-zinc-100">
                      <Gauge size={15} class="text-fuchsia-300" />
                      <p class="text-xs font-semibold uppercase tracking-[0.16em]">Icon Timing</p>
                    </div>
                    <p class="mt-2 text-sm text-zinc-300">{railIconNote()}</p>
                    <p class="mt-2 text-sm text-zinc-400">{railFocusNote()}</p>
                  </div>
                </div>
              </aside>
            ) : null}
          </div>
        </div>
      </section>
    </AppShell>
  );
}
