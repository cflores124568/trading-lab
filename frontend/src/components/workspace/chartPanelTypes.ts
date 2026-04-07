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

export interface WorkspacePresetOption {
  value: WorkspacePreset;
  label: string;
  description: string;
}

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
