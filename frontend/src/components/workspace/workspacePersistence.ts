import { BACKTEST_INTERVALS, getBackendInterval } from "../../constants";
import {
  cloneWorkspaceState,
  createWorkspacePanel,
  normalizeWorkspaceAccountProfile,
  normalizeWorkspaceCollectionState,
  type ChartPanelQuery,
  type SavedWorkspace,
  type WorkspaceAccountProfile,
  type WorkspaceCollectionState,
} from "./chartPanelTypes";

export const WORKSPACE_STORAGE_KEY = "trading-lab.dashboard.workspace.v1";

export type WorkspaceLaunchSource = "backtest" | "replay-session" | "replay-lab";

export interface WorkspaceLaunchIntent {
  source: WorkspaceLaunchSource;
  workspaceId?: string;
  symbol: string;
  interval: string;
  startDate?: string;
  endDate?: string;
}

export interface ActiveWorkspaceContext {
  workspaceId: string;
  workspaceName: string;
  accountProfile: WorkspaceAccountProfile;
  query: ChartPanelQuery | null;
}

function normalizeIntervalValue(value: string): string {
  const matched =
    BACKTEST_INTERVALS.find((interval) => interval.value === value) ??
    BACKTEST_INTERVALS.find(
      (interval) => getBackendInterval(interval).toLowerCase() === value.toLowerCase(),
    );

  return matched?.value ?? BACKTEST_INTERVALS.find((interval) => interval.value === "15m")!.value;
}

function cloneSavedWorkspace(workspace: SavedWorkspace): SavedWorkspace {
  const nextState = cloneWorkspaceState(workspace);

  return {
    id: workspace.id,
    name: workspace.name,
    selectedPreset: nextState.selectedPreset,
    presets: nextState.presets,
    accountProfile: normalizeWorkspaceAccountProfile(workspace.accountProfile),
  };
}

function resolvePrimaryQuery(workspace: SavedWorkspace): ChartPanelQuery | null {
  const selectedPresetPanels = workspace.presets[workspace.selectedPreset]?.panels ?? [];
  const selectedPanelQuery = selectedPresetPanels[0]?.query;
  if (selectedPanelQuery) {
    return selectedPanelQuery;
  }

  for (const preset of Object.values(workspace.presets)) {
    const query = preset.panels[0]?.query;
    if (query) {
      return query;
    }
  }

  return null;
}

function buildHistoricalLaunchQuery(intent: WorkspaceLaunchIntent): ChartPanelQuery {
  return {
    mode: "historical",
    symbol: intent.symbol,
    interval: normalizeIntervalValue(intent.interval),
    startDate: intent.startDate,
    endDate: intent.endDate,
  };
}

export function describeWorkspaceLaunchSource(source: WorkspaceLaunchSource): string {
  if (source === "backtest") {
    return "saved backtest";
  }

  if (source === "replay-session") {
    return "saved replay session";
  }

  return "replay setup";
}

export function loadWorkspaceCollectionState(): WorkspaceCollectionState {
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

export function loadActiveWorkspaceContext(
  preferredWorkspaceId?: string | null,
): ActiveWorkspaceContext | null {
  const state = loadWorkspaceCollectionState();
  const workspaceId = resolveWorkspaceId(state, preferredWorkspaceId ?? undefined);
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);

  if (!workspace) {
    return null;
  }

  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    accountProfile: normalizeWorkspaceAccountProfile(workspace.accountProfile),
    query: resolvePrimaryQuery(workspace),
  };
}

export function saveWorkspaceCollectionState(state: WorkspaceCollectionState): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(state));
}

export function resolveWorkspaceId(
  state: WorkspaceCollectionState,
  preferredId?: string | null,
): string {
  if (preferredId && state.workspaces.some((workspace) => workspace.id === preferredId)) {
    return preferredId;
  }

  if (state.workspaces.some((workspace) => workspace.id === state.defaultWorkspaceId)) {
    return state.defaultWorkspaceId;
  }

  if (state.workspaces.some((workspace) => workspace.id === state.selectedWorkspaceId)) {
    return state.selectedWorkspaceId;
  }

  return state.workspaces[0]?.id ?? "";
}

export function buildWorkspaceLaunchHref(
  intent: WorkspaceLaunchIntent,
  preferredWorkspaceId?: string | null,
): string {
  const state = loadWorkspaceCollectionState();
  const params = new URLSearchParams({
    workspaceId: resolveWorkspaceId(state, preferredWorkspaceId ?? intent.workspaceId),
    source: intent.source,
    symbol: intent.symbol,
    interval: normalizeIntervalValue(intent.interval),
  });

  if (intent.startDate) {
    params.set("startDate", intent.startDate);
  }

  if (intent.endDate) {
    params.set("endDate", intent.endDate);
  }

  return `/?${params.toString()}`;
}

export function parseWorkspaceLaunchSearch(search: string): WorkspaceLaunchIntent | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const source = params.get("source");
  const symbol = params.get("symbol");
  const interval = params.get("interval");

  if (
    (source !== "backtest" && source !== "replay-session" && source !== "replay-lab") ||
    !symbol ||
    !interval
  ) {
    return null;
  }

  return {
    source,
    workspaceId: params.get("workspaceId") || undefined,
    symbol,
    interval: normalizeIntervalValue(interval),
    startDate: params.get("startDate") || undefined,
    endDate: params.get("endDate") || undefined,
  };
}

export function applyWorkspaceLaunch(
  state: WorkspaceCollectionState,
  intent: WorkspaceLaunchIntent,
): WorkspaceCollectionState {
  const normalizedState = normalizeWorkspaceCollectionState(state);
  const targetWorkspaceId = resolveWorkspaceId(normalizedState, intent.workspaceId);
  const workspaceIndex = normalizedState.workspaces.findIndex(
    (workspace) => workspace.id === targetWorkspaceId,
  );

  if (workspaceIndex === -1) {
    return normalizedState;
  }

  const nextWorkspaces = normalizedState.workspaces.map((workspace, index) => {
    if (index !== workspaceIndex) {
      return cloneSavedWorkspace(workspace);
    }

    const nextWorkspace = cloneSavedWorkspace(workspace);
    const preset = nextWorkspace.selectedPreset;
    const presetState = nextWorkspace.presets[preset];

    if (presetState.panels.length === 0) {
      presetState.panels = [createWorkspacePanel(preset, 0)];
    }

    presetState.panels[0] = {
      ...presetState.panels[0],
      query: buildHistoricalLaunchQuery(intent),
    };

    return nextWorkspace;
  });

  return {
    selectedWorkspaceId: targetWorkspaceId,
    defaultWorkspaceId: resolveWorkspaceId(normalizedState, normalizedState.defaultWorkspaceId),
    workspaces: nextWorkspaces,
  };
}
