import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import ChartPanel from "./ChartPanel";
import {
  clampWorkspaceRatio,
  getWorkspaceColumnCount,
  type ChartPanelConfig,
  type ChartPanelQuery,
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

export default function WorkspaceGrid(props: Props) {
  let container!: HTMLDivElement;
  let stopResize: (() => void) | undefined;
  const [expandedId, setExpandedId] = createSignal<string | null>(null);
  const [draggingId, setDraggingId] = createSignal<string | null>(null);
  const [dropId, setDropId] = createSignal<string | null>(null);
  // Key by persistent ID: resizing, editing settings and reordering must not
  // recreate canvases, refetch candles, or discard a trader's zoom position.
  const ids = createMemo(() => props.panels.map((panel) => panel.id));
  const expanded = () => ids().includes(expandedId() ?? "") ? expandedId() : null;
  const columns = () => getWorkspaceColumnCount(props.preset, props.panels.length);
  const threePanel = () => columns() === 2 && props.panels.length === 3;
  const rows = () => Math.ceil(props.panels.length / columns());
  const boundaries = createMemo(() => Array.from({ length: Math.max(0, rows() - 1) }, (_, index) => index));
  const columnRatio = () => props.layout.kind === "focus" ? 1 : props.layout.columnRatios[0] ?? 0.5;
  const weights = () => Array.from({ length: rows() }, (_, index) => props.layout.rowWeights[index] ?? 1);
  const offsets = () => {
    const values = weights();
    const total = values.reduce((sum, value) => sum + value, 0);
    return values.slice(0, -1).map((_, index) => values.slice(0, index + 1).reduce((sum, value) => sum + value, 0) / total);
  };
  const changeColumn = (ratio: number) => {
    const layout = props.layout;
    if (layout.kind === "focus") return;
    // A shared divider keeps every row aligned in the four/six chart grid.
    props.onLayoutChange({ ...layout, columnRatios: layout.columnRatios.map(() => clampWorkspaceRatio(ratio)) });
  };
  const changeRow = (index: number, ratio: number) => {
    const values = weights();
    const pair = values[index] + values[index + 1];
    values[index] = pair * clampWorkspaceRatio(ratio);
    values[index + 1] = pair - values[index];
    props.onLayoutChange({ ...props.layout, rowWeights: values });
  };
  const beginResize = (event: PointerEvent, axis: "x" | "y", index = 0) => {
    event.preventDefault();
    stopResize?.();
    const rect = container.getBoundingClientRect();
    const initial = weights();
    const total = initial.reduce((sum, value) => sum + value, 0);
    const before = initial.slice(0, index).reduce((sum, value) => sum + value, 0) / total;
    const pair = (initial[index] + (initial[index + 1] ?? 0)) / total;
    let frame = 0;
    let pending: PointerEvent | undefined;
    const flush = () => {
      if (!pending) return;
      if (axis === "x") changeColumn((pending.clientX - rect.left) / rect.width);
      else changeRow(index, ((pending.clientY - rect.top) / rect.height - before) / pair);
      pending = undefined;
    };
    const move = (next: PointerEvent) => {
      pending = next;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(flush);
    };
    stopResize = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    const finish = () => { flush(); stopResize?.(); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };
  const keyResize = (event: KeyboardEvent, axis: "x" | "y", index = 0) => {
    const direction = axis === "x" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    if (!direction.includes(event.key) && event.key !== "Home") return;
    event.preventDefault();
    const current = axis === "x" ? columnRatio() : weights()[index] / (weights()[index] + weights()[index + 1]);
    const ratio = event.key === "Home" ? 0.5 : current + (event.key === direction[0] ? -0.05 : 0.05);
    if (axis === "x") changeColumn(ratio); else changeRow(index, ratio);
  };
  onCleanup(() => stopResize?.());

  return (
    <div ref={container} onKeyDown={(event) => { if (event.key === "Escape" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLSelectElement)) setExpandedId(null); }} class="workspace-grid" classList={{ "is-expanded": !!expanded() }}
      style={{
        "--workspace-columns": columns() === 1 ? "minmax(0, 1fr)" : `minmax(0, ${columnRatio()}fr) minmax(0, ${1 - columnRatio()}fr)`,
        "--workspace-rows": weights().map((weight) => `minmax(0, ${weight}fr)`).join(" "),
        "--workspace-min-height": `${rows() * 230}px`,
      }}>
      <For each={ids()}>{(id, index) => {
        const panel = () => props.panels.find((item) => item.id === id)!;
        return (
          <div class="workspace-slot" classList={{ "is-hidden": !!expanded() && expanded() !== id, "is-dragging": draggingId() === id, "is-drop-target": dropId() === id }}
            style={{ "--panel-row": threePanel() && index() === 0 ? "1 / span 2" : "auto" }}
            onDragOver={(event) => { if (draggingId() && draggingId() !== id) { event.preventDefault(); setDropId(id); } }}
            onDrop={(event) => { event.preventDefault(); if (draggingId() && draggingId() !== id) props.onPanelMove(draggingId()!, id); setDraggingId(null); setDropId(null); }}>
            <ChartPanel panel={panel()} canRemove={props.panels.length > 1} canDuplicate={props.panels.length < 6}
              canReorder={props.panels.length > 1 && !expanded()} expanded={expanded() === id}
              onTitleChange={(title) => props.onPanelTitleChange(id, title)}
              onQueryChange={(query) => props.onPanelQueryChange(id, query)}
              onRemove={() => props.onPanelRemove(id)} onDuplicate={() => props.onPanelDuplicate(id)}
              onToggleExpand={() => setExpandedId(expanded() === id ? null : id)}
              onReorderDragStart={(event) => { if (event.dataTransfer) { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", id); setDraggingId(id); } }}
              onReorderDragEnd={() => { setDraggingId(null); setDropId(null); }} />
          </div>
        );
      }}</For>
      <Show when={!expanded()}>
        <Show when={columns() > 1}>
          <button type="button" class="workspace-divider workspace-divider-x" aria-label="Resize chart columns" title="Drag or use arrow keys. Home resets the divider."
            style={{ left: `${columnRatio() * 100}%` }} onPointerDown={(event) => beginResize(event, "x")}
            onKeyDown={(event) => keyResize(event, "x")} onDblClick={() => changeColumn(0.5)} />
        </Show>
        <For each={boundaries()}>{(index) => <button type="button" class="workspace-divider workspace-divider-y"
          aria-label={`Resize chart row ${index + 1}`} title="Drag or use arrow keys. Home resets the divider."
          style={{ top: `${offsets()[index] * 100}%`, left: threePanel() ? `${columnRatio() * 100}%` : "0" }}
          onPointerDown={(event) => beginResize(event, "y", index)} onKeyDown={(event) => keyResize(event, "y", index)}
          onDblClick={() => changeRow(index, 0.5)} />}</For>
      </Show>
    </div>
  );
}
