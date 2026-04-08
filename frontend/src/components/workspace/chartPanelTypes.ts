export type WorkspacePreset = "focus" | "split" | "grid";

export type ChartSourceMode = "live" | "historical";

export type ChartPanelQuery =
  | {
      mode: "live";
      symbol: string;
      interval: string;
      period: string;
    }
  | {
      mode: "historical";
      symbol: string;
      interval: string;
      startDate: string;
      endDate: string;
    };

export interface ChartPanelConfig {
  id: string;
  title: string;
  query: ChartPanelQuery;
}

export interface FocusWorkspaceLayout {
  kind: "focus";
}

export interface SplitWorkspaceLayout {
  kind: "split";
  ratio: number;
}

export interface GridWorkspaceLayout {
  kind: "grid";
  rowRatio: number;
  topRatio: number;
  bottomRatio: number;
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

export interface WorkspacePresetOption {
  value: WorkspacePreset;
  label: string;
  description: string;
}

const MIN_RATIO = 0.3;
const MAX_RATIO = 0.7;

function formatDate(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().slice(0, 10);
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

export function buildWorkspacePanels(preset: WorkspacePreset): ChartPanelConfig[] {
  const monthStart = formatDate(30);
  const quarterStart = formatDate(90);
  const today = formatDate(0);

  if (preset === "focus") {
    return [
      {
        id: "focus-1",
        title: "Primary View",
        query: {
          mode: "live",
          symbol: "NQ",
          interval: "15m",
          period: "30d",
        },
      },
    ];
  }

  if (preset === "split") {
    return [
      {
        id: "split-1",
        title: "Live Momentum",
        query: {
          mode: "live",
          symbol: "NQ",
          interval: "5m",
          period: "7d",
        },
      },
      {
        id: "split-2",
        title: "Historical Context",
        query: {
          mode: "historical",
          symbol: "ES",
          interval: "1h",
          startDate: monthStart,
          endDate: today,
        },
      },
    ];
  }

  return [
    {
      id: "grid-1",
      title: "NQ Flow",
      query: {
        mode: "live",
        symbol: "NQ",
        interval: "5m",
        period: "7d",
      },
    },
    {
      id: "grid-2",
      title: "ES Trend",
      query: {
        mode: "live",
        symbol: "ES",
        interval: "15m",
        period: "30d",
      },
    },
    {
      id: "grid-3",
      title: "NQ Warehouse",
      query: {
        mode: "historical",
        symbol: "NQ",
        interval: "1h",
        startDate: monthStart,
        endDate: today,
      },
    },
    {
      id: "grid-4",
      title: "ES Higher Timeframe",
      query: {
        mode: "historical",
        symbol: "ES",
        interval: "4h",
        startDate: quarterStart,
        endDate: today,
      },
    },
  ];
}

export function clampWorkspaceRatio(value: number, fallback = 0.5): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));
}

export function buildWorkspaceLayout(preset: WorkspacePreset): WorkspaceLayout {
  if (preset === "focus") {
    return { kind: "focus" };
  }

  if (preset === "split") {
    return { kind: "split", ratio: 0.5 };
  }

  return {
    kind: "grid",
    rowRatio: 0.5,
    topRatio: 0.5,
    bottomRatio: 0.5,
  };
}

export function buildWorkspacePresetState(preset: WorkspacePreset): WorkspacePresetState {
  return {
    panels: buildWorkspacePanels(preset),
    layout: buildWorkspaceLayout(preset),
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function normalizeQuery(query: unknown, fallback: ChartPanelQuery): ChartPanelQuery {
  const record = asRecord(query);
  if (!record) {
    return fallback;
  }

  const symbol = typeof record.symbol === "string" && record.symbol.trim() ? record.symbol : fallback.symbol;
  const interval =
    typeof record.interval === "string" && record.interval.trim() ? record.interval : fallback.interval;

  if (
    record.mode === "live" &&
    typeof record.period === "string" &&
    record.period.trim()
  ) {
    return {
      mode: "live",
      symbol,
      interval,
      period: record.period,
    };
  }

  if (
    record.mode === "historical" &&
    typeof record.startDate === "string" &&
    typeof record.endDate === "string" &&
    record.startDate &&
    record.endDate
  ) {
    return {
      mode: "historical",
      symbol,
      interval,
      startDate: record.startDate,
      endDate: record.endDate,
    };
  }

  return fallback;
}

function normalizePanels(value: unknown, preset: WorkspacePreset): ChartPanelConfig[] {
  const defaults = buildWorkspacePanels(preset);
  if (!Array.isArray(value) || value.length !== defaults.length) {
    return defaults;
  }

  return defaults.map((panel, index) => {
    const candidate = asRecord(value[index]);
    if (!candidate) {
      return panel;
    }

    return {
      ...panel,
      title: typeof candidate.title === "string" && candidate.title.trim() ? candidate.title : panel.title,
      query: normalizeQuery(candidate.query, panel.query),
    };
  });
}

function normalizeLayout(value: unknown, preset: WorkspacePreset): WorkspaceLayout {
  const fallback = buildWorkspaceLayout(preset);
  const record = asRecord(value);

  if (!record) {
    return fallback;
  }

  if (preset === "focus") {
    return fallback;
  }

  if (preset === "split") {
    return {
      kind: "split",
      ratio: clampWorkspaceRatio(
        typeof record.ratio === "number" ? record.ratio : Number.NaN,
        0.5,
      ),
    };
  }

  return {
    kind: "grid",
    rowRatio: clampWorkspaceRatio(
      typeof record.rowRatio === "number" ? record.rowRatio : Number.NaN,
      0.5,
    ),
    topRatio: clampWorkspaceRatio(
      typeof record.topRatio === "number" ? record.topRatio : Number.NaN,
      0.5,
    ),
    bottomRatio: clampWorkspaceRatio(
      typeof record.bottomRatio === "number" ? record.bottomRatio : Number.NaN,
      0.5,
    ),
  };
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

  return {
    selectedPreset:
      record.selectedPreset === "focus" || record.selectedPreset === "split" || record.selectedPreset === "grid"
        ? record.selectedPreset
        : defaults.selectedPreset,
    presets: {
      focus: {
        panels: normalizePanels(focusPreset?.panels, "focus"),
        layout: normalizeLayout(focusPreset?.layout, "focus"),
      },
      split: {
        panels: normalizePanels(splitPreset?.panels, "split"),
        layout: normalizeLayout(splitPreset?.layout, "split"),
      },
      grid: {
        panels: normalizePanels(gridPreset?.panels, "grid"),
        layout: normalizeLayout(gridPreset?.layout, "grid"),
      },
    },
  };
}
