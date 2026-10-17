import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

type Parameter = { key: string; label: string; default: number; min?: number; step?: number };

const suggestions: Record<string, number[]> = {
  fast_period: [5, 9, 12, 20, 50], slow_period: [21, 50, 100, 200],
  trend_ema_period: [20, 50, 100, 200], min_atr_percent: [0.1, 0.2, 0.5, 1],
  cooldown_bars: [1, 3, 5, 10], rsi_period: [7, 14, 21],
  overbought: [60, 70, 80], oversold: [20, 30, 40],
  bb_period: [10, 20, 30, 50], std_dev: [1, 1.5, 2, 2.5, 3],
  opening_range_minutes: [5, 15, 30, 60], breakout_buffer_percent: [0, 0.01, 0.05, 0.1],
  entry_deviation_percent: [0.05, 0.1, 0.2, 0.3, 0.5], warmup_minutes: [0, 5, 15, 30],
  session_start: [820, 900, 930, 1000], session_end: [1200, 1500, 1600],
};
const enabledDefaults: Record<string, number> = { trend_ema_period: 50, min_atr_percent: 0.1, cooldown_bars: 3 };
const inputClass = "app-input-quiet app-data w-full min-w-0 text-sm";
const modeClass = (active: boolean) => `rounded-sm px-2 py-1 text-[11px] transition-colors ${active
  ? "bg-stone-700 text-stone-100" : "text-stone-500 hover:text-stone-200"}`;

export default function StrategyParameterInput(props: {
  parameter: Parameter;
  value: string;
  onChange: (value: string) => void;
  allowSweep?: boolean;
}) {
  const key = () => props.parameter.key;
  const title = () => props.parameter.label.replace(/ \(0 off\)$/i, "");
  const id = () => `strategy-param-${key()}`;
  const isClock = () => key() === "session_start" || key() === "session_end";
  const optional = () => key() in enabledDefaults;
  const tokens = createMemo(() => [...new Set(props.value.split(",").map((value) => value.trim()).filter(Boolean))]);
  // Keep an in-progress or invalid edit visible so it can be corrected.
  const enabled = () => tokens().length === 0 || tokens().some((value) => Number(value) !== 0);
  const [rememberedValue, setRememberedValue] = createSignal("");
  const [sweep, setSweep] = createSignal(props.value.includes(","));
  createEffect(() => {
    if (props.value.includes(",") && props.allowSweep !== false) setSweep(true);
  });
  const format = (value: number) => isClock()
    ? `${String(Math.floor(value / 100)).padStart(2, "0")}:${String(value % 100).padStart(2, "0")}`
    : String(value);
  const clockValue = () => {
    const value = Number(props.value);
    return props.value.trim() && Number.isInteger(value) && value >= 0 && value <= 2359 && value % 100 < 60
      ? format(value) : "";
  };
  const setMode = (next: boolean) => {
    if (!next) {
      const value = Number(tokens()[0]);
      props.onChange(String(Number.isFinite(value) ? value : props.parameter.default));
    }
    setSweep(next);
  };
  const choose = (value: string) => {
    if (!sweep()) props.onChange(value);
    else if (!tokens().some((token) => Number(token) === Number(value))) props.onChange([...tokens(), value].join(", "));
  };
  const bump = (direction: number) => {
    const raw = Number(props.value);
    const current = props.value.trim() && Number.isFinite(raw) ? raw : props.parameter.default;
    const value = Math.max(props.parameter.min ?? 0, current + direction * (props.parameter.step ?? 1));
    props.onChange(String(Number(value.toFixed(8))));
  };

  return (
    <div class="min-w-0 space-y-2">
      <div class="flex min-h-7 flex-wrap items-center justify-between gap-2">
        <label for={id()} class="text-[11px] uppercase tracking-[0.12em] text-stone-400">
          {key() === "vwap_bias" ? "VWAP alignment" : title()}
        </label>
        <Show when={optional()}>
          <label class="flex cursor-pointer items-center gap-1.5 text-xs text-stone-400">
            <input type="checkbox" class="accent-stone-300" aria-label={`Enable ${title()}`} checked={enabled()}
              onChange={(event) => {
                if (event.currentTarget.checked) props.onChange(rememberedValue() || String(enabledDefaults[key()]));
                else { setRememberedValue(props.value); props.onChange("0"); }
              }} />
            Enable
          </label>
        </Show>
      </div>

      <Show when={key() === "vwap_bias"} fallback={
        <Show when={!optional() || enabled()} fallback={<p class="py-3 text-xs text-stone-500">Off — enable to configure.</p>}>
          <Show when={props.allowSweep !== false}>
            <div class="flex w-fit gap-1 rounded-md border border-stone-800 p-1" role="group" aria-label={`${title()} input mode`}>
              <button type="button" aria-pressed={!sweep()} class={modeClass(!sweep())} onClick={() => setMode(false)}>Single</button>
              <button type="button" aria-pressed={sweep()} class={modeClass(sweep())} onClick={() => setMode(true)}>Sweep</button>
            </div>
          </Show>
          <Show when={sweep() && props.allowSweep !== false} fallback={
            <Show when={isClock()} fallback={
              <div class="flex items-stretch gap-1">
                <button type="button" class="rounded-md border border-stone-800 px-3 text-stone-400 hover:text-stone-100"
                  aria-label={`Decrease ${title()}`} onClick={() => bump(-1)}>−</button>
                <input id={id()} type="number" class={inputClass} value={props.value} min={props.parameter.min}
                  step={props.parameter.step === 1 ? 1 : "any"} onInput={(event) => props.onChange(event.currentTarget.value)} />
                <button type="button" class="rounded-md border border-stone-800 px-3 text-stone-400 hover:text-stone-100"
                  aria-label={`Increase ${title()}`} onClick={() => bump(1)}>+</button>
              </div>
            }>
              <input id={id()} type="time" class={inputClass} value={clockValue()}
                onInput={(event) => props.onChange(event.currentTarget.value ? String(Number(event.currentTarget.value.replace(":", ""))) : "")} />
            </Show>
          }>
            <input id={id()} class={inputClass} value={props.value} placeholder="e.g. 9, 12, 21"
              onInput={(event) => props.onChange(event.currentTarget.value)} aria-describedby={`${id()}-hint`} />
            <div class="flex flex-wrap gap-1.5">
              <For each={tokens()}>{(token) => <button type="button"
                class="rounded-md border border-stone-700 bg-stone-900 px-2 py-1 text-xs text-stone-200"
                aria-label={`Remove ${token} from ${title()} sweep`}
                onClick={() => props.onChange(tokens().filter((value) => value !== token).join(", "))}>
                {isClock() && Number.isFinite(Number(token)) ? format(Number(token)) : token}<span class="ml-2 text-stone-500" aria-hidden="true">×</span>
              </button>}</For>
            </div>
            <p id={`${id()}-hint`} class="text-[11px] text-stone-500">Comma-separated values. {optional() ? "Include 0 to compare with the filter off." : "Each value is tested in the sweep."}</p>
          </Show>
          <Show when={suggestions[key()]?.length}>
            <select class={`${inputClass} text-xs`} aria-label={`Suggested ${title()}`} value=""
              onChange={(event) => { choose(event.currentTarget.value); event.currentTarget.value = ""; }}>
              <option value="" disabled selected>{sweep() ? "Add suggested value…" : "Choose a suggested value…"}</option>
              <For each={suggestions[key()]}>{(value) => <option value={value}>{format(value)}</option>}</For>
            </select>
          </Show>
        </Show>
      }>
        <div id={id()} class="flex flex-wrap gap-1 rounded-md border border-stone-800 p-1" role="group" aria-label="VWAP alignment">
          <For each={[
            { title: "Off", value: "0" }, { title: "On", value: "1" },
            ...(props.allowSweep === false ? [] : [{ title: "Compare both", value: "0, 1" }]),
          ]}>{(option) => <button type="button" class={modeClass(props.value.replace(/\s/g, "") === option.value.replace(/\s/g, ""))}
            aria-pressed={props.value.replace(/\s/g, "") === option.value.replace(/\s/g, "")}
            onClick={() => props.onChange(option.value)}>{option.title}</button>}</For>
        </div>
        <p class="text-[11px] text-stone-500">Require longs above VWAP and shorts below it.</p>
      </Show>
    </div>
  );
}
