import { Show, For, createSignal, onCleanup, onMount } from "solid-js";
import FirmLogo from "./FirmLogo";
import { firmLogoSrc, firmOf, stripFirmPrefix } from "../utils/firmLogo";

interface PresetLike {
  name: string;
}

interface Props {
  presets: PresetLike[];
  value: string;
  onChange: (name: string) => void;
  placeholder?: string;
  disabled?: boolean;
  class?: string;
}

function groupPresets(presets: PresetLike[]): Record<string, PresetLike[]> {
  return presets.reduce<Record<string, PresetLike[]>>((acc, preset) => {
    const firm = firmOf(preset.name);
    (acc[firm] ??= []).push(preset);
    return acc;
  }, {});
}

export default function PropPresetSelect(props: Props) {
  const [open, setOpen] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;

  const selectedPreset = () => props.presets.find((p) => p.name === props.value) ?? null;
  const groups = () => Object.entries(groupPresets(props.presets));

  const handleClickOutside = (event: MouseEvent) => {
    if (containerRef && !containerRef.contains(event.target as Node)) {
      setOpen(false);
    }
  };
  const handleKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") setOpen(false);
  };

  onMount(() => {
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
  });
  onCleanup(() => {
    document.removeEventListener("mousedown", handleClickOutside);
    document.removeEventListener("keydown", handleKey);
  });

  const handleSelect = (name: string) => {
    props.onChange(name);
    setOpen(false);
  };

  return (
    <div class={`relative ${props.class ?? ""}`} ref={containerRef}>
      <button
        type="button"
        onClick={() => !props.disabled && setOpen((o) => !o)}
        disabled={props.disabled}
        class="app-input flex w-full items-center justify-between gap-2 text-sm disabled:opacity-40"
        aria-haspopup="listbox"
        aria-expanded={open()}
      >
        <span class="flex min-w-0 items-center gap-2">
          <Show
            when={selectedPreset()}
            fallback={<span class="text-stone-500">{props.placeholder ?? "Select a preset..."}</span>}
          >
            {(preset) => {
              const firm = () => firmOf(preset().name);
              const hasLogo = () => !!firmLogoSrc(firm());
              return (
                <>
                  <FirmLogo firmName={firm()} heightClass="h-6" class="shrink-0" />
                  <span class="truncate text-stone-100">
                    {hasLogo() ? stripFirmPrefix(preset().name, firm()) : preset().name}
                  </span>
                </>
              );
            }}
          </Show>
        </span>
        <svg
          class={`h-4 w-4 shrink-0 text-stone-500 transition-transform ${open() ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      <Show when={open()}>
        <div class="absolute left-0 right-0 top-full z-50 mt-1 max-h-80 overflow-y-auto rounded-sm border border-stone-800 bg-stone-950/95 shadow-xl backdrop-blur">
          <For each={groups()}>
            {([firm, options]) => (
              <div class="border-b border-stone-900/80 py-1 last:border-b-0">
                <div class="flex items-center gap-3 border-b border-stone-900/60 bg-stone-900/40 px-3 py-2.5 text-[10px] uppercase tracking-[0.2em] text-stone-300">
                  <FirmLogo firmName={firm} heightClass="h-9" class="shrink-0" />
                  <span class="truncate">{firm}</span>
                </div>
                <For each={options}>
                  {(preset) => {
                    const isSelected = () => preset.name === props.value;
                    return (
                      <button
                        type="button"
                        onClick={() => handleSelect(preset.name)}
                        class={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-stone-900 ${
                          isSelected() ? "bg-stone-100/10 text-stone-50" : "text-stone-200"
                        }`}
                      >
                        <span class="truncate">{stripFirmPrefix(preset.name, firm)}</span>
                        <Show when={isSelected()}>
                          <span class="shrink-0 text-xs text-stone-200">✓</span>
                        </Show>
                      </button>
                    );
                  }}
                </For>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
