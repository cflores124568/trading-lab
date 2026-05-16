import { createMemo, Show } from "solid-js";
import { loadActiveWorkspaceContext } from "./workspacePersistence";
import FirmLogo from "../FirmLogo";
import { firmLogoSrc } from "../../utils/firmLogo";

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
        <div class={`app-panel app-panel-selected rounded-lg ${props.compact ? "px-3 py-2" : "px-4 py-3"}`}>
          <p class="text-[11px] uppercase tracking-[0.18em] text-stone-200">
            Current Workspace Context
          </p>
          <p class="mt-1 text-sm font-semibold text-stone-100">{activeContext().workspaceName}</p>
          <p class="mt-1 text-xs text-stone-400">{queryLabel()}</p>
          <div class="mt-2 flex flex-wrap gap-1.5 text-[11px]">
            <span class="inline-flex items-center gap-1.5 rounded-full border border-stone-700 bg-stone-900 px-2 py-1 text-stone-300">
              <Show
                when={firmLogoSrc(activeContext().accountProfile.propFirm)}
                fallback={<>Firm: {activeContext().accountProfile.propFirm || "Not set"}</>}
              >
                <FirmLogo firmName={activeContext().accountProfile.propFirm} heightClass="h-3.5" />
              </Show>
            </span>
            <span class="rounded-full border border-stone-700 bg-stone-900 px-2 py-1 text-stone-300">
              Account: {activeContext().accountProfile.accountLabel || "Not set"}
            </span>
            <span class="rounded-full border border-stone-700 bg-stone-900 px-2 py-1 text-stone-300">
              Stage: {activeContext().accountProfile.accountStage || "Not set"}
            </span>
          </div>
        </div>
      )}
    </Show>
  );
}
