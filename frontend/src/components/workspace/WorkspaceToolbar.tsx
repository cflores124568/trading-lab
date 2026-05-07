import { createEffect, createSignal } from "solid-js";
import { Check, CopyPlus, PanelRight, Plus, Star, Trash2 } from "lucide-solid";
import {
  MAX_WORKSPACE_ACCOUNT_FIELD_LENGTH,
  MAX_WORKSPACE_ACCOUNT_NOTES_LENGTH,
  MAX_WORKSPACE_NAME_LENGTH,
  normalizeWorkspaceName,
  type WorkspaceAccountProfile,
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
  accountProfile: WorkspaceAccountProfile;
  preset: WorkspacePreset;
  options: WorkspacePresetOption[];
  panelCount: number;
  canAddChart: boolean;
  canDeleteWorkspace: boolean;
  showUtilityRail: boolean;
  onWorkspaceChange: (workspaceId: string) => void;
  onDefaultWorkspaceChange: (workspaceId: string) => void;
  onWorkspaceNameChange: (name: string) => void;
  onWorkspaceAccountProfileChange: (profile: WorkspaceAccountProfile) => void;
  onCreateWorkspace: () => void;
  onDeleteWorkspace: () => void;
  onPresetChange: (preset: WorkspacePreset) => void;
  onAddChart: () => void;
  onToggleUtilityRail: () => void;
}

const field =
  "w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 " +
  "focus:outline-none focus:ring-1 focus:ring-zinc-500";

function LayoutPreview(props: { preset: WorkspacePreset }) {
  if (props.preset === "focus") {
    return (
      <div class="grid h-9 w-12 grid-cols-1 gap-1">
        <span class="rounded bg-current" />
      </div>
    );
  }

  if (props.preset === "split") {
    return (
      <div class="grid h-9 w-12 grid-cols-2 gap-1">
        <span class="rounded bg-current" />
        <span class="rounded bg-current" />
      </div>
    );
  }

  return (
    <div class="grid h-9 w-12 grid-cols-2 gap-1">
      <span class="rounded bg-current" />
      <span class="rounded bg-current" />
      <span class="rounded bg-current" />
      <span class="rounded bg-current" />
    </div>
  );
}

export default function WorkspaceToolbar(props: Props) {
  const [nameDraft, setNameDraft] = createSignal(props.workspaceName);
  const [dailyLossDraft, setDailyLossDraft] = createSignal("");
  const [maxDrawdownDraft, setMaxDrawdownDraft] = createSignal("");
  const [profitTargetDraft, setProfitTargetDraft] = createSignal("");

  createEffect(() => {
    setNameDraft(props.workspaceName);
  });

  createEffect(() => {
    setDailyLossDraft(
      props.accountProfile.dailyLossLimit === null ? "" : String(props.accountProfile.dailyLossLimit),
    );
    setMaxDrawdownDraft(
      props.accountProfile.maxDrawdown === null ? "" : String(props.accountProfile.maxDrawdown),
    );
    setProfitTargetDraft(
      props.accountProfile.profitTarget === null ? "" : String(props.accountProfile.profitTarget),
    );
  });

  const commitWorkspaceName = () => {
    const nextName = normalizeWorkspaceName(nameDraft(), props.workspaceName);
    setNameDraft(nextName);
    props.onWorkspaceNameChange(nextName);
  };

  const updateAccountProfile = (patch: Partial<WorkspaceAccountProfile>) => {
    props.onWorkspaceAccountProfileChange({
      ...props.accountProfile,
      ...patch,
    });
  };

  const parseRiskInput = (value: string): number | null => {
    const cleaned = value.trim();
    if (!cleaned) {
      return null;
    }

    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }

    return Math.round(parsed * 100) / 100;
  };

  const commitRiskInput = (
    value: string,
    setDraft: (value: string) => void,
    key: "dailyLossLimit" | "maxDrawdown" | "profitTarget",
  ) => {
    const normalized = parseRiskInput(value);
    setDraft(normalized === null ? "" : String(normalized));
    updateAccountProfile({ [key]: normalized });
  };

  return (
    <div class="border-b border-zinc-800 bg-zinc-950/60 px-4 py-3 lg:px-5">
      <div class="flex flex-col gap-3">
        <div class="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div class="flex flex-wrap items-center gap-3">
            <div class="min-w-0">
              <p class="app-kicker">Active Workspace</p>
              <p class="truncate text-sm font-semibold text-zinc-100">{props.workspaceName}</p>
            </div>
            <div class="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-400">
              {props.workspaceCount} {props.workspaceCount === 1 ? "Workspace" : "Workspaces"}
            </div>
            <div class="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-400">
              {props.panelCount} {props.panelCount === 1 ? "Panel" : "Panels"}
            </div>
            <div
              class={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em] ${
                props.workspaceId === props.defaultWorkspaceId
                  ? "border-amber-700/70 bg-amber-950/45 text-amber-300"
                  : "border-zinc-800 bg-zinc-950 text-zinc-500"
              }`}
            >
              {props.workspaceId === props.defaultWorkspaceId ? (
                <Check size={13} />
              ) : (
                <Star size={13} />
              )}
              {props.workspaceId === props.defaultWorkspaceId ? "Default" : "Not Default"}
            </div>
            <p class="text-xs text-zinc-500">Auto-saves changes to this workspace.</p>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="inline-flex items-center gap-2 rounded-xl bg-zinc-100 px-3 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-600"
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
            {props.canDeleteWorkspace ? (
              <button
                type="button"
                class="inline-flex items-center gap-2 rounded-xl border border-zinc-800 px-3 py-2 text-sm font-medium text-zinc-400 transition-colors hover:border-red-800 hover:bg-red-950/40 hover:text-red-200"
                onClick={props.onDeleteWorkspace}
              >
                <Trash2 size={15} />
                Delete
              </button>
            ) : null}
          </div>
        </div>

        <div class="grid gap-3 xl:grid-cols-[minmax(220px,0.85fr)_minmax(220px,0.85fr)_auto]">
          <label class="space-y-1">
            <span class="block text-xs text-zinc-500">Switch workspace</span>
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
            <span class="block text-xs text-zinc-500">Rename current</span>
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

          <div class="space-y-1">
            <span class="block text-xs text-zinc-500">Layout</span>
            <div class="grid gap-2 rounded-xl border border-zinc-800 bg-zinc-950/70 p-2 sm:grid-cols-3">
              {props.options.map((option) => {
                const active = props.preset === option.value;
                return (
                  <button
                    type="button"
                    class={`flex min-w-[116px] items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                      active
                        ? "bg-zinc-100 text-zinc-950"
                        : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                    }`}
                    title={option.description}
                    onClick={() => props.onPresetChange(option.value)}
                  >
                    <span class={active ? "text-zinc-950" : "text-zinc-500"}>
                      <LayoutPreview preset={option.value} />
                    </span>
                    <span>
                      <span class="block text-xs font-semibold uppercase tracking-[0.14em]">
                        {option.label}
                      </span>
                      <span
                        class={
                          active
                            ? "block text-[11px] text-zinc-600"
                            : "block text-[11px] text-zinc-500"
                        }
                      >
                        {active ? "Active" : "Switch"}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div class="grid gap-3 xl:grid-cols-3">
          <label class="space-y-1">
            <span class="block text-xs text-zinc-500">Prop firm</span>
            <input
              type="text"
              class={field}
              value={props.accountProfile.propFirm}
              maxLength={MAX_WORKSPACE_ACCOUNT_FIELD_LENGTH}
              placeholder="Apex / Topstep / MyFundedFutures"
              onInput={(event) => updateAccountProfile({ propFirm: event.currentTarget.value })}
            />
          </label>

          <label class="space-y-1">
            <span class="block text-xs text-zinc-500">Account label</span>
            <input
              type="text"
              class={field}
              value={props.accountProfile.accountLabel}
              maxLength={MAX_WORKSPACE_ACCOUNT_FIELD_LENGTH}
              placeholder="50k Eval #2"
              onInput={(event) => updateAccountProfile({ accountLabel: event.currentTarget.value })}
            />
          </label>

          <label class="space-y-1">
            <span class="block text-xs text-zinc-500">Stage</span>
            <input
              type="text"
              class={field}
              value={props.accountProfile.accountStage}
              maxLength={MAX_WORKSPACE_ACCOUNT_FIELD_LENGTH}
              placeholder="Evaluation / Funded / PA"
              onInput={(event) => updateAccountProfile({ accountStage: event.currentTarget.value })}
            />
          </label>

          <label class="space-y-1">
            <span class="block text-xs text-zinc-500">Daily loss limit</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              class={field}
              value={dailyLossDraft()}
              placeholder="1500"
              onInput={(event) => setDailyLossDraft(event.currentTarget.value)}
              onBlur={(event) => commitRiskInput(event.currentTarget.value, setDailyLossDraft, "dailyLossLimit")}
            />
          </label>

          <label class="space-y-1">
            <span class="block text-xs text-zinc-500">Max drawdown</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              class={field}
              value={maxDrawdownDraft()}
              placeholder="2500"
              onInput={(event) => setMaxDrawdownDraft(event.currentTarget.value)}
              onBlur={(event) => commitRiskInput(event.currentTarget.value, setMaxDrawdownDraft, "maxDrawdown")}
            />
          </label>

          <label class="space-y-1">
            <span class="block text-xs text-zinc-500">Profit target</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              class={field}
              value={profitTargetDraft()}
              placeholder="3000"
              onInput={(event) => setProfitTargetDraft(event.currentTarget.value)}
              onBlur={(event) => commitRiskInput(event.currentTarget.value, setProfitTargetDraft, "profitTarget")}
            />
          </label>
        </div>

        <label class="space-y-1">
          <span class="block text-xs text-zinc-500">Account notes</span>
          <textarea
            class={`${field} min-h-16 resize-y`}
            value={props.accountProfile.notes}
            maxLength={MAX_WORKSPACE_ACCOUNT_NOTES_LENGTH}
            placeholder="Rules quirks, payout milestones, personal guardrails..."
            onInput={(event) => updateAccountProfile({ notes: event.currentTarget.value })}
          />
        </label>

        <div class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-zinc-950/55 px-3 py-2 text-xs text-zinc-500">
          <span>
            This workspace auto-saves. Use Save as New when you want a separate version.
          </span>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-900 hover:text-zinc-100 disabled:cursor-default disabled:border-zinc-800 disabled:text-zinc-600"
            onClick={() => props.onDefaultWorkspaceChange(props.workspaceId)}
            disabled={props.workspaceId === props.defaultWorkspaceId}
          >
            <Star size={13} />
            {props.workspaceId === props.defaultWorkspaceId
              ? "Opens by default"
              : "Open this by default"}
          </button>
        </div>
      </div>
    </div>
  );
}
