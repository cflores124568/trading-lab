import type { JSX } from "solid-js";
import ChartPanel from "./ChartPanel";
import {
  clampWorkspaceRatio,
  type ChartPanelConfig,
  type ChartPanelQuery,
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
}

interface ResizeHandleProps {
  axis: "x" | "y";
  style: JSX.CSSProperties;
  onPointerDown: JSX.EventHandlerUnion<HTMLButtonElement, PointerEvent>;
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

function beginResize(
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

function PanelSlot(props: {
  panel: ChartPanelConfig | undefined;
  onPanelQueryChange: (panelId: string, query: ChartPanelQuery) => void;
}) {
  const panel = props.panel;

  if (!panel) {
    return null;
  }

  return (
    <div class="min-h-0 min-w-0">
      <ChartPanel
        panel={panel}
        onQueryChange={(query) => props.onPanelQueryChange(panel.id, query)}
      />
    </div>
  );
}

function SplitDesktopLayout(props: {
  panels: ChartPanelConfig[];
  layout: SplitWorkspaceLayout;
  onLayoutChange: (layout: SplitWorkspaceLayout) => void;
  onPanelQueryChange: (panelId: string, query: ChartPanelQuery) => void;
}) {
  let container!: HTMLDivElement;

  return (
    <div class="relative hidden xl:block">
      <div ref={container} class="flex min-h-[720px] gap-4">
        <div class="min-h-0 min-w-0" style={{ flex: `${props.layout.ratio} 1 0%` }}>
          <PanelSlot panel={props.panels[0]} onPanelQueryChange={props.onPanelQueryChange} />
        </div>

        <div class="min-h-0 min-w-0" style={{ flex: `${1 - props.layout.ratio} 1 0%` }}>
          <PanelSlot panel={props.panels[1]} onPanelQueryChange={props.onPanelQueryChange} />
        </div>
      </div>

      <ResizeHandle
        axis="x"
        style={{ left: `${props.layout.ratio * 100}%` }}
        onPointerDown={(event) =>
          beginResize(event, container, "x", (ratio) =>
            props.onLayoutChange({ ...props.layout, ratio }),
          )
        }
      />
    </div>
  );
}

function GridRow(props: {
  panels: [ChartPanelConfig | undefined, ChartPanelConfig | undefined];
  ratio: number;
  onRatioChange: (ratio: number) => void;
  onPanelQueryChange: (panelId: string, query: ChartPanelQuery) => void;
}) {
  let container!: HTMLDivElement;

  return (
    <div class="relative h-full">
      <div ref={container} class="flex h-full gap-4">
        <div class="min-h-0 min-w-0" style={{ flex: `${props.ratio} 1 0%` }}>
          <PanelSlot panel={props.panels[0]} onPanelQueryChange={props.onPanelQueryChange} />
        </div>

        <div class="min-h-0 min-w-0" style={{ flex: `${1 - props.ratio} 1 0%` }}>
          <PanelSlot panel={props.panels[1]} onPanelQueryChange={props.onPanelQueryChange} />
        </div>
      </div>

      <ResizeHandle
        axis="x"
        style={{ left: `${props.ratio * 100}%` }}
        onPointerDown={(event) => beginResize(event, container, "x", props.onRatioChange)}
      />
    </div>
  );
}

function GridDesktopLayout(props: {
  panels: ChartPanelConfig[];
  layout: GridWorkspaceLayout;
  onLayoutChange: (layout: GridWorkspaceLayout) => void;
  onPanelQueryChange: (panelId: string, query: ChartPanelQuery) => void;
}) {
  let container!: HTMLDivElement;

  return (
    <div class="relative hidden xl:block">
      <div ref={container} class="flex min-h-[980px] flex-col gap-4">
        <div class="min-h-0" style={{ flex: `${props.layout.rowRatio} 1 0%` }}>
          <GridRow
            panels={[props.panels[0], props.panels[1]]}
            ratio={props.layout.topRatio}
            onRatioChange={(ratio) => props.onLayoutChange({ ...props.layout, topRatio: ratio })}
            onPanelQueryChange={props.onPanelQueryChange}
          />
        </div>

        <div class="min-h-0" style={{ flex: `${1 - props.layout.rowRatio} 1 0%` }}>
          <GridRow
            panels={[props.panels[2], props.panels[3]]}
            ratio={props.layout.bottomRatio}
            onRatioChange={(ratio) => props.onLayoutChange({ ...props.layout, bottomRatio: ratio })}
            onPanelQueryChange={props.onPanelQueryChange}
          />
        </div>
      </div>

      <ResizeHandle
        axis="y"
        style={{ top: `${props.layout.rowRatio * 100}%` }}
        onPointerDown={(event) =>
          beginResize(event, container, "y", (ratio) =>
            props.onLayoutChange({ ...props.layout, rowRatio: ratio }),
          )
        }
      />
    </div>
  );
}

export default function WorkspaceGrid(props: Props) {
  return (
    <>
      <div class={props.preset === "focus" ? "grid gap-4" : "grid gap-4 xl:hidden"}>
        {props.panels.map((panel) => (
          <PanelSlot panel={panel} onPanelQueryChange={props.onPanelQueryChange} />
        ))}
      </div>

      {props.layout.kind === "split" ? (
        <SplitDesktopLayout
          panels={props.panels}
          layout={props.layout}
          onLayoutChange={props.onLayoutChange}
          onPanelQueryChange={props.onPanelQueryChange}
        />
      ) : null}

      {props.layout.kind === "grid" ? (
        <GridDesktopLayout
          panels={props.panels}
          layout={props.layout}
          onLayoutChange={props.onLayoutChange}
          onPanelQueryChange={props.onPanelQueryChange}
        />
      ) : null}
    </>
  );
}
