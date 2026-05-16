import {
  normalizePriceChartIndicatorSettings,
  type PriceChartIndicatorSettings,
} from "../../services/chartIndicators.ts";

export type WorkspacePreset = "focus" | "split" | "grid";

export type ChartSourceMode = "live" | "historical";

export type ChartPanelQuery =
  | {
      mode: "live";
      symbol: string;
      interval: string;
      period: string;
      indicators?: PriceChartIndicatorSettings;
    }
  | {
      mode: "historical";
      symbol: string;
      interval: string;
      startDate?: string;
      endDate?: string;
      indicators?: PriceChartIndicatorSettings;
    };

export interface ChartPanelConfig {
  id: string;
  title: string;
  query: ChartPanelQuery;
}

export interface FocusWorkspaceLayout {
  kind: "focus";
  rowWeights: number[];
}

export interface SplitWorkspaceLayout {
  kind: "split";
  rowWeights: number[];
  columnRatios: number[];
}

export interface GridWorkspaceLayout {
  kind: "grid";
  rowWeights: number[];
  columnRatios: number[];
}

export type WorkspaceLayout =
  | FocusWorkspaceLayout
  | SplitWorkspaceLayout
  | GridWorkspaceLayout;

export interface WorkspacePresetState {
  panels: ChartPanelConfig[];
  layout: WorkspaceLayout;
}

export interface WorkspaceState {
  selectedPreset: WorkspacePreset;
  presets: Record<WorkspacePreset, WorkspacePresetState>;
}

export interface WorkspaceAccountProfile {
  propFirm: string;
  accountLabel: string;
  accountStage: string;
  dailyLossLimit: number | null;
  maxDrawdown: number | null;
  profitTarget: number | null;
  notes: string;
}

export interface SavedWorkspace extends WorkspaceState {
  id: string;
  name: string;
  accountProfile: WorkspaceAccountProfile;
}

export interface WorkspaceCollectionState {
  selectedWorkspaceId: string;
  defaultWorkspaceId: string;
  workspaces: SavedWorkspace[];
}

export interface WorkspacePresetOption {
  value: WorkspacePreset;
  label: string;
  description: string;
}

const MIN_RATIO = 0.3;
export const MAX_WORKSPACE_PANELS = 6;
export const DEFAULT_WORKSPACE_NAME = "Main Workspace";
export const MAX_WORKSPACE_NAME_LENGTH = 36;
export const MAX_PANEL_TITLE_LENGTH = 40;
export const MAX_WORKSPACE_ACCOUNT_FIELD_LENGTH = 48;
export const MAX_WORKSPACE_ACCOUNT_NOTES_LENGTH = 220;

function formatDate(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function cloneQuery(query: ChartPanelQuery): ChartPanelQuery {
  return {
    ...query,
    indicators: normalizePriceChartIndicatorSettings(query.indicators),
  };
}

function createPanelId(preset: WorkspacePreset): string {
  return `${preset}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createWorkspaceId(): string {
  return `workspace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildPanelTemplates(): Record<WorkspacePreset, Omit<ChartPanelConfig, "id">[]> {
  const weekStart = formatDate(7);
  const monthStart = formatDate(30);
  const quarterStart = formatDate(90);
  const today = formatDate(0);

  return {
    focus: [
      {
        title: "NQ 15m",
        query: {
          mode: "live",
          symbol: "NQ",
          interval: "15m",
          period: "30d",
        },
      },
      {
        title: "ES 1h",
        query: {
          mode: "historical",
          symbol: "ES",
          interval: "1h",
          startDate: monthStart,
          endDate: today,
        },
      },
      {
        title: "ES 5m",
        query: {
          mode: "live",
          symbol: "ES",
          interval: "5m",
          period: "7d",
        },
      },
    ],
    split: [
      {
        title: "NQ 5m",
        query: {
          mode: "live",
          symbol: "NQ",
          interval: "5m",
          period: "7d",
        },
      },
      {
        title: "ES 1h",
        query: {
          mode: "historical",
          symbol: "ES",
          interval: "1h",
          startDate: monthStart,
          endDate: today,
        },
      },
      {
        title: "NQ 4h",
        query: {
          mode: "historical",
          symbol: "NQ",
          interval: "4h",
          startDate: quarterStart,
          endDate: today,
        },
      },
      {
        title: "ES 15m",
        query: {
          mode: "live",
          symbol: "ES",
          interval: "15m",
          period: "30d",
        },
      },
    ],
    grid: [
      {
        title: "NQ 5m",
        query: {
          mode: "live",
          symbol: "NQ",
          interval: "5m",
          period: "7d",
        },
      },
      {
        title: "ES 15m",
        query: {
          mode: "live",
          symbol: "ES",
          interval: "15m",
          period: "30d",
        },
      },
      {
        title: "NQ 1h",
        query: {
          mode: "historical",
          symbol: "NQ",
          interval: "1h",
          startDate: monthStart,
          endDate: today,
        },
      },
      {
        title: "ES 4h",
        query: {
          mode: "historical",
          symbol: "ES",
          interval: "4h",
          startDate: quarterStart,
          endDate: today,
        },
      },
      {
        title: "NQ 1m",
        query: {
          mode: "live",
          symbol: "NQ",
          interval: "1m",
          period: "5d",
        },
      },
      {
        title: "ES 1d",
        query: {
          mode: "historical",
          symbol: "ES",
          interval: "1d",
          startDate: weekStart,
          endDate: today,
        },
      },
    ],
  };
}

function buildTemplatePanel(preset: WorkspacePreset, index: number): ChartPanelConfig {
  const templates = buildPanelTemplates()[preset];
  const template = templates[index % templates.length] ?? templates[0];
  const isDefaultSlot = index < templates.length;

  return {
    id: createPanelId(preset),
    title: isDefaultSlot ? template.title : `Chart ${index + 1}`,
    query: cloneQuery(template.query),
  };
}

function normalizeWeights(value: unknown, count: number): number[] {
  if (count <= 0) {
    return [];
  }

  const values = Array.isArray(value) ? value : [];
  const nextWeights = Array.from({ length: count }, (_, index) => {
    const candidate = values[index];
    return typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0
      ? candidate
      : 1;
  });

  return nextWeights;
}

function normalizeColumnRatios(value: unknown, count: number): number[] {
  if (count <= 0) {
    return [];
  }

  const values = Array.isArray(value) ? value : [];
  return Array.from({ length: count }, (_, index) =>
    clampWorkspaceRatio(
      typeof values[index] === "number" ? values[index] : Number.NaN,
      0.5,
    ),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function cloneLayout(layout: WorkspaceLayout): WorkspaceLayout {
  if (layout.kind === "focus") {
    return {
      kind: "focus",
      rowWeights: [...layout.rowWeights],
    };
  }

  return {
    kind: layout.kind,
    rowWeights: [...layout.rowWeights],
    columnRatios: [...layout.columnRatios],
  };
}

function cloneWorkspaceAccountProfile(profile: WorkspaceAccountProfile): WorkspaceAccountProfile {
  return {
    propFirm: profile.propFirm,
    accountLabel: profile.accountLabel,
    accountStage: profile.accountStage,
    dailyLossLimit: profile.dailyLossLimit,
    maxDrawdown: profile.maxDrawdown,
    profitTarget: profile.profitTarget,
    notes: profile.notes,
  };
}

function normalizeOptionalRiskNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.round(parsed * 100) / 100;
}

function normalizeAccountText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") {
    return fallback;
  }

  return value.trim().replace(/\s+/g, " ").slice(0, MAX_WORKSPACE_ACCOUNT_FIELD_LENGTH);
}

function normalizeAccountNotes(value: unknown, fallback = ""): string {
  if (typeof value !== "string") {
    return fallback;
  }

  return value.trim().replace(/\s+/g, " ").slice(0, MAX_WORKSPACE_ACCOUNT_NOTES_LENGTH);
}

export function defaultWorkspaceAccountProfile(): WorkspaceAccountProfile {
  return {
    propFirm: "",
    accountLabel: "",
    accountStage: "Evaluation",
    dailyLossLimit: null,
    maxDrawdown: null,
    profitTarget: null,
    notes: "",
  };
}

export function normalizeWorkspaceAccountProfile(
  value: unknown,
  fallback: WorkspaceAccountProfile = defaultWorkspaceAccountProfile(),
): WorkspaceAccountProfile {
  const record = asRecord(value);

  if (!record) {
    return cloneWorkspaceAccountProfile(fallback);
  }

  return {
    propFirm: normalizeAccountText(record.propFirm, fallback.propFirm),
    accountLabel: normalizeAccountText(record.accountLabel, fallback.accountLabel),
    accountStage:
      normalizeAccountText(record.accountStage, fallback.accountStage) || fallback.accountStage,
    dailyLossLimit: normalizeOptionalRiskNumber(record.dailyLossLimit),
    maxDrawdown: normalizeOptionalRiskNumber(record.maxDrawdown),
    profitTarget: normalizeOptionalRiskNumber(record.profitTarget),
    notes: normalizeAccountNotes(record.notes, fallback.notes),
  };
}

function clonePresetState(state: WorkspacePresetState): WorkspacePresetState {
  return {
    panels: state.panels.map((panel) => ({
      id: panel.id,
      title: panel.title,
      query: cloneQuery(panel.query),
    })),
    layout: cloneLayout(state.layout),
  };
}

export const WORKSPACE_PRESET_OPTIONS: WorkspacePresetOption[] = [
  {
    value: "focus",
    label: "1 Chart",
    description: "One big chart when you just want to lock in on a single idea.",
  },
  {
    value: "split",
    label: "2 Charts",
    description: "A clean split for comparing symbols or timeframes side by side.",
  },
  {
    value: "grid",
    label: "4 Charts",
    description: "The default trading workspace with enough surface area to feel real.",
  },
];

export function clampWorkspaceRatio(value: number, fallback = 0.5): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, value));
}

export function getWorkspaceColumnCount(preset: WorkspacePreset, panelCount: number): number {
  if (preset === "focus" || panelCount <= 1) {
    return 1;
  }

  return 2;
}

export function getWorkspaceRowCount(preset: WorkspacePreset, panelCount: number): number {
  const safeCount = Math.max(1, Math.min(panelCount, MAX_WORKSPACE_PANELS));
  return Math.ceil(safeCount / getWorkspaceColumnCount(preset, safeCount));
}

export function buildWorkspacePanels(preset: WorkspacePreset): ChartPanelConfig[] {
  const countByPreset: Record<WorkspacePreset, number> = {
    focus: 1,
    split: 2,
    grid: 4,
  };

  return Array.from({ length: countByPreset[preset] }, (_, index) => buildTemplatePanel(preset, index));
}

export function createWorkspacePanel(
  preset: WorkspacePreset,
  existingCount: number,
): ChartPanelConfig {
  return buildTemplatePanel(preset, existingCount);
}

export function reconcileWorkspaceLayout(
  preset: WorkspacePreset,
  layout: WorkspaceLayout | null | undefined,
  panelCount: number,
): WorkspaceLayout {
  const rowCount = getWorkspaceRowCount(preset, panelCount);
  const record = asRecord(layout);

  if (preset === "focus") {
    return {
      kind: "focus",
      rowWeights: normalizeWeights(record?.rowWeights, rowCount),
    };
  }

  return {
    kind: preset,
    rowWeights: normalizeWeights(record?.rowWeights, rowCount),
    columnRatios: normalizeColumnRatios(record?.columnRatios, rowCount),
  };
}

export function buildWorkspaceLayout(preset: WorkspacePreset): WorkspaceLayout {
  return reconcileWorkspaceLayout(preset, null, buildWorkspacePanels(preset).length);
}

export function buildWorkspacePresetState(preset: WorkspacePreset): WorkspacePresetState {
  const panels = buildWorkspacePanels(preset);
  return {
    panels,
    layout: reconcileWorkspaceLayout(preset, null, panels.length),
  };
}

export function buildDefaultWorkspaceState(): WorkspaceState {
  return {
    selectedPreset: "grid",
    presets: {
      focus: buildWorkspacePresetState("focus"),
      split: buildWorkspacePresetState("split"),
      grid: buildWorkspacePresetState("grid"),
    },
  };
}

export function normalizeWorkspaceName(value: unknown, fallback = DEFAULT_WORKSPACE_NAME): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const cleaned = value.trim().replace(/\s+/g, " ").slice(0, MAX_WORKSPACE_NAME_LENGTH);
  return cleaned || fallback;
}

export function normalizePanelTitle(value: unknown, fallback = "Chart"): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const cleaned = value.trim().replace(/\s+/g, " ").slice(0, MAX_PANEL_TITLE_LENGTH);
  return cleaned || fallback;
}

export function cloneWorkspaceState(state: WorkspaceState): WorkspaceState {
  return {
    selectedPreset: state.selectedPreset,
    presets: {
      focus: clonePresetState(state.presets.focus),
      split: clonePresetState(state.presets.split),
      grid: clonePresetState(state.presets.grid),
    },
  };
}

export function buildSavedWorkspace(
  name = DEFAULT_WORKSPACE_NAME,
  state: WorkspaceState = buildDefaultWorkspaceState(),
  accountProfile: WorkspaceAccountProfile = defaultWorkspaceAccountProfile(),
): SavedWorkspace {
  const nextState = cloneWorkspaceState(state);

  return {
    id: createWorkspaceId(),
    name: normalizeWorkspaceName(name),
    selectedPreset: nextState.selectedPreset,
    presets: nextState.presets,
    accountProfile: normalizeWorkspaceAccountProfile(accountProfile),
  };
}

export function buildDefaultWorkspaceCollectionState(): WorkspaceCollectionState {
  const workspace = buildSavedWorkspace();
  return {
    selectedWorkspaceId: workspace.id,
    defaultWorkspaceId: workspace.id,
    workspaces: [workspace],
  };
}

function normalizeQuery(query: unknown, fallback: ChartPanelQuery): ChartPanelQuery {
  const record = asRecord(query);
  if (!record) {
    return fallback;
  }

  const symbol = typeof record.symbol === "string" && record.symbol.trim() ? record.symbol : fallback.symbol;
  const interval =
    typeof record.interval === "string" && record.interval.trim() ? record.interval : fallback.interval;

  if (record.mode === "live" && typeof record.period === "string" && record.period.trim()) {
    return {
      mode: "live",
      symbol,
      interval,
      period: record.period,
      indicators: normalizePriceChartIndicatorSettings(
        asRecord(record.indicators) as Partial<PriceChartIndicatorSettings> | null | undefined,
      ),
    };
  }

  if (
    record.mode === "historical" &&
    (typeof record.startDate === "string" || typeof record.startDate === "undefined") &&
    (typeof record.endDate === "string" || typeof record.endDate === "undefined")
  ) {
    return {
      mode: "historical",
      symbol,
      interval,
      startDate: typeof record.startDate === "string" ? record.startDate : undefined,
      endDate: typeof record.endDate === "string" ? record.endDate : undefined,
      indicators: normalizePriceChartIndicatorSettings(
        asRecord(record.indicators) as Partial<PriceChartIndicatorSettings> | null | undefined,
      ),
    };
  }

  return fallback;
}

// Titles from earlier builds that we no longer want resurfacing on load.
const LEGACY_PANEL_TITLES = new Set([
  "Primary View",
  "Secondary Context",
  "Fast Tape",
  "Live Momentum",
  "Historical Context",
  "Higher Timeframe",
  "Quick Crosscheck",
  "NQ Flow",
  "ES Trend",
  "NQ Warehouse",
  "ES Higher Timeframe",
  "Short-Term Pulse",
  "Weekly Context",
]);

function normalizePanels(value: unknown, preset: WorkspacePreset): ChartPanelConfig[] {
  const templates = buildWorkspacePanels(preset);

  if (!Array.isArray(value) || value.length === 0) {
    return templates;
  }

  // Old saves can carry extra panels from earlier layouts, so we only keep the
  // preset's canonical slots here and let the current template fill any gaps.
  return templates.map((template, index) => {
    const candidate = value[index];
    const record = asRecord(candidate);

    if (!record) {
      return template;
    }

    const rawTitle = typeof record.title === "string" ? record.title.trim() : "";
    const title = LEGACY_PANEL_TITLES.has(rawTitle)
      ? template.title
      : normalizePanelTitle(record.title, template.title);

    return {
      id: typeof record.id === "string" && record.id.trim() ? record.id : template.id,
      title,
      query: normalizeQuery(record.query, template.query),
    };
  });
}

export function normalizeWorkspaceState(value: unknown): WorkspaceState {
  const defaults = buildDefaultWorkspaceState();
  const record = asRecord(value);

  if (!record) {
    return defaults;
  }

  const presetsRecord = asRecord(record.presets);
  const focusPreset = asRecord(presetsRecord?.focus);
  const splitPreset = asRecord(presetsRecord?.split);
  const gridPreset = asRecord(presetsRecord?.grid);

  const focusPanels = normalizePanels(focusPreset?.panels, "focus");
  const splitPanels = normalizePanels(splitPreset?.panels, "split");
  const gridPanels = normalizePanels(gridPreset?.panels, "grid");

  return {
    selectedPreset:
      record.selectedPreset === "focus" || record.selectedPreset === "split" || record.selectedPreset === "grid"
        ? record.selectedPreset
        : defaults.selectedPreset,
    presets: {
      focus: {
        panels: focusPanels,
        layout: reconcileWorkspaceLayout("focus", focusPreset?.layout as WorkspaceLayout, focusPanels.length),
      },
      split: {
        panels: splitPanels,
        layout: reconcileWorkspaceLayout("split", splitPreset?.layout as WorkspaceLayout, splitPanels.length),
      },
      grid: {
        panels: gridPanels,
        layout: reconcileWorkspaceLayout("grid", gridPreset?.layout as WorkspaceLayout, gridPanels.length),
      },
    },
  };
}

export function createWorkspaceCopyName(baseName: string, existingNames: string[]): string {
  const cleanedBase = normalizeWorkspaceName(baseName);
  const taken = new Set(existingNames.map((name) => normalizeWorkspaceName(name)));
  const firstTry = `${cleanedBase} Copy`.slice(0, MAX_WORKSPACE_NAME_LENGTH);

  if (!taken.has(firstTry)) {
    return firstTry;
  }

  let copyIndex = 2;
  while (copyIndex < 100) {
    const candidate = `${cleanedBase} Copy ${copyIndex}`.slice(0, MAX_WORKSPACE_NAME_LENGTH);
    if (!taken.has(candidate)) {
      return candidate;
    }

    copyIndex += 1;
  }

  return normalizeWorkspaceName(`${cleanedBase} Copy`, cleanedBase);
}

/**
 * Turn whatever is in localStorage into a sane saved-workspace collection.
 *
 * Older dashboard builds only stored one workspace object, so this quietly
 * wraps that shape in a named workspace instead of wiping out somebody's panels
 * the first time they land on the new version.
 */
export function normalizeWorkspaceCollectionState(value: unknown): WorkspaceCollectionState {
  const defaults = buildDefaultWorkspaceCollectionState();
  const record = asRecord(value);

  if (!record) {
    return defaults;
  }

  if (!Array.isArray(record.workspaces)) {
    const migrated = buildSavedWorkspace(DEFAULT_WORKSPACE_NAME, normalizeWorkspaceState(value));
    return {
      selectedWorkspaceId: migrated.id,
      defaultWorkspaceId: migrated.id,
      workspaces: [migrated],
    };
  }

  const usedIds = new Set<string>();
  const workspaces = record.workspaces
    .map((candidate, index) => {
      const candidateRecord = asRecord(candidate);
      if (!candidateRecord) {
        return null;
      }

      const normalizedState = normalizeWorkspaceState(candidateRecord);
      const preferredId =
        typeof candidateRecord.id === "string" && candidateRecord.id.trim()
          ? candidateRecord.id
          : createWorkspaceId();
      const id = usedIds.has(preferredId) ? createWorkspaceId() : preferredId;

      usedIds.add(id);

      return {
        id,
        name: normalizeWorkspaceName(candidateRecord.name, `Workspace ${index + 1}`),
        selectedPreset: normalizedState.selectedPreset,
        presets: normalizedState.presets,
        accountProfile: normalizeWorkspaceAccountProfile(candidateRecord.accountProfile),
      } satisfies SavedWorkspace;
    })
    .filter((workspace): workspace is SavedWorkspace => workspace !== null);

  if (workspaces.length === 0) {
    return defaults;
  }

  const selectedWorkspaceId =
    typeof record.selectedWorkspaceId === "string" &&
    workspaces.some((workspace) => workspace.id === record.selectedWorkspaceId)
      ? record.selectedWorkspaceId
      : workspaces[0].id;
  const defaultWorkspaceId =
    typeof record.defaultWorkspaceId === "string" &&
    workspaces.some((workspace) => workspace.id === record.defaultWorkspaceId)
      ? record.defaultWorkspaceId
      : selectedWorkspaceId;

  return {
    selectedWorkspaceId,
    defaultWorkspaceId,
    workspaces,
  };
}
