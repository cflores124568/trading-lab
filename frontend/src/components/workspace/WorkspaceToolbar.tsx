import { createEffect, createSignal } from "solid-js";
import { Check, CopyPlus, Plus, Star, Trash2 } from "lucide-solid";
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
  onWorkspaceChange: (workspaceId: string) => void;
  onDefaultWorkspaceChange: (workspaceId: string) => void;
  onWorkspaceNameChange: (name: string) => void;
  onWorkspaceAccountProfileChange: (profile: WorkspaceAccountProfile) => void;
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
  const [accountOpen, setAccountOpen] = createSignal(false);

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
    <div class="border-b border-white/8 bg-black/18 px-4 py-4 lg:px-5">
      <div class="flex flex-col gap-2.5">
        <div class="app-panel app-panel-selected flex flex-col gap-3 rounded-2xl p-4 xl:flex-row xl:items-center xl:justify-between">
          <div class="flex flex-wrap items-center gap-3">
            <div class="min-w-0">
              <p class="app-kicker text-stone-200">Current Workspace</p>
              <p class="truncate text-sm font-semibold text-stone-50">{props.workspaceName}</p>
            </div>
            <div class="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-stone-400">
              {props.workspaceCount} {props.workspaceCount === 1 ? "Workspace" : "Workspaces"}
            </div>
            <div class="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-stone-400">
              {props.panelCount} {props.panelCount === 1 ? "Panel" : "Panels"}
            </div>
            <div
              class={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] ${
                props.workspaceId === props.defaultWorkspaceId
                  ? "border-[rgba(232,223,209,0.82)] bg-[rgba(235,227,213,0.1)] text-stone-50"
                  : "border-white/8 bg-white/[0.03] text-stone-500"
              }`}
            >
              {props.workspaceId === props.defaultWorkspaceId ? (
                <Check size={13} />
              ) : (
                <Star size={13} />
              )}
              {props.workspaceId === props.defaultWorkspaceId ? "Default" : "Not Default"}
            </div>
            <p class="app-meta-text">Auto-saves changes to this workspace.</p>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="app-button-primary gap-2 rounded-xl px-3 disabled:cursor-not-allowed disabled:bg-stone-800 disabled:text-stone-600"
              onClick={props.onAddChart}
              disabled={!props.canAddChart}
            >
              <Plus size={15} />
              Add Chart
            </button>
            <button
              type="button"
              class="app-button-secondary gap-2 rounded-xl px-3"
              onClick={props.onCreateWorkspace}
            >
              <CopyPlus size={15} />
              Save as New
            </button>
            {props.canDeleteWorkspace ? (
              <button
                type="button"
                class="inline-flex items-center gap-2 rounded-xl border border-stone-800 px-3 py-2 text-sm font-medium text-stone-400 transition-colors hover:border-red-800 hover:bg-red-950/40 hover:text-red-200"
                onClick={props.onDeleteWorkspace}
              >
                <Trash2 size={15} />
                Delete
              </button>
            ) : null}
          </div>
        </div>

        <div class="grid gap-2.5 xl:grid-cols-[minmax(220px,0.85fr)_minmax(220px,0.85fr)_auto]">
          <label class="space-y-1">
            <span class="block text-xs text-stone-500">Switch workspace</span>
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
            <span class="block text-xs text-stone-500">Rename current</span>
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
            <span class="block text-xs text-stone-500">Layout</span>
            <div class="grid gap-2 rounded-xl border border-stone-700/80 bg-stone-950/78 p-2 sm:grid-cols-3">
              {props.options.map((option) => {
                const active = props.preset === option.value;
                return (
                  <button
                    type="button"
                    class={`flex min-w-[124px] items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                      active
                        ? "app-card-selected border-stone-200/75 text-stone-50"
                        : "border-stone-800 bg-stone-900 text-stone-400 hover:border-stone-700 hover:bg-stone-800 hover:text-stone-100"
                    }`}
                    title={option.description}
                    onClick={() => props.onPresetChange(option.value)}
                  >
                    <span class={active ? "text-stone-200" : "text-stone-500"}>
                      <LayoutPreview preset={option.value} />
                    </span>
                    <span>
                      <span class="block text-xs font-semibold uppercase tracking-[0.14em]">
                        {option.label}
                      </span>
                      <span class={active ? "block text-[11px] text-stone-200" : "block text-[11px] text-stone-500"}>
                        {active ? "Active" : "Switch"}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div class="rounded-2xl border border-stone-800/80 bg-stone-950/55 p-4">
          <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div class="space-y-1">
              <p class="app-kicker text-stone-200">Account and risk</p>
              <p class="text-sm font-medium text-stone-100">
                {props.accountProfile.propFirm || "No prop firm"}{" "}
                <span class="text-stone-600">·</span>{" "}
                {props.accountProfile.accountLabel || "No account label"}{" "}
                <span class="text-stone-600">·</span>{" "}
                {props.accountProfile.accountStage || "No stage"}
              </p>
              <p class="text-xs text-stone-500">
                Daily loss {dailyLossDraft() || "n/a"}{" "}
                <span class="text-stone-600">·</span> Max DD {maxDrawdownDraft() || "n/a"}{" "}
                <span class="text-stone-600">·</span> Target {profitTargetDraft() || "n/a"}
              </p>
            </div>
            <button
              type="button"
              class="inline-flex items-center justify-center rounded-lg border border-stone-700 px-3 py-2 text-xs font-medium text-stone-300 transition-colors hover:border-stone-500 hover:bg-stone-900 hover:text-stone-100"
              onClick={() => setAccountOpen((current) => !current)}
            >
              {accountOpen() ? "Hide details" : "Edit details"}
            </button>
          </div>

          {accountOpen() ? (
            <>
              <div class="mt-4 grid gap-3 xl:grid-cols-3">
                <label class="space-y-1">
                  <span class="block text-xs text-stone-500">Prop firm</span>
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
                  <span class="block text-xs text-stone-500">Account label</span>
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
                  <span class="block text-xs text-stone-500">Stage</span>
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
                  <span class="block text-xs text-stone-500">Daily loss limit</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    class={field}
                    value={dailyLossDraft()}
                    placeholder="1500"
                    onInput={(event) => setDailyLossDraft(event.currentTarget.value)}
                    onBlur={(event) =>
                      commitRiskInput(event.currentTarget.value, setDailyLossDraft, "dailyLossLimit")
                    }
                  />
                </label>

                <label class="space-y-1">
                  <span class="block text-xs text-stone-500">Max drawdown</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    class={field}
                    value={maxDrawdownDraft()}
                    placeholder="2500"
                    onInput={(event) => setMaxDrawdownDraft(event.currentTarget.value)}
                    onBlur={(event) =>
                      commitRiskInput(event.currentTarget.value, setMaxDrawdownDraft, "maxDrawdown")
                    }
                  />
                </label>

                <label class="space-y-1">
                  <span class="block text-xs text-stone-500">Profit target</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    class={field}
                    value={profitTargetDraft()}
                    placeholder="3000"
                    onInput={(event) => setProfitTargetDraft(event.currentTarget.value)}
                    onBlur={(event) =>
                      commitRiskInput(event.currentTarget.value, setProfitTargetDraft, "profitTarget")
                    }
                  />
                </label>
              </div>

              <label class="mt-3 space-y-1">
                <span class="block text-xs text-stone-500">Account notes</span>
                <textarea
                  class={`${field} min-h-16 resize-y`}
                  value={props.accountProfile.notes}
                  maxLength={MAX_WORKSPACE_ACCOUNT_NOTES_LENGTH}
                  placeholder="Rules quirks, payout milestones, personal guardrails..."
                  onInput={(event) => updateAccountProfile({ notes: event.currentTarget.value })}
                />
              </label>
            </>
          ) : null}
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-stone-800 bg-stone-950/55 px-3 py-2 text-xs text-stone-500">
          <span>
            This workspace auto-saves. Use Save as New when you want a separate version.
          </span>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg border border-stone-700 px-2.5 py-1.5 text-xs font-medium text-stone-300 transition-colors hover:border-stone-500 hover:bg-stone-900 hover:text-stone-100 disabled:cursor-default disabled:border-stone-800 disabled:text-stone-600"
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
