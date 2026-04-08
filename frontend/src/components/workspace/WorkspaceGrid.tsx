import type { JSX } from "solid-js";
import ChartPanel from "./ChartPanel";
import {
  clampWorkspaceRatio,
  getWorkspaceColumnCount,
  type ChartPanelConfig,
  type ChartPanelQuery,
  type FocusWorkspaceLayout,
  type GridWorkspaceLayout,
  type SplitWorkspaceLayout,
  type WorkspaceLayout,
  type WorkspacePreset,
} from "./chartPanelTypes";

interface Props {
  preset: WorkspacePreset;
  panels: ChartPanelConfig[];
  layout: WorkspaceLayout;
  onLayoutChange: (layout: WorkspaceLayout) => void;
  onPanelQueryChange: (panelId: string, query: ChartPanelQuery) => void;
  onPanelRemove: (panelId: string) => void;
}

interface ResizeHandleProps {
  axis: "x" | "y";
  style: JSX.CSSProperties;
  onPointerDown: JSX.EventHandlerUnion<HTMLButtonElement, PointerEvent>;
}

function chunkPanels(panels: ChartPanelConfig[], size: number): ChartPanelConfig[][] {
  const rows: ChartPanelConfig[][] = [];

  for (let index = 0; index < panels.length; index += size) {
    rows.push(panels.slice(index, index + size));
  }

  return rows;
}

function getBoundaryOffsets(weights: number[]): number[] {
  if (weights.length <= 1) {
    return [];
  }

  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let running = 0;

  return weights.slice(0, -1).map((weight) => {
    running += weight;
    return running / total;
  });
}

function getDesktopMinHeight(rowCount: number): string {
  return `${Math.max(720, rowCount * 420)}px`;
}

function ResizeHandle(props: ResizeHandleProps) {
  const isVertical = props.axis === "x";

  return (
    <button
      type="button"
      aria-label={isVertical ? "Resize chart columns" : "Resize chart rows"}
      class={`absolute z-20 hidden rounded-full border border-zinc-600 bg-zinc-950/95 shadow-[0_0_0_1px_rgba(24,24,27,0.65)] transition-colors hover:border-zinc-400 hover:bg-zinc-900 xl:flex ${
        isVertical
          ? "top-6 bottom-6 w-3 -translate-x-1/2 cursor-col-resize items-center justify-center"
          : "left-6 right-6 h-3 -translate-y-1/2 cursor-row-resize items-center justify-center"
      }`}
      style={props.style}
      onPointerDown={props.onPointerDown}
    >
      <span
        class={`rounded-full bg-zinc-500/80 ${isVertical ? "h-16 w-[3px]" : "h-[3px] w-16"}`}
      />
    </button>
  );
}

function beginRatioResize(
  event: PointerEvent,
  container: HTMLDivElement | undefined,
  axis: "x" | "y",
  onRatioChange: (ratio: number) => void,
) {
  if (!container) {
    return;
  }

  event.preventDefault();

  const target = event.currentTarget as HTMLElement | null;
  target?.setPointerCapture(event.pointerId);

  const updateRatio = (nextEvent: PointerEvent) => {
    const rect = container.getBoundingClientRect();
    const rawRatio =
      axis === "x"
        ? (nextEvent.clientX - rect.left) / rect.width
        : (nextEvent.clientY - rect.top) / rect.height;

    onRatioChange(clampWorkspaceRatio(rawRatio));
  };

  const stopResize = () => {
    window.removeEventListener("pointermove", updateRatio);
    window.removeEventListener("pointerup", stopResize);
    target?.releasePointerCapture(event.pointerId);
  };

  window.addEventListener("pointermove", updateRatio);
  window.addEventListener("pointerup", stopResize);
  updateRatio(event);
}

function beginWeightResize(
  event: PointerEvent,
  container: HTMLDivElement | undefined,
  axis: "x" | "y",
  weights: number[],
  boundaryIndex: number,
  onWeightsChange: (weights: number[]) => void,
) {
  if (!container || boundaryIndex < 0 || boundaryIndex >= weights.length - 1) {
    return;
  }

  event.preventDefault();

  const target = event.currentTarget as HTMLElement | null;
  target?.setPointerCapture(event.pointerId);

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const startWeight = weights.slice(0, boundaryIndex).reduce((sum, weight) => sum + weight, 0);
  const pairWeight = weights[boundaryIndex] + weights[boundaryIndex + 1];

  const updateWeights = (nextEvent: PointerEvent) => {
    const rect = container.getBoundingClientRect();
    const size = axis === "x" ? rect.width : rect.height;
    const position = axis === "x" ? nextEvent.clientX - rect.left : nextEvent.clientY - rect.top;
    const pairStart = (startWeight / totalWeight) * size;
    const pairSize = (pairWeight / totalWeight) * size;
    const pairRatio = clampWorkspaceRatio((position - pairStart) / pairSize);
    const nextWeights = [...weights];

    nextWeights[boundaryIndex] = pairWeight * pairRatio;
    nextWeights[boundaryIndex + 1] = pairWeight * (1 - pairRatio);
    onWeightsChange(nextWeights);
  };

  const stopResize = () => {
    window.removeEventListener("pointermove", updateWeights);
    window.removeEventListener("pointerup", stopResize);
    target?.releasePointerCapture(event.pointerId);
  };

  window.addEventListener("pointermove", updateWeights);
  window.addEventListener("pointerup", stopResize);
  updateWeights(event);
}

function PanelSlot(props: {
  panel: ChartPanelConfig | undefined;
  canRemove: boolean;
  onPanelQueryChange: (panelId: string, query: ChartPanelQuery) => void;
  onPanelRemove: (panelId: string) => void;
}) {
  const panel = props.panel;

  if (!panel) {
    return null;
  }

  return (
    <div class="min-h-0 min-w-0">
      <ChartPanel
        panel={panel}
        canRemove={props.canRemove}
        onQueryChange={(query) => props.onPanelQueryChange(panel.id, query)}
        onRemove={() => props.onPanelRemove(panel.id)}
      />
    </div>
  );
}

function DesktopRow(props: {
  panels: ChartPanelConfig[];
  columnRatio: number | null;
  canRemove: boolean;
  onColumnRatioChange: ((ratio: number) => void) | null;
  onPanelQueryChange: (panelId: string, query: ChartPanelQuery) => void;
  onPanelRemove: (panelId: string) => void;
}) {
  let container!: HTMLDivElement;
  const rightPanel = () => props.panels[1];

  return (
    <div class="relative h-full">
      <div ref={container} class="flex h-full gap-4">
        <div
          class="min-h-0 min-w-0"
          style={{ flex: `${props.columnRatio ?? 1} 1 0%` }}
        >
          <PanelSlot
            panel={props.panels[0]}
            canRemove={props.canRemove}
            onPanelQueryChange={props.onPanelQueryChange}
            onPanelRemove={props.onPanelRemove}
          />
        </div>

        {rightPanel() ? (
          <div
            class="min-h-0 min-w-0"
            style={{ flex: `${1 - (props.columnRatio ?? 0.5)} 1 0%` }}
          >
            <PanelSlot
              panel={rightPanel()}
              canRemove={props.canRemove}
              onPanelQueryChange={props.onPanelQueryChange}
              onPanelRemove={props.onPanelRemove}
            />
          </div>
        ) : null}
      </div>

      {rightPanel() && props.onColumnRatioChange ? (
        <ResizeHandle
          axis="x"
          style={{ left: `${(props.columnRatio ?? 0.5) * 100}%` }}
          onPointerDown={(event) =>
            beginRatioResize(event, container, "x", props.onColumnRatioChange!)
          }
        />
      ) : null}
    </div>
  );
}

function FocusDesktopLayout(props: {
  panels: ChartPanelConfig[];
  layout: FocusWorkspaceLayout;
  onLayoutChange: (layout: FocusWorkspaceLayout) => void;
  onPanelQueryChange: (panelId: string, query: ChartPanelQuery) => void;
  onPanelRemove: (panelId: string) => void;
}) {
  let container!: HTMLDivElement;
  const rowOffsets = getBoundaryOffsets(props.layout.rowWeights);

  return (
    <div class="relative hidden xl:block">
      <div
        ref={container}
        class="flex flex-col gap-4"
        style={{ "min-height": getDesktopMinHeight(props.panels.length) }}
      >
        {props.panels.map((panel, index) => (
          <div class="min-h-0" style={{ flex: `${props.layout.rowWeights[index] ?? 1} 1 0%` }}>
            <PanelSlot
              panel={panel}
              canRemove={props.panels.length > 1}
              onPanelQueryChange={props.onPanelQueryChange}
              onPanelRemove={props.onPanelRemove}
            />
          </div>
        ))}
      </div>

      {rowOffsets.map((offset, index) => (
        <ResizeHandle
          axis="y"
          style={{ top: `${offset * 100}%` }}
          onPointerDown={(event) =>
            beginWeightResize(event, container, "y", props.layout.rowWeights, index, (rowWeights) =>
              props.onLayoutChange({ ...props.layout, rowWeights }),
            )
          }
        />
      ))}
    </div>
  );
}

function TiledDesktopLayout(props: {
  preset: "split" | "grid";
  panels: ChartPanelConfig[];
  layout: SplitWorkspaceLayout | GridWorkspaceLayout;
  onLayoutChange: (layout: SplitWorkspaceLayout | GridWorkspaceLayout) => void;
  onPanelQueryChange: (panelId: string, query: ChartPanelQuery) => void;
  onPanelRemove: (panelId: string) => void;
}) {
  let container!: HTMLDivElement;
  const rows = chunkPanels(props.panels, getWorkspaceColumnCount(props.preset, props.panels.length));
  const rowOffsets = getBoundaryOffsets(props.layout.rowWeights);

  return (
    <div class="relative hidden xl:block">
      <div
        ref={container}
        class="flex flex-col gap-4"
        style={{ "min-height": getDesktopMinHeight(rows.length) }}
      >
        {rows.map((row, index) => (
          <div class="min-h-0" style={{ flex: `${props.layout.rowWeights[index] ?? 1} 1 0%` }}>
            <DesktopRow
              panels={row}
              columnRatio={row.length > 1 ? props.layout.columnRatios[index] ?? 0.5 : null}
              canRemove={props.panels.length > 1}
              onColumnRatioChange={
                row.length > 1
                  ? (ratio) => {
                      const columnRatios = [...props.layout.columnRatios];
                      columnRatios[index] = ratio;
                      props.onLayoutChange({ ...props.layout, columnRatios });
                    }
                  : null
              }
              onPanelQueryChange={props.onPanelQueryChange}
              onPanelRemove={props.onPanelRemove}
            />
          </div>
        ))}
      </div>

      {rowOffsets.map((offset, index) => (
        <ResizeHandle
          axis="y"
          style={{ top: `${offset * 100}%` }}
          onPointerDown={(event) =>
            beginWeightResize(event, container, "y", props.layout.rowWeights, index, (rowWeights) =>
              props.onLayoutChange({ ...props.layout, rowWeights }),
            )
          }
        />
      ))}
    </div>
  );
}

export default function WorkspaceGrid(props: Props) {
  return (
    <>
      <div class="grid gap-4 xl:hidden">
        {props.panels.map((panel) => (
          <PanelSlot
            panel={panel}
            canRemove={props.panels.length > 1}
            onPanelQueryChange={props.onPanelQueryChange}
            onPanelRemove={props.onPanelRemove}
          />
        ))}
      </div>

      {props.layout.kind === "focus" ? (
        <FocusDesktopLayout
          panels={props.panels}
          layout={props.layout}
          onLayoutChange={props.onLayoutChange}
          onPanelQueryChange={props.onPanelQueryChange}
          onPanelRemove={props.onPanelRemove}
        />
      ) : null}

      {props.layout.kind === "split" || props.layout.kind === "grid" ? (
        <TiledDesktopLayout
          preset={props.layout.kind}
          panels={props.panels}
          layout={props.layout}
          onLayoutChange={props.onLayoutChange}
          onPanelQueryChange={props.onPanelQueryChange}
          onPanelRemove={props.onPanelRemove}
        />
      ) : null}
    </>
  );
}
