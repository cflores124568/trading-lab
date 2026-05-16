import { A } from "@solidjs/router";
import { createEffect, createMemo, createSignal } from "solid-js";
import {
  buildWorkspaceLaunchHref,
  loadWorkspaceCollectionState,
  resolveWorkspaceId,
  type WorkspaceLaunchIntent,
} from "./workspacePersistence";

interface Props {
  intent: WorkspaceLaunchIntent;
  compact?: boolean;
  buttonLabel?: string;
}

export default function WorkspaceLaunchControl(props: Props) {
  const initialState = loadWorkspaceCollectionState();
  const [workspaceOptions, setWorkspaceOptions] = createSignal(
    initialState.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
    })),
  );
  const [workspaceId, setWorkspaceId] = createSignal(
    resolveWorkspaceId(initialState, props.intent.workspaceId),
  );

  createEffect(() => {
    const nextState = loadWorkspaceCollectionState();
    setWorkspaceOptions(
      nextState.workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
      })),
    );
    setWorkspaceId((current) =>
      nextState.workspaces.some((workspace) => workspace.id === current)
        ? current
        : resolveWorkspaceId(nextState, props.intent.workspaceId),
    );
  });

  const href = createMemo(() => buildWorkspaceLaunchHref(props.intent, workspaceId()));

  if (props.compact) {
    return (
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
        <select
          class="app-input min-w-[180px] text-xs"
          value={workspaceId()}
          onChange={(event) => setWorkspaceId(event.currentTarget.value)}
        >
          {workspaceOptions().map((workspace) => (
            <option value={workspace.id}>{workspace.name}</option>
          ))}
        </select>
        <A
          href={href()}
          class="app-button-compact-secondary text-center"
        >
          {props.buttonLabel ?? "Open in Workspace"}
        </A>
      </div>
    );
  }

  return (
    <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
      <label class="space-y-1">
        <span class="block text-xs text-stone-400">Workspace target</span>
        <select
          class="app-input min-w-[220px] text-sm"
          value={workspaceId()}
          onChange={(event) => setWorkspaceId(event.currentTarget.value)}
        >
          {workspaceOptions().map((workspace) => (
            <option value={workspace.id}>{workspace.name}</option>
          ))}
        </select>
      </label>
      <A
        href={href()}
        class="app-button-secondary"
      >
        {props.buttonLabel ?? "Open in Workspace"}
      </A>
    </div>
  );
}
