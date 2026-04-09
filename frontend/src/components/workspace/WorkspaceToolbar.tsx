import { createEffect, createSignal } from "solid-js";
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
    <div class="space-y-4">
      <div class="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(360px,1fr)] xl:items-end">
        <div class="space-y-2">
          <p class="app-kicker">Saved Workspaces</p>
          <h2 class="text-lg font-semibold text-zinc-100">Keep a few real workspaces, not one disposable layout</h2>
          <p class="max-w-3xl text-sm text-zinc-400">
            Every workspace still starts from the preset model, but now you can fork the current setup,
            give it a real name, and bounce between different trading contexts without losing your
            panel mix or resize work.
          </p>
        </div>

        <div class="app-subpanel space-y-4 p-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="text-sm font-semibold text-zinc-100">Workspace controls</p>
              <p class="text-xs text-zinc-400">Auto-saves as you tweak charts and dividers.</p>
            </div>
            <div class="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-medium uppercase tracking-[0.16em] text-zinc-400">
              {props.workspaceCount} {props.workspaceCount === 1 ? "Workspace" : "Workspaces"}
            </div>
          </div>

          <div class="grid gap-3 md:grid-cols-3">
            <label class="space-y-1">
              <span class="block text-xs text-zinc-400">Saved workspace</span>
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
              <span class="block text-xs text-zinc-400">Workspace name</span>
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
              <span class="block text-xs text-zinc-400">Default open target</span>
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
          </div>

          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-medium uppercase tracking-[0.16em] text-zinc-400">
              {props.panelCount} {props.panelCount === 1 ? "Panel" : "Panels"}
            </div>

            <div class="flex flex-wrap items-center gap-2">
              <button
                type="button"
                class="rounded-xl border border-zinc-600 px-4 py-2 text-sm font-semibold text-zinc-100 transition-colors hover:border-zinc-400 hover:bg-zinc-900"
                onClick={props.onCreateWorkspace}
              >
                Save as New Workspace
              </button>
              <button
                type="button"
                class="rounded-xl border border-zinc-800 px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:border-zinc-600 hover:bg-zinc-900 hover:text-zinc-100 disabled:cursor-not-allowed disabled:border-zinc-900 disabled:text-zinc-700"
                onClick={props.onDeleteWorkspace}
                disabled={!props.canDeleteWorkspace}
              >
                Delete Workspace
              </button>
              <button
                type="button"
                class="rounded-xl border border-zinc-600 px-4 py-2 text-sm font-semibold text-zinc-100 transition-colors hover:border-zinc-400 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-600"
                onClick={props.onAddChart}
                disabled={!props.canAddChart}
              >
                + Add Chart
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="grid gap-3 md:grid-cols-3">
        {props.options.map((option) => {
          const active = props.preset === option.value;
          return (
            <button
              type="button"
              class={`app-subpanel p-4 text-left transition-colors ${
                active
                  ? "border-zinc-500 bg-zinc-900"
                  : "hover:border-zinc-600 hover:bg-zinc-900/80"
              }`}
              onClick={() => props.onPresetChange(option.value)}
            >
              <div class="flex items-center justify-between gap-3">
                <p class="text-sm font-semibold text-zinc-100">{option.label}</p>
                <span
                  class={`rounded-full px-2 py-1 text-[11px] font-medium uppercase tracking-[0.16em] ${
                    active ? "bg-zinc-100 text-zinc-950" : "bg-zinc-800 text-zinc-400"
                  }`}
                >
                  {active ? "Active" : "Preset"}
                </span>
              </div>
              <p class="mt-2 text-sm text-zinc-400">{option.description}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
