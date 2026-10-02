import ResearchWorkflow from "../../components/ResearchWorkflow";
import DataLoadError from "../../components/DataLoadError";
import { A, useNavigate } from "@solidjs/router";
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { CalendarRange, ChevronRight, FlaskConical, Plus, X } from "lucide-solid";
import AppShell from "../../components/AppShell";
import EmptyState from "../../components/EmptyState";
import ResearchDisclosure from "../../components/research/ResearchDisclosure";
import ResearchStatus from "../../components/research/ResearchStatus";
import { BACKTEST_INTERVALS, getBackendInterval } from "../../constants";
import {
  createResearchCampaign,
  fetchDbSymbols,
  fetchResearchCampaigns,
  type ResearchCampaignStatus,
} from "../../services/api";

const labelClass = "mb-1.5 block text-[11px] uppercase tracking-[0.16em] text-stone-500";
const inputClass = "app-input w-full text-sm";

function localDateInput(value: string): string {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function progressValue(progress: Record<string, unknown>, key: string): number {
  const value = Number(progress[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export default function AlphaLabIndexPage() {
  const navigate = useNavigate();
  const [campaigns, { refetch }] = createResource(fetchResearchCampaigns);
  const [symbols] = createResource(fetchDbSymbols);
  const [showCreate, setShowCreate] = createSignal(false);
  const [name, setName] = createSignal("");
  const [symbol, setSymbol] = createSignal("NQ");
  const [interval, setInterval] = createSignal("15min");
  const [startTime, setStartTime] = createSignal("");
  const [endTime, setEndTime] = createSignal("");
  const [developmentPct, setDevelopmentPct] = createSignal("60");
  const [validationPct, setValidationPct] = createSignal("20");
  const [holdoutPct, setHoldoutPct] = createSignal("20");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const [search, setSearch] = createSignal("");
  const [statusFilter, setStatusFilter] = createSignal("all");
  const filteredCampaigns = createMemo(() => ((campaigns.error ? [] : campaigns()) ?? []).filter((item) =>
    (statusFilter() === "all" || item.status === statusFilter()) && `${item.name} ${item.symbol}`.toLowerCase().includes(search().toLowerCase().trim())));

  const counts = createMemo(() => {
    const values = (campaigns.error ? undefined : campaigns()) ?? [];
    return {
      total: values.length,
      active: values.filter((item) => item.status === "queued" || item.status === "running").length,
      paused: values.filter((item) => item.status === "paused").length,
      trials: values.reduce((sum, item) => sum + progressValue(item.search_progress, "attempted_trials"), 0),
      failures: values.reduce((sum, item) => sum + progressValue(item.search_progress, "failed_trials"), 0),
    };
  });

  const selectedSymbol = createMemo(() => (symbols.error ? undefined : symbols())?.find((item) => item.symbol === symbol()));
  const splitTotal = createMemo(
    () => Number(developmentPct()) + Number(validationPct()) + Number(holdoutPct()),
  );

  const applyAvailableRange = () => {
    const source = selectedSymbol();
    if (!source) return;
    setStartTime(localDateInput(source.start_date));
    setEndTime(localDateInput(source.end_date));
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    setError(null);
    if (splitTotal() !== 100) {
      setError("Development, validation, and holdout percentages must total exactly 100.");
      return;
    }
    if (!startTime() || !endTime()) {
      setError("Choose an exact chronological research window.");
      return;
    }
    if (new Date(startTime()) >= new Date(endTime())) {
      setError("End timestamp must be after the start timestamp.");
      return;
    }
    setBusy(true);
    try {
      const campaign = await createResearchCampaign({
        name: name().trim(),
        symbol: symbol(),
        interval: interval(),
        start_time: new Date(startTime()).toISOString(),
        end_time: new Date(endTime()).toISOString(),
        development_pct: Number(developmentPct()),
        validation_pct: Number(validationPct()),
        holdout_pct: Number(holdoutPct()),
        created_by: "local-user",
      });
      await refetch();
      navigate(`/alpha-lab/${campaign.campaign_id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Campaign creation failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell
      title="Alpha Lab"
      subtitle="Bounded, validation-first strategy research with durable evidence and sealed holdouts."
      actions={
        <button type="button" class="app-button-primary gap-2" onClick={() => setShowCreate((value) => !value)}>
          {showCreate() ? <X size={16} /> : <Plus size={16} />}
          {showCreate() ? "Close setup" : "New campaign"}
        </button>
      }
    >
      <div class="space-y-6">
        <ResearchWorkflow active="/alpha-lab" />
        <ResearchDisclosure />

        <Show when={campaigns.error}><DataLoadError title="Campaigns could not load" error={campaigns.error} onRetry={refetch} /></Show>

        <section class="app-panel overflow-hidden">
          <div class="grid grid-cols-2 divide-x divide-stone-800 md:grid-cols-5">
            {[
              ["Campaigns", counts().total],
              ["Active", counts().active],
              ["Paused", counts().paused],
              ["Attempts", counts().trials],
              ["Failed", counts().failures],
            ].map(([label, value]) => (
              <div class="px-4 py-4 md:px-5">
                <p class="app-metric-label">{label}</p>
                <p class="app-metric-value">{campaigns.loading || campaigns.error ? "—" : value}</p>
              </div>
            ))}
          </div>
        </section>

        <Show when={showCreate()}>
          <section class="app-panel-elevated app-panel-section">
            <div class="flex items-start gap-3 border-b border-stone-800 pb-5">
              <FlaskConical class="mt-0.5 text-stone-300" size={20} />
              <div>
                <h2 class="text-lg font-semibold text-stone-100">Create a draft campaign</h2>
                <p class="mt-1 text-xs leading-5 text-stone-500">
                  Partition timestamps and bar counts are calculated by the backend from real stored bars. Search configuration and budgets are reviewed on the next screen before launch.
                </p>
              </div>
            </div>

            <form class="mt-6 space-y-6" onSubmit={submit}>
              <Show when={symbols.error}>
                <p class="rounded-sm border border-red-800 bg-red-950/35 px-4 py-3 text-sm text-red-200">
                  {symbols.error instanceof Error ? symbols.error.message : "DB-backed symbols could not be loaded."}
                </p>
              </Show>
              <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <label class="md:col-span-2">
                  <span class={labelClass}>Campaign name</span>
                  <input class={inputClass} value={name()} onInput={(event) => setName(event.currentTarget.value)} required maxlength={160} />
                </label>
                <label>
                  <span class={labelClass}>Symbol</span>
                  <select class={inputClass} value={symbol()} onChange={(event) => setSymbol(event.currentTarget.value)}>
                    <For each={(symbols.error ? undefined : symbols()) ?? []}>{(item) => <option value={item.symbol}>{item.symbol}</option>}</For>
                  </select>
                </label>
                <label>
                  <span class={labelClass}>Interval</span>
                  <select class={inputClass} value={interval()} onChange={(event) => setInterval(event.currentTarget.value)}>
                    <For each={BACKTEST_INTERVALS}>
                      {(item) => <option value={getBackendInterval(item)}>{item.label}</option>}
                    </For>
                  </select>
                </label>
              </div>

              <div class="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
                <label>
                  <span class={labelClass}>Start timestamp (local time)</span>
                  <input type="datetime-local" class={inputClass} value={startTime()} onInput={(event) => setStartTime(event.currentTarget.value)} required />
                </label>
                <label>
                  <span class={labelClass}>End timestamp (local time)</span>
                  <input type="datetime-local" class={inputClass} value={endTime()} onInput={(event) => setEndTime(event.currentTarget.value)} required />
                </label>
                <button type="button" class="app-button-secondary gap-2 whitespace-nowrap" onClick={applyAvailableRange} disabled={!selectedSymbol()}>
                  <CalendarRange size={15} /> Use available range
                </button>
              </div>

              <div>
                <div class="mb-3 flex items-center justify-between gap-4">
                  <p class={labelClass}>Chronological split percentages</p>
                  <span class={`app-data text-xs ${splitTotal() === 100 ? "text-emerald-300" : "text-red-300"}`}>
                    {splitTotal()}% total
                  </span>
                </div>
                <div class="mb-4 flex h-8 overflow-hidden rounded border border-stone-700" aria-label="Planned chronological data split">
                  <div class="flex items-center justify-center bg-stone-700 text-xs" style={{ width: `${Math.max(0, Number(developmentPct())) / (splitTotal() || 1) * 100}%` }}>Development</div>
                  <div class="flex items-center justify-center bg-teal-950 text-xs text-teal-200" style={{ width: `${Math.max(0, Number(validationPct())) / (splitTotal() || 1) * 100}%` }}>Validation</div>
                  <div class="flex items-center justify-center bg-amber-950 text-xs text-amber-200" style={{ width: `${Math.max(0, Number(holdoutPct())) / (splitTotal() || 1) * 100}%` }}>Sealed</div>
                </div>
                <div class="grid gap-4 md:grid-cols-3">
                  <label>
                    <span class={labelClass}>Development</span>
                    <input type="number" min="0.0001" max="99.9999" step="0.0001" class={inputClass} value={developmentPct()} onInput={(event) => setDevelopmentPct(event.currentTarget.value)} />
                  </label>
                  <label>
                    <span class={labelClass}>Validation</span>
                    <input type="number" min="0.0001" max="99.9999" step="0.0001" class={inputClass} value={validationPct()} onInput={(event) => setValidationPct(event.currentTarget.value)} />
                  </label>
                  <label>
                    <span class={labelClass}>Final holdout</span>
                    <input type="number" min="0.0001" max="99.9999" step="0.0001" class={inputClass} value={holdoutPct()} onInput={(event) => setHoldoutPct(event.currentTarget.value)} />
                  </label>
                </div>
              </div>

              <Show when={error()}>
                <p class="rounded-sm border border-red-800 bg-red-950/35 px-4 py-3 text-sm text-red-200">{error()}</p>
              </Show>
              <div class="flex justify-end">
                <button type="submit" disabled={busy() || symbols.loading || !!symbols.error || !selectedSymbol() || splitTotal() !== 100} class="app-button-primary min-w-40 disabled:cursor-not-allowed disabled:opacity-50">
                  {busy() ? "Calculating partitions..." : "Create draft"}
                </button>
              </div>
            </form>
          </section>
        </Show>

        <section class="app-panel app-panel-section">
          <div class="mb-5 flex items-end justify-between gap-4">
            <div>
              <h2 class="text-lg font-semibold text-stone-100">Research campaigns</h2>
              <p class="mt-1 text-xs text-stone-500">Newest campaigns first. Every failed attempt remains in its campaign ledger.</p>
            </div>
          </div>

          <div class="mb-5 flex flex-wrap gap-3">
            <label class="min-w-48 flex-1 text-xs text-stone-400">Find a campaign<input type="search" class="app-input mt-1 block w-full" placeholder="Campaign name or symbol" value={search()} onInput={(event) => setSearch(event.currentTarget.value)} /></label>
            <label class="text-xs text-stone-400">Status<select class="app-input mt-1 block" value={statusFilter()} onChange={(event) => setStatusFilter(event.currentTarget.value)}><option value="all">All statuses</option>{["draft", "queued", "running", "paused", "completed", "failed"].map((status) => <option value={status}>{status}</option>)}</select></label>
          </div>
          <Show when={!campaigns.loading && !campaigns.error && ((campaigns() ?? []).length > 0) && filteredCampaigns().length === 0}><p class="py-6 text-sm text-stone-400">No campaigns match these filters.</p></Show>
          <Show when={!campaigns.loading && !campaigns.error} fallback={<Show when={campaigns.loading}><div class="app-skeleton h-52" /></Show>}>
            <Show
              when={((campaigns.error ? undefined : campaigns()) ?? []).length > 0}
              fallback={
                <EmptyState
                  class="app-surface-muted"
                  icon={<FlaskConical size={18} />}
                  title="No research campaigns yet"
                  description="A campaign searches strategy settings across a date range, then re-checks the best results on data it held back, so a lucky fit doesn't pass as an edge."
                  actions={
                    <button type="button" class="app-button-primary gap-2" onClick={() => setShowCreate(true)}>
                      <Plus size={16} />
                      New campaign
                    </button>
                  }
                />
              }
            >
              <div class="overflow-x-auto">
                <table class="app-table min-w-[880px]">
                  <thead>
                    <tr><th>Campaign</th><th>Window</th><th>Partitions</th><th>Progress</th><th>Budget</th><th /></tr>
                  </thead>
                  <tbody>
                    <For each={filteredCampaigns()}>
                      {(campaign) => {
                        const attempted = progressValue(campaign.search_progress, "attempted_trials");
                        const planned = progressValue(campaign.search_progress, "planned_trials");
                        const percent = planned > 0 ? Math.min(100, Math.round((attempted / planned) * 100)) : 0;
                        return (
                          <tr>
                            <td>
                              <div class="flex items-center gap-2">
                                <A href={`/alpha-lab/${campaign.campaign_id}`} class="font-semibold text-stone-100 hover:text-white">{campaign.name}</A>
                                <ResearchStatus status={campaign.status as ResearchCampaignStatus} />
                              </div>
                              <p class="mt-1 text-xs text-stone-500">{campaign.symbol} / {campaign.interval} / {campaign.total_bar_count.toLocaleString()} bars</p>
                            </td>
                            <td class="app-data text-xs text-stone-400">{formatDate(campaign.start_time)}<br />{formatDate(campaign.end_time)}</td>
                            <td class="app-data text-xs text-stone-300">{campaign.development_pct}% / {campaign.validation_pct}% / {campaign.holdout_pct}%</td>
                            <td>
                              <p class="app-data text-xs text-stone-200">{attempted} / {planned || "not queued"}</p>
                              <div class="mt-2 h-px w-28 bg-stone-800"><div class="h-px bg-stone-200" style={{ width: `${percent}%` }} /></div>
                            </td>
                            <td class="app-data text-xs text-stone-400">{campaign.trial_budget ?? "Unset"} trials<br />{campaign.wall_clock_budget_seconds ? `${Math.round(campaign.wall_clock_budget_seconds / 60)} min` : "Unset time"}</td>
                            <td class="text-right"><A href={`/alpha-lab/${campaign.campaign_id}`} aria-label={`Open ${campaign.name}`} class="inline-flex rounded-sm p-2 text-stone-400 hover:bg-stone-900 hover:text-stone-100"><ChevronRight size={16} /></A></td>
                          </tr>
                        );
                      }}
                    </For>
                  </tbody>
                </table>
              </div>
            </Show>
          </Show>
        </section>
      </div>
    </AppShell>
  );
}
