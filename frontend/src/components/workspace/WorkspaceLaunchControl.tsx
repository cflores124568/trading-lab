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
          class="min-w-[180px] rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-500"
          value={workspaceId()}
          onChange={(event) => setWorkspaceId(event.currentTarget.value)}
        >
          {workspaceOptions().map((workspace) => (
            <option value={workspace.id}>{workspace.name}</option>
          ))}
        </select>
        <A
          href={href()}
          class="rounded-lg border border-zinc-700 px-3 py-2 text-center text-xs font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
        >
          {props.buttonLabel ?? "Open in Workspace"}
        </A>
      </div>
    );
  }

  return (
    <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
      <label class="space-y-1">
        <span class="block text-xs text-zinc-400">Workspace target</span>
        <select
          class="min-w-[220px] rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-500"
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
        class="rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
      >
        {props.buttonLabel ?? "Open in Workspace"}
      </A>
    </div>
  );
}
