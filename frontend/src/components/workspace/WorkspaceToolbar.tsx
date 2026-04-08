import type { WorkspacePreset, WorkspacePresetOption } from "./chartPanelTypes";

interface Props {
  preset: WorkspacePreset;
  options: WorkspacePresetOption[];
  onPresetChange: (preset: WorkspacePreset) => void;
}

export default function WorkspaceToolbar(props: Props) {
  return (
    <div class="space-y-4">
      <div class="space-y-2">
        <p class="app-kicker">Workspace Presets</p>
        <h2 class="text-lg font-semibold text-zinc-100">Start with a real multi-chart setup</h2>
        <p class="max-w-3xl text-sm text-zinc-400">
          Keep the layout simple for now, but make every panel independent so we can grow this
          into a heavier workspace system later without throwing the dashboard away. On wider
          screens you can drag the dividers now, and the workspace remembers what you changed.
        </p>
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
