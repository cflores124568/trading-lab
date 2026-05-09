import { createEffect, createSignal, type JSX } from "solid-js";
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
  onPanelTitleChange: (panelId: string, title: string) => void;
  onPanelQueryChange: (panelId: string, query: ChartPanelQuery) => void;
  onPanelRemove: (panelId: string) => void;
  onPanelDuplicate: (panelId: string) => void;
  onPanelMove: (panelId: string, targetPanelId: string) => void;
}

interface ResizeHandleProps {
  axis: "x" | "y";
  style: JSX.CSSProperties;
  onPointerDown: JSX.EventHandlerUnion<HTMLButtonElement, PointerEvent>;
}

interface ReorderProps {
  canReorder: boolean;
  draggingPanelId: string | null;
  dropTargetPanelId: string | null;
  onPanelMove: (panelId: string, targetPanelId: string) => void;
  onReorderDragStart: (panelId: string, event: DragEvent) => void;
  onReorderDragEnd: () => void;
  onReorderTarget: (panelId: string | null) => void;
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

function ResizeHandle(props: ResizeHandleProps) {
  const isVertical = props.axis === "x";

  return (
    <button
      type="button"
      aria-label={isVertical ? "Resize chart columns" : "Resize chart rows"}
      class={`absolute z-20 hidden items-center justify-center bg-transparent transition-colors hover:bg-zinc-800/20 xl:flex ${
        isVertical
          ? "top-0 bottom-0 w-5 -translate-x-1/2 cursor-col-resize"
          : "left-0 right-0 h-5 -translate-y-1/2 cursor-row-resize"
      }`}
      style={props.style}
      onPointerDown={props.onPointerDown}
    >
      <span
        class={`pointer-events-none rounded-full bg-zinc-500/80 shadow-[0_0_0_1px_rgba(24,24,27,0.65)] ${
          isVertical ? "h-16 w-[2px]" : "h-[2px] w-16"
        }`}
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
  canDuplicate: boolean;
  canReorder: boolean;
  expanded: boolean;
  draggingPanelId: string | null;
  dropTargetPanelId: string | null;
  onPanelTitleChange: (panelId: string, title: string) => void;
  onPanelQueryChange: (panelId: string, query: ChartPanelQuery) => void;
  onPanelRemove: (panelId: string) => void;
  onPanelDuplicate: (panelId: string) => void;
  onPanelMove: (panelId: string, targetPanelId: string) => void;
  onToggleExpand: (panelId: string) => void;
  onReorderDragStart: (panelId: string, event: DragEvent) => void;
  onReorderDragEnd: () => void;
  onReorderTarget: (panelId: string | null) => void;
}) {
  const panel = props.panel;

  if (!panel) {
    return null;
  }

  return (
    <div
      class={`h-full min-h-0 min-w-0 rounded-2xl transition ${
        props.dropTargetPanelId === panel.id && props.draggingPanelId !== panel.id
          ? "ring-2 ring-sky-400/70 ring-offset-2 ring-offset-zinc-950"
          : ""
      } ${props.draggingPanelId === panel.id ? "opacity-45" : ""}`}
      onDragEnter={(event) => {
        if (!props.canReorder || !props.draggingPanelId || props.draggingPanelId === panel.id) {
          return;
        }

        event.preventDefault();
        props.onReorderTarget(panel.id);
      }}
      onDragOver={(event) => {
        if (!props.canReorder || !props.draggingPanelId || props.draggingPanelId === panel.id) {
          return;
        }

        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = "move";
        }
        props.onReorderTarget(panel.id);
      }}
      onDrop={(event) => {
        event.preventDefault();
        const sourcePanelId = props.draggingPanelId || event.dataTransfer?.getData("text/plain");

        if (sourcePanelId && sourcePanelId !== panel.id) {
          props.onPanelMove(sourcePanelId, panel.id);
        }

        props.onReorderDragEnd();
      }}
    >
      <ChartPanel
        panel={panel}
        canRemove={props.canRemove}
        canDuplicate={props.canDuplicate}
        canReorder={props.canReorder}
        expanded={props.expanded}
        onTitleChange={(title) => props.onPanelTitleChange(panel.id, title)}
        onQueryChange={(query) => props.onPanelQueryChange(panel.id, query)}
        onRemove={() => props.onPanelRemove(panel.id)}
        onDuplicate={() => props.onPanelDuplicate(panel.id)}
        onToggleExpand={() => props.onToggleExpand(panel.id)}
        onReorderDragStart={(event) => props.onReorderDragStart(panel.id, event)}
        onReorderDragEnd={props.onReorderDragEnd}
      />
    </div>
  );
}

function DesktopRow(props: {
  panels: ChartPanelConfig[];
  columnRatio: number | null;
  canRemove: boolean;
  canDuplicate: boolean;
  onColumnRatioChange: ((ratio: number) => void) | null;
  expandedPanelId: string | null;
  onPanelTitleChange: (panelId: string, title: string) => void;
  onPanelQueryChange: (panelId: string, query: ChartPanelQuery) => void;
  onPanelRemove: (panelId: string) => void;
  onPanelDuplicate: (panelId: string) => void;
  onToggleExpand: (panelId: string) => void;
} & ReorderProps) {
  let container!: HTMLDivElement;
  const rightPanel = () => props.panels[1];

  return (
    <div class="relative h-full min-w-0">
      <div ref={container} class="flex h-full min-w-0 gap-4">
        <div
          class="min-h-0 min-w-0"
          style={{ flex: `${props.columnRatio ?? 1} 1 0%` }}
        >
          <PanelSlot
            panel={props.panels[0]}
            canRemove={props.canRemove}
            canDuplicate={props.canDuplicate}
            canReorder={props.canReorder}
            expanded={props.expandedPanelId === props.panels[0]?.id}
            draggingPanelId={props.draggingPanelId}
            dropTargetPanelId={props.dropTargetPanelId}
            onPanelTitleChange={props.onPanelTitleChange}
            onPanelQueryChange={props.onPanelQueryChange}
            onPanelRemove={props.onPanelRemove}
            onPanelDuplicate={props.onPanelDuplicate}
            onPanelMove={props.onPanelMove}
            onToggleExpand={props.onToggleExpand}
            onReorderDragStart={props.onReorderDragStart}
            onReorderDragEnd={props.onReorderDragEnd}
            onReorderTarget={props.onReorderTarget}
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
              canDuplicate={props.canDuplicate}
              canReorder={props.canReorder}
              expanded={props.expandedPanelId === rightPanel()?.id}
              draggingPanelId={props.draggingPanelId}
              dropTargetPanelId={props.dropTargetPanelId}
              onPanelTitleChange={props.onPanelTitleChange}
              onPanelQueryChange={props.onPanelQueryChange}
              onPanelRemove={props.onPanelRemove}
              onPanelDuplicate={props.onPanelDuplicate}
              onPanelMove={props.onPanelMove}
              onToggleExpand={props.onToggleExpand}
              onReorderDragStart={props.onReorderDragStart}
              onReorderDragEnd={props.onReorderDragEnd}
              onReorderTarget={props.onReorderTarget}
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

function ThreePanelDesktopLayout(props: {
  panels: ChartPanelConfig[];
  layout: SplitWorkspaceLayout | GridWorkspaceLayout;
  onLayoutChange: (layout: SplitWorkspaceLayout | GridWorkspaceLayout) => void;
  onPanelTitleChange: (panelId: string, title: string) => void;
  onPanelQueryChange: (panelId: string, query: ChartPanelQuery) => void;
  onPanelRemove: (panelId: string) => void;
  onPanelDuplicate: (panelId: string) => void;
  onToggleExpand: (panelId: string) => void;
  expandedPanelId: string | null;
} & ReorderProps) {
  let container!: HTMLDivElement;
  let secondaryColumn!: HTMLDivElement;
  const primaryRatio = () => props.layout.columnRatios[0] ?? 0.58;
  const secondaryWeights = () => [props.layout.rowWeights[0] ?? 1, props.layout.rowWeights[1] ?? 1];
  const secondaryOffsets = () => getBoundaryOffsets(secondaryWeights());

  return (
    <div class="relative hidden h-full w-full min-w-0 xl:block">
      <div
        ref={container}
        class="flex h-full min-w-0 gap-4"
      >
        <div class="min-h-0 min-w-0" style={{ flex: `${primaryRatio()} 1 0%` }}>
          <PanelSlot
            panel={props.panels[0]}
            canRemove
            canDuplicate={props.panels.length < 6}
            canReorder={props.canReorder}
            expanded={props.expandedPanelId === props.panels[0]?.id}
            draggingPanelId={props.draggingPanelId}
            dropTargetPanelId={props.dropTargetPanelId}
            onPanelTitleChange={props.onPanelTitleChange}
            onPanelQueryChange={props.onPanelQueryChange}
            onPanelRemove={props.onPanelRemove}
            onPanelDuplicate={props.onPanelDuplicate}
            onPanelMove={props.onPanelMove}
            onToggleExpand={props.onToggleExpand}
            onReorderDragStart={props.onReorderDragStart}
            onReorderDragEnd={props.onReorderDragEnd}
            onReorderTarget={props.onReorderTarget}
          />
        </div>

        <div
          ref={secondaryColumn}
          class="flex min-h-0 min-w-0 flex-col gap-4"
          style={{ flex: `${1 - primaryRatio()} 1 0%` }}
        >
          {props.panels.slice(1).map((panel, index) => (
            <div class="min-h-0" style={{ flex: `${secondaryWeights()[index] ?? 1} 1 0%` }}>
              <PanelSlot
                panel={panel}
                canRemove
                canDuplicate={props.panels.length < 6}
                canReorder={props.canReorder}
                expanded={props.expandedPanelId === panel.id}
                draggingPanelId={props.draggingPanelId}
                dropTargetPanelId={props.dropTargetPanelId}
                onPanelTitleChange={props.onPanelTitleChange}
                onPanelQueryChange={props.onPanelQueryChange}
                onPanelRemove={props.onPanelRemove}
                onPanelDuplicate={props.onPanelDuplicate}
                onPanelMove={props.onPanelMove}
                onToggleExpand={props.onToggleExpand}
                onReorderDragStart={props.onReorderDragStart}
                onReorderDragEnd={props.onReorderDragEnd}
                onReorderTarget={props.onReorderTarget}
              />
            </div>
          ))}
        </div>
      </div>

      <ResizeHandle
        axis="x"
        style={{ left: `${primaryRatio() * 100}%` }}
        onPointerDown={(event) =>
          beginRatioResize(event, container, "x", (ratio) => {
            const columnRatios = [...props.layout.columnRatios];
            columnRatios[0] = ratio;
            props.onLayoutChange({ ...props.layout, columnRatios });
          })
        }
      />

      {secondaryOffsets().map((offset, index) => (
        <ResizeHandle
          axis="y"
          style={{
            top: `${offset * 100}%`,
            left: `${primaryRatio() * 100}%`,
            right: "0",
          }}
          onPointerDown={(event) =>
            beginWeightResize(
              event,
              secondaryColumn,
              "y",
              secondaryWeights(),
              index,
              (rowWeights) => {
                const nextWeights = [...props.layout.rowWeights];
                nextWeights[0] = rowWeights[0] ?? nextWeights[0] ?? 1;
                nextWeights[1] = rowWeights[1] ?? nextWeights[1] ?? 1;
                props.onLayoutChange({ ...props.layout, rowWeights: nextWeights });
              },
            )
          }
        />
      ))}
    </div>
  );
}

function FocusDesktopLayout(props: {
  panels: ChartPanelConfig[];
  layout: FocusWorkspaceLayout;
  onLayoutChange: (layout: FocusWorkspaceLayout) => void;
  onPanelTitleChange: (panelId: string, title: string) => void;
  onPanelQueryChange: (panelId: string, query: ChartPanelQuery) => void;
  onPanelRemove: (panelId: string) => void;
  onPanelDuplicate: (panelId: string) => void;
  onToggleExpand: (panelId: string) => void;
  expandedPanelId: string | null;
} & ReorderProps) {
  let container!: HTMLDivElement;
  const rowOffsets = getBoundaryOffsets(props.layout.rowWeights);

  return (
    <div class="relative hidden h-full w-full min-w-0 xl:block">
      <div
        ref={container}
        class="flex h-full min-w-0 flex-col gap-4"
      >
        {props.panels.map((panel, index) => (
          <div class="min-h-0" style={{ flex: `${props.layout.rowWeights[index] ?? 1} 1 0%` }}>
            <PanelSlot
              panel={panel}
              canRemove={props.panels.length > 1}
              canDuplicate={props.panels.length < 6}
              canReorder={props.canReorder}
              expanded={props.expandedPanelId === panel.id}
              draggingPanelId={props.draggingPanelId}
              dropTargetPanelId={props.dropTargetPanelId}
              onPanelTitleChange={props.onPanelTitleChange}
              onPanelQueryChange={props.onPanelQueryChange}
              onPanelRemove={props.onPanelRemove}
              onPanelDuplicate={props.onPanelDuplicate}
              onPanelMove={props.onPanelMove}
              onToggleExpand={props.onToggleExpand}
              onReorderDragStart={props.onReorderDragStart}
              onReorderDragEnd={props.onReorderDragEnd}
              onReorderTarget={props.onReorderTarget}
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
  onPanelTitleChange: (panelId: string, title: string) => void;
  onPanelQueryChange: (panelId: string, query: ChartPanelQuery) => void;
  onPanelRemove: (panelId: string) => void;
  onPanelDuplicate: (panelId: string) => void;
  onToggleExpand: (panelId: string) => void;
  expandedPanelId: string | null;
} & ReorderProps) {
  let container!: HTMLDivElement;
  const rows = chunkPanels(props.panels, getWorkspaceColumnCount(props.preset, props.panels.length));
  const rowOffsets = getBoundaryOffsets(props.layout.rowWeights);

  return (
    <div class="relative hidden h-full w-full min-w-0 xl:block">
      <div
        ref={container}
        class="flex h-full min-w-0 flex-col gap-4"
      >
        {rows.map((row, index) => (
          <div class="min-h-0" style={{ flex: `${props.layout.rowWeights[index] ?? 1} 1 0%` }}>
            <DesktopRow
              panels={row}
              columnRatio={row.length > 1 ? props.layout.columnRatios[index] ?? 0.5 : null}
              canRemove={props.panels.length > 1}
              canDuplicate={props.panels.length < 6}
              canReorder={props.canReorder}
              draggingPanelId={props.draggingPanelId}
              dropTargetPanelId={props.dropTargetPanelId}
              expandedPanelId={props.expandedPanelId}
              onPanelMove={props.onPanelMove}
              onReorderDragStart={props.onReorderDragStart}
              onReorderDragEnd={props.onReorderDragEnd}
              onReorderTarget={props.onReorderTarget}
              onColumnRatioChange={
                row.length > 1
                  ? (ratio) => {
                      const columnRatios = [...props.layout.columnRatios];
                      columnRatios[index] = ratio;
                      props.onLayoutChange({ ...props.layout, columnRatios });
                    }
                  : null
              }
              onPanelTitleChange={props.onPanelTitleChange}
              onPanelQueryChange={props.onPanelQueryChange}
              onPanelRemove={props.onPanelRemove}
              onPanelDuplicate={props.onPanelDuplicate}
              onToggleExpand={props.onToggleExpand}
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
  const [expandedPanelId, setExpandedPanelId] = createSignal<string | null>(null);
  const [draggingPanelId, setDraggingPanelId] = createSignal<string | null>(null);
  const [dropTargetPanelId, setDropTargetPanelId] = createSignal<string | null>(null);
  const expandedPanel = () => props.panels.find((panel) => panel.id === expandedPanelId()) ?? null;
  const canDuplicate = () => props.panels.length < 6;
  const canReorder = () => props.panels.length > 1 && !expandedPanel();

  createEffect(() => {
    if (expandedPanelId() && !props.panels.some((panel) => panel.id === expandedPanelId())) {
      setExpandedPanelId(null);
    }
  });

  const toggleExpand = (panelId: string) => {
    setExpandedPanelId((current) => (current === panelId ? null : panelId));
  };

  const startReorder = (panelId: string, event: DragEvent) => {
    if (!canReorder() || !event.dataTransfer) {
      event.preventDefault();
      return;
    }

    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", panelId);
    setDraggingPanelId(panelId);
  };

  const endReorder = () => {
    setDraggingPanelId(null);
    setDropTargetPanelId(null);
  };

  return (
    <>
      {expandedPanel() ? (
        <div class="mb-4 rounded-2xl border border-zinc-700/80 bg-zinc-950/55 p-2">
          <PanelSlot
            panel={expandedPanel()!}
            canRemove={props.panels.length > 1}
            canDuplicate={canDuplicate()}
            canReorder={false}
            expanded
            draggingPanelId={draggingPanelId()}
            dropTargetPanelId={dropTargetPanelId()}
            onPanelTitleChange={props.onPanelTitleChange}
            onPanelQueryChange={props.onPanelQueryChange}
            onPanelRemove={props.onPanelRemove}
            onPanelDuplicate={props.onPanelDuplicate}
            onPanelMove={props.onPanelMove}
            onToggleExpand={toggleExpand}
            onReorderDragStart={startReorder}
            onReorderDragEnd={endReorder}
            onReorderTarget={setDropTargetPanelId}
          />
        </div>
      ) : null}

      {expandedPanel() ? null : (
        <div class="grid gap-4 xl:hidden">
          {props.panels.map((panel) => (
            <PanelSlot
              panel={panel}
              canRemove={props.panels.length > 1}
              canDuplicate={canDuplicate()}
              canReorder={canReorder()}
              expanded={expandedPanelId() === panel.id}
              draggingPanelId={draggingPanelId()}
              dropTargetPanelId={dropTargetPanelId()}
              onPanelTitleChange={props.onPanelTitleChange}
              onPanelQueryChange={props.onPanelQueryChange}
              onPanelRemove={props.onPanelRemove}
              onPanelDuplicate={props.onPanelDuplicate}
              onPanelMove={props.onPanelMove}
              onToggleExpand={toggleExpand}
              onReorderDragStart={startReorder}
              onReorderDragEnd={endReorder}
              onReorderTarget={setDropTargetPanelId}
            />
          ))}
        </div>
      )}

      {props.layout.kind === "focus" && !expandedPanel() ? (
        <FocusDesktopLayout
          panels={props.panels}
          layout={props.layout}
          onLayoutChange={props.onLayoutChange}
          onPanelTitleChange={props.onPanelTitleChange}
          onPanelQueryChange={props.onPanelQueryChange}
          onPanelRemove={props.onPanelRemove}
          onPanelDuplicate={props.onPanelDuplicate}
          onPanelMove={props.onPanelMove}
          onToggleExpand={toggleExpand}
          expandedPanelId={expandedPanelId()}
          canReorder={canReorder()}
          draggingPanelId={draggingPanelId()}
          dropTargetPanelId={dropTargetPanelId()}
          onReorderDragStart={startReorder}
          onReorderDragEnd={endReorder}
          onReorderTarget={setDropTargetPanelId}
        />
      ) : null}

      {(props.layout.kind === "split" || props.layout.kind === "grid") && props.panels.length === 3 && !expandedPanel() ? (
        <ThreePanelDesktopLayout
          panels={props.panels}
          layout={props.layout}
          onLayoutChange={props.onLayoutChange}
          onPanelTitleChange={props.onPanelTitleChange}
          onPanelQueryChange={props.onPanelQueryChange}
          onPanelRemove={props.onPanelRemove}
          onPanelDuplicate={props.onPanelDuplicate}
          onPanelMove={props.onPanelMove}
          onToggleExpand={toggleExpand}
          expandedPanelId={expandedPanelId()}
          canReorder={canReorder()}
          draggingPanelId={draggingPanelId()}
          dropTargetPanelId={dropTargetPanelId()}
          onReorderDragStart={startReorder}
          onReorderDragEnd={endReorder}
          onReorderTarget={setDropTargetPanelId}
        />
      ) : null}

      {props.layout.kind === "split" || props.layout.kind === "grid" ? (
        props.panels.length === 3 ? null : (
          expandedPanel() ? null : (
            <TiledDesktopLayout
              preset={props.layout.kind}
              panels={props.panels}
              layout={props.layout}
              onLayoutChange={props.onLayoutChange}
              onPanelTitleChange={props.onPanelTitleChange}
              onPanelQueryChange={props.onPanelQueryChange}
              onPanelRemove={props.onPanelRemove}
              onPanelDuplicate={props.onPanelDuplicate}
              onPanelMove={props.onPanelMove}
              onToggleExpand={toggleExpand}
              expandedPanelId={expandedPanelId()}
              canReorder={canReorder()}
              draggingPanelId={draggingPanelId()}
              dropTargetPanelId={dropTargetPanelId()}
              onReorderDragStart={startReorder}
              onReorderDragEnd={endReorder}
              onReorderTarget={setDropTargetPanelId}
            />
          )
        )
      ) : null}
    </>
  );
}
