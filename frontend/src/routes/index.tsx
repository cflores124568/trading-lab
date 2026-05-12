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
  normalizeWorkspaceAccountProfile,
  normalizePanelTitle,
  normalizeWorkspaceName,
  MAX_WORKSPACE_PANELS,
  reconcileWorkspaceLayout,
  WORKSPACE_PRESET_OPTIONS,
  type ChartPanelQuery,
  type WorkspaceAccountProfile,
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
  const primarySymbol = createMemo(() => symbolMix()[0]?.[0] ?? "n/a");
  const primaryInterval = createMemo(() => intervalMix()[0]?.[0] ?? "n/a");
  const workspaceMode = createMemo(() => {
    const live = activePanels().filter((panel) => panel.query.mode === "live").length;
    const historical = activePanels().filter((panel) => panel.query.mode === "historical").length;

    if (live > historical) {
      return "live leaning";
    }

    if (historical > live) {
      return "historical leaning";
    }

    return "balanced";
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

  const handleWorkspaceAccountProfileChange = (nextProfile: WorkspaceAccountProfile) => {
    const workspaceIndex = activeWorkspaceIndex();
    const currentProfile = workspace.workspaces[workspaceIndex]?.accountProfile;
    setWorkspace(
      "workspaces",
      workspaceIndex,
      "accountProfile",
      normalizeWorkspaceAccountProfile(nextProfile, currentProfile),
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
      <div class="rounded-[1.5rem] border border-zinc-800/80 bg-[radial-gradient(circle_at_top_left,rgba(183,235,229,0.08),transparent_36%),linear-gradient(180deg,rgba(9,9,11,0.98),rgba(9,9,11,0.9))] p-5 shadow-[0_18px_50px_rgba(0,0,0,0.28)] lg:p-6">
        <div class="flex flex-col gap-4">
          <div class="max-w-3xl space-y-2">
            <p class="app-kicker text-[#b7ebe5]">Workspace snapshot</p>
            <p class="max-w-2xl text-sm leading-6 text-zinc-400">
              Setup lives in the toolbar. This keeps the active mix visible without
              piling on another wall of cards.
            </p>
          </div>

          <div class="grid gap-3 sm:grid-cols-3">
            <div class="rounded-2xl bg-zinc-950/55 px-4 py-3">
              <p class="app-metric-label">Panel Count</p>
              <p class="app-data mt-2 text-2xl font-semibold leading-none text-zinc-100">
                {activePanels().length}
              </p>
            </div>
            <div class="rounded-2xl bg-zinc-950/55 px-4 py-3">
              <p class="app-metric-label">Primary Mix</p>
              <p class="app-data mt-2 text-base font-semibold text-zinc-100">
                {primarySymbol()} <span class="text-zinc-500">/</span> {primaryInterval()}
              </p>
            </div>
            <div class="rounded-2xl bg-zinc-950/55 px-4 py-3">
              <p class="app-metric-label">Workspace Mode</p>
              <p class="mt-2 text-base font-semibold capitalize text-sky-200">{workspaceMode()}</p>
            </div>
          </div>

          <div class="rounded-2xl border border-zinc-800/80 bg-zinc-950/70 px-4 py-3">
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-2 text-zinc-100">
                <SquareChartGantt size={16} class="text-[#b7ebe5]" />
                <p class="text-sm font-semibold">Panel stack</p>
              </div>
              <p class="text-xs text-zinc-500">
                {activePanels().length} panels · {activeWorkspace().selectedPreset}
              </p>
            </div>
            <div class="mt-3 flex flex-wrap gap-2">
              {activePanels().map((panel, index) => (
                <div class="rounded-full border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-xs text-zinc-300">
                  <span class="font-semibold text-zinc-100">Panel {index + 1}</span>
                  <span class="mx-2 text-zinc-600">·</span>
                  <span>{panel.title}</span>
                  <span class="mx-2 text-zinc-600">·</span>
                  <span class="uppercase tracking-[0.16em] text-zinc-500">
                    {panel.query.symbol} {panel.query.interval}
                  </span>
                </div>
              ))}
            </div>
            <div class="mt-4 flex flex-wrap gap-2">
              {symbolMix().map(([symbol, count]) => (
                <span class="rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-200">
                  {symbol} x{count}
                </span>
              ))}
              {intervalMix().map(([interval, count]) => (
                <span class="rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-200">
                  {interval} x{count}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {launchNotice() ? (
        <div class="rounded-2xl border border-emerald-700/70 bg-emerald-950/70 px-4 py-3 text-sm text-emerald-200 shadow-[0_12px_30px_rgba(0,0,0,0.2)]">
          {launchNotice()}
        </div>
      ) : null}

      <div class="flex min-h-0 flex-1 flex-col gap-6">
        <section class="flex min-h-0 w-full flex-col overflow-hidden border-y border-zinc-800/80 bg-zinc-950/60 shadow-[0_18px_50px_rgba(0,0,0,0.24)]">
            <WorkspaceToolbar
              workspaceId={activeWorkspace().id}
              defaultWorkspaceId={workspace.defaultWorkspaceId}
              workspaceName={activeWorkspace().name}
              workspaceCount={workspace.workspaces.length}
              accountProfile={activeWorkspace().accountProfile}
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
              onWorkspaceAccountProfileChange={handleWorkspaceAccountProfileChange}
              onCreateWorkspace={handleCreateWorkspace}
              onDeleteWorkspace={handleDeleteWorkspace}
              onPresetChange={handlePresetChange}
              onAddChart={handleAddChart}
            />
            <div class="min-h-0 flex-1 p-4 lg:p-5">
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
