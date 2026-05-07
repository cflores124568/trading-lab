import { createMemo, Show } from "solid-js";
import { loadActiveWorkspaceContext } from "./workspacePersistence";

interface Props {
  compact?: boolean;
}

export default function WorkspaceContextBadge(props: Props) {
  const context = createMemo(() => loadActiveWorkspaceContext());
  const queryLabel = createMemo(() => {
    const query = context()?.query;
    if (!query) {
      return "No panel query saved yet";
    }

    if (query.mode === "historical") {
      return `${query.symbol} · ${query.interval} · ${query.startDate || "Earliest"} to ${query.endDate || "Latest"}`;
    }

    return `${query.symbol} · ${query.interval} · ${query.period}`;
  });

  return (
    <Show when={context()}>
      {(activeContext) => (
        <div class={`rounded-lg border border-zinc-800 bg-zinc-950/55 ${props.compact ? "px-3 py-2" : "px-4 py-3"}`}>
          <p class="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
            Active Workspace Context
          </p>
          <p class="mt-1 text-sm font-semibold text-zinc-100">{activeContext().workspaceName}</p>
          <p class="mt-1 text-xs text-zinc-400">{queryLabel()}</p>
          <div class="mt-2 flex flex-wrap gap-1.5 text-[11px]">
            <span class="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-300">
              Firm: {activeContext().accountProfile.propFirm || "Not set"}
            </span>
            <span class="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-300">
              Account: {activeContext().accountProfile.accountLabel || "Not set"}
            </span>
            <span class="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-300">
              Stage: {activeContext().accountProfile.accountStage || "Not set"}
            </span>
          </div>
        </div>
      )}
    </Show>
  );
}
