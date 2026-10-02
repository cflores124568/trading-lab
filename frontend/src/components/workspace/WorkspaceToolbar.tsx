import { createEffect, createSignal } from "solid-js";
import { CopyPlus, Plus, Star, Trash2, SlidersHorizontal } from "lucide-solid";
import {
  MAX_WORKSPACE_NAME_LENGTH,
  normalizeWorkspaceName,
  type WorkspacePreset,
  type WorkspacePresetOption,
} from "./chartPanelTypes";

interface WorkspaceOption {
  id: string;
  name: string;
}

interface Props {
  workspaceId: string;
  defaultWorkspaceId: string;
  workspaceName: string;
  workspaceCount: number;
  workspaces: WorkspaceOption[];
  preset: WorkspacePreset;
  options: WorkspacePresetOption[];
  panelCount: number;
  canAddChart: boolean;
  canDeleteWorkspace: boolean;
  onWorkspaceChange: (workspaceId: string) => void;
  onDefaultWorkspaceChange: (workspaceId: string) => void;
  onWorkspaceNameChange: (name: string) => void;
  onCreateWorkspace: () => void;
  onDeleteWorkspace: () => void;
  onPresetChange: (preset: WorkspacePreset) => void;
  onAddChart: () => void;
}

const field =
  "w-full rounded-lg border border-stone-700 bg-stone-800 px-3 py-2 text-sm text-stone-100 " +
  "focus:outline-none focus:ring-1 focus:ring-stone-500";

function LayoutPreview(props: { preset: WorkspacePreset }) {
  if (props.preset === "focus") {
    return (
      <div class="grid h-4 w-5 grid-cols-1 gap-0.5">
        <span class="rounded bg-current" />
      </div>
    );
  }

  if (props.preset === "split") {
    return (
      <div class="grid h-4 w-5 grid-cols-2 gap-0.5">
        <span class="rounded bg-current" />
        <span class="rounded bg-current" />
      </div>
    );
  }

  return (
    <div class="grid h-4 w-5 grid-cols-2 gap-0.5">
      <span class="rounded bg-current" />
      <span class="rounded bg-current" />
      <span class="rounded bg-current" />
      <span class="rounded bg-current" />
    </div>
  );
}

export default function WorkspaceToolbar(props: Props) {
  const [nameDraft, setNameDraft] = createSignal(props.workspaceName);

  createEffect(() => {
    setNameDraft(props.workspaceName);
  });

  const commitWorkspaceName = () => {
    const nextName = normalizeWorkspaceName(nameDraft(), props.workspaceName);
    setNameDraft(nextName);
    props.onWorkspaceNameChange(nextName);
  };

  return (
    <div class="workspace-toolbar">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex min-w-0 flex-wrap items-center gap-3">
          <label class="flex items-center gap-2 text-xs text-stone-400">
            <span>Workspace</span>
            <select class="app-input max-w-48 text-sm" value={props.workspaceId}
              onChange={(event) => props.onWorkspaceChange(event.currentTarget.value)}>
              {props.workspaces.map((workspace) => <option value={workspace.id}>{workspace.name}</option>)}
            </select>
          </label>
          <div class="flex gap-1" role="group" aria-label="Chart layout">
            {props.options.map((option) => (
              <button type="button" aria-pressed={props.preset === option.value}
                class={`workspace-layout-button ${props.preset === option.value ? "is-active" : ""}`}
                title={option.description} onClick={() => props.onPresetChange(option.value)}>
                <LayoutPreview preset={option.value} /><span>{option.label}</span>
              </button>
            ))}
          </div>
        </div>
        <div class="flex items-center gap-2">
          <span class="hidden text-xs text-stone-400 sm:block">{props.panelCount} charts · Auto-saved</span>
          <button type="button" class="app-button-compact-secondary gap-1.5" onClick={props.onAddChart} disabled={!props.canAddChart}>
            <Plus size={14} /> Add chart
          </button>
        </div>
      </div>
      <details class="workspace-settings">
        <summary class="inline-flex items-center gap-1.5 py-2 text-xs text-stone-400"><SlidersHorizontal size={13} /> Manage workspace</summary>
        <div class="flex flex-wrap items-end gap-3 border-t border-white/10 pt-3 pb-2">
          <label class="min-w-0 flex-1 text-xs text-stone-400">Workspace name
            <input class={field} value={nameDraft()} maxLength={MAX_WORKSPACE_NAME_LENGTH}
              onInput={(event) => setNameDraft(event.currentTarget.value)} onBlur={commitWorkspaceName}
              onKeyDown={(event) => {
                if (event.key === "Enter") { commitWorkspaceName(); event.currentTarget.blur(); }
                if (event.key === "Escape") { setNameDraft(props.workspaceName); event.currentTarget.blur(); }
              }} />
          </label>
          <button class="app-button-secondary gap-2" onClick={props.onCreateWorkspace}><CopyPlus size={15} /> Save as new</button>
          <button class="app-button-secondary gap-2" disabled={props.workspaceId === props.defaultWorkspaceId}
            onClick={() => props.onDefaultWorkspaceChange(props.workspaceId)}><Star size={15} />
            {props.workspaceId === props.defaultWorkspaceId ? "Default workspace" : "Set as default"}
          </button>
          {props.canDeleteWorkspace && <button class="app-button-secondary gap-2" onClick={props.onDeleteWorkspace}><Trash2 size={15} /> Delete workspace</button>}
        </div>
      </details>
    </div>
  );
}
