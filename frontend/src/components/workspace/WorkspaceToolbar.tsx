import { createEffect, createSignal } from "solid-js";
import { CopyPlus, LayoutGrid, PanelRight, Plus, Trash2 } from "lucide-solid";
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
  showUtilityRail: boolean;
  onWorkspaceChange: (workspaceId: string) => void;
  onDefaultWorkspaceChange: (workspaceId: string) => void;
  onWorkspaceNameChange: (name: string) => void;
  onCreateWorkspace: () => void;
  onDeleteWorkspace: () => void;
  onPresetChange: (preset: WorkspacePreset) => void;
  onAddChart: () => void;
  onToggleUtilityRail: () => void;
}

const field =
  "w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 " +
  "focus:outline-none focus:ring-1 focus:ring-zinc-500";

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
    <div class="border-b border-zinc-800 bg-zinc-950/60 px-4 py-3 lg:px-5">
      <div class="flex flex-col gap-3">
        <div class="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div class="flex flex-wrap items-center gap-3">
            <div class="min-w-0">
              <p class="app-kicker">Workspace</p>
              <p class="truncate text-sm font-semibold text-zinc-100">{props.workspaceName}</p>
            </div>
            <div class="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-400">
              {props.workspaceCount} {props.workspaceCount === 1 ? "Workspace" : "Workspaces"}
            </div>
            <div class="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-400">
              {props.panelCount} {props.panelCount === 1 ? "Panel" : "Panels"}
            </div>
            <p class="text-xs text-zinc-500">Auto-saves as you move charts around.</p>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="inline-flex items-center gap-2 rounded-xl border border-zinc-600 px-3 py-2 text-sm font-semibold text-zinc-100 transition-colors hover:border-zinc-400 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-600"
              onClick={props.onAddChart}
              disabled={!props.canAddChart}
            >
              <Plus size={15} />
              Add Chart
            </button>
            <button
              type="button"
              class="inline-flex items-center gap-2 rounded-xl border border-zinc-600 px-3 py-2 text-sm font-semibold text-zinc-100 transition-colors hover:border-zinc-400 hover:bg-zinc-900"
              onClick={props.onCreateWorkspace}
            >
              <CopyPlus size={15} />
              Save as New
            </button>
            <button
              type="button"
              class="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-900 hover:text-zinc-100"
              onClick={props.onToggleUtilityRail}
            >
              <PanelRight size={15} />
              {props.showUtilityRail ? "Hide Rail" : "Show Rail"}
            </button>
            <button
              type="button"
              class="inline-flex items-center gap-2 rounded-xl border border-zinc-800 px-3 py-2 text-sm font-medium text-zinc-400 transition-colors hover:border-zinc-600 hover:bg-zinc-900 hover:text-zinc-100 disabled:cursor-not-allowed disabled:border-zinc-900 disabled:text-zinc-700"
              onClick={props.onDeleteWorkspace}
              disabled={!props.canDeleteWorkspace}
            >
              <Trash2 size={15} />
              Delete
            </button>
          </div>
        </div>

        <div class="grid gap-3 xl:grid-cols-[minmax(220px,0.9fr)_minmax(220px,0.9fr)_minmax(220px,0.9fr)_auto]">
          <label class="space-y-1">
            <span class="block text-xs text-zinc-500">Saved workspace</span>
            <select
              class={field}
              value={props.workspaceId}
              onChange={(event) => props.onWorkspaceChange(event.currentTarget.value)}
            >
              {props.workspaces.map((workspace) => (
                <option value={workspace.id}>{workspace.name}</option>
              ))}
            </select>
          </label>

          <label class="space-y-1">
            <span class="block text-xs text-zinc-500">Workspace name</span>
            <input
              type="text"
              class={field}
              value={nameDraft()}
              maxLength={MAX_WORKSPACE_NAME_LENGTH}
              placeholder="Replay review workspace"
              onInput={(event) => setNameDraft(event.currentTarget.value)}
              onBlur={commitWorkspaceName}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commitWorkspaceName();
                  event.currentTarget.blur();
                }

                if (event.key === "Escape") {
                  setNameDraft(props.workspaceName);
                  event.currentTarget.blur();
                }
              }}
            />
          </label>

          <label class="space-y-1">
            <span class="block text-xs text-zinc-500">Default open target</span>
            <select
              class={field}
              value={props.defaultWorkspaceId}
              onChange={(event) => props.onDefaultWorkspaceChange(event.currentTarget.value)}
            >
              {props.workspaces.map((workspace) => (
                <option value={workspace.id}>{workspace.name}</option>
              ))}
            </select>
          </label>

          <div class="space-y-1">
            <span class="block text-xs text-zinc-500">Layout</span>
            <div class="flex h-full flex-wrap gap-2 rounded-xl border border-zinc-800 bg-zinc-950/70 p-2">
              {props.options.map((option) => {
                const active = props.preset === option.value;
                return (
                  <button
                    type="button"
                    class={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium uppercase tracking-[0.16em] transition-colors ${
                      active
                        ? "bg-zinc-100 text-zinc-950"
                        : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                    }`}
                    title={option.description}
                    onClick={() => props.onPresetChange(option.value)}
                  >
                    <LayoutGrid size={14} />
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
