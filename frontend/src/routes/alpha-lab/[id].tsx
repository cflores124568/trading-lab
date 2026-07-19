import { A, useParams } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Show,
} from "solid-js";
import {
  ArrowLeft,
  Check,
  CirclePause,
  FlaskConical,
  LockKeyhole,
  Play,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-solid";
import AppShell from "../../components/AppShell";
import ResearchDisclosure from "../../components/research/ResearchDisclosure";
import ResearchStatus from "../../components/research/ResearchStatus";
import { STRATEGIES, STRATEGY_PARAMS, type StrategyValue } from "../../constants";
import {
  fetchResearchCampaign,
  fetchResearchCandidatePromotions,
  fetchResearchFinalists,
  fetchResearchTrials,
  fetchResearchValidation,
  pauseResearchCampaign,
  promoteResearchCandidate,
  queueResearchCampaign,
  resumeResearchCampaign,
  type ResearchFinalistResult,
  type ResearchTrialResult,
} from "../../services/api";

const labelClass = "mb-1.5 block text-[11px] uppercase tracking-[0.16em] text-stone-500";
const inputClass = "app-input w-full text-sm";

function formatDate(value?: string | null): string {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function numberValue(source: Record<string, unknown>, key: string): number {
  const value = Number(source[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function formatNumber(value: unknown, digits = 2): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : "n/a";
}

function formatCurrency(value: unknown): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "n/a";
  return `${parsed >= 0 ? "+" : "-"}$${Math.abs(parsed).toFixed(2)}`;
}

function metricFromTrial(trial: ResearchTrialResult, key: string): unknown {
  const metrics = trial.result?.metrics;
  return metrics && typeof metrics === "object" ? (metrics as Record<string, unknown>)[key] : undefined;
}

function uniqueGrid(raw: string, key: string): number[] {
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean).map(Number);
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`${key} needs at least one comma-separated number.`);
  }
  return [...new Set(values)];
}

function defaultGrid(strategy: StrategyValue): Record<string, string> {
  return Object.fromEntries(STRATEGY_PARAMS[strategy].map((item) => [item.key, String(item.default)]));
}

function partitionTone(name: string): string {
  if (name === "development") return "bg-stone-300 text-stone-950";
  if (name === "validation") return "bg-sky-800 text-sky-50";
  return "bg-amber-800 text-amber-50";
}

function resultOutcome(finalist: ResearchFinalistResult): string {
  const outcome = finalist.holdout_result?.outcome;
  return typeof outcome === "string" ? outcome.replace(/_/g, " ") : "sealed";
}

export default function AlphaLabCampaignPage() {
  const params = useParams<{ id: string }>();
  const [campaign, { refetch: refetchCampaign }] = createResource(() => params.id, fetchResearchCampaign);
  const [trials, { refetch: refetchTrials }] = createResource(() => params.id, fetchResearchTrials);
  const [finalists, { refetch: refetchFinalists }] = createResource(() => params.id, fetchResearchFinalists);
  const [promotions, { refetch: refetchPromotions }] = createResource(
    () => params.id,
    fetchResearchCandidatePromotions,
  );
  const [selectedTrialId, setSelectedTrialId] = createSignal("");
  const [validation] = createResource(
    () => selectedTrialId() ? `${params.id}:${selectedTrialId()}` : false,
    async () => fetchResearchValidation(params.id, selectedTrialId()),
  );
  const [strategy, setStrategy] = createSignal<StrategyValue>("ma_crossover");
  const [gridInputs, setGridInputs] = createSignal(defaultGrid("ma_crossover"));
  const [trialBudget, setTrialBudget] = createSignal("25");
  const [wallMinutes, setWallMinutes] = createSignal("30");
  const [initialBalance, setInitialBalance] = createSignal("100000");
  const [positionSize, setPositionSize] = createSignal("1");
  const [commission, setCommission] = createSignal("5");
  const [slippageTicks, setSlippageTicks] = createSignal("1");
  const [tickSize, setTickSize] = createSignal("0.25");
  const [tickValue, setTickValue] = createSignal("20");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [promotionReason, setPromotionReason] = createSignal("");

  createEffect(() => {
    const first = finalists()?.[0];
    if (first && !selectedTrialId()) setSelectedTrialId(first.trial_id);
  });

  const parsedGrid = createMemo(() => {
    try {
      return Object.fromEntries(
        STRATEGY_PARAMS[strategy()].map((item) => [item.key, uniqueGrid(gridInputs()[item.key] ?? "", item.key)]),
      );
    } catch {
      return null;
    }
  });
  const searchSpace = createMemo(() => {
    const grid = parsedGrid();
    if (!grid) return 0;
    return Object.values(grid).reduce((total, values) => total * values.length, 1);
  });
  const plannedTrials = createMemo(() => Math.min(searchSpace(), Math.max(0, Number(trialBudget()) || 0)));
  const selectedTrial = createMemo(() => trials()?.find((item) => item.trial_id === selectedTrialId()));
  const selectedFinalist = createMemo(() => finalists()?.find((item) => item.trial_id === selectedTrialId()));
  const selectedPromotion = createMemo(() => promotions()?.find((item) => item.trial_id === selectedTrialId()));
  const progress = createMemo(() => campaign()?.search_progress ?? {});

  const selectStrategy = (value: StrategyValue) => {
    setStrategy(value);
    setGridInputs(defaultGrid(value));
  };

  const refresh = async () => {
    await Promise.all([refetchCampaign(), refetchTrials(), refetchFinalists(), refetchPromotions()]);
  };

  const launch = async (event: SubmitEvent) => {
    event.preventDefault();
    setError(null);
    const grid = parsedGrid();
    if (!grid) {
      setError("Fix the parameter grid before launch.");
      return;
    }
    if (plannedTrials() < 1) {
      setError("The explicit trial budget must allow at least one plan.");
      return;
    }
    setBusy(true);
    try {
      await queueResearchCampaign(params.id, {
        strategy_type: strategy(),
        parameter_space: grid,
        execution_config: {
          initial_balance: Number(initialBalance()),
          position_size: Number(positionSize()),
          commission: Number(commission()),
          slippage_ticks: Number(slippageTicks()),
          tick_size: Number(tickSize()),
          tick_value: Number(tickValue()),
          execution_mode: "bar",
        },
        trial_budget: Number(trialBudget()),
        wall_clock_budget_seconds: Math.round(Number(wallMinutes()) * 60),
        actor: "local-user",
      });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Campaign launch failed.");
    } finally {
      setBusy(false);
    }
  };

  const changeRunState = async () => {
    const current = campaign();
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      if (current.status === "paused") await resumeResearchCampaign(params.id);
      else await pauseResearchCampaign(params.id);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Campaign status update failed.");
    } finally {
      setBusy(false);
    }
  };

  const promote = async () => {
    const finalist = selectedFinalist();
    if (!finalist) return;
    if (!promotionReason().trim()) {
      setError("Write a concrete operator rationale before manual promotion.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await promoteResearchCandidate(params.id, finalist.trial_id, promotionReason().trim());
      setPromotionReason("");
      await Promise.all([refetchPromotions(), refetchCampaign()]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Manual promotion failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell
      title={campaign()?.name ?? "Alpha Lab campaign"}
      subtitle={campaign() ? `${campaign()!.symbol} / ${campaign()!.interval} / ${campaign()!.total_bar_count.toLocaleString()} bars` : "Loading durable research state."}
      actions={
        <div class="flex items-center gap-2">
          <button type="button" class="app-button-secondary gap-2" onClick={refresh}><RefreshCw size={15} /> Refresh</button>
          <A href="/alpha-lab" class="app-button-secondary gap-2"><ArrowLeft size={15} /> Campaigns</A>
        </div>
      }
    >
      <Show when={campaign.error}>
        <div class="rounded-sm border border-red-800 bg-red-950/35 px-4 py-3 text-sm text-red-200">
          {campaign.error instanceof Error ? campaign.error.message : "Campaign data could not be loaded."}
        </div>
      </Show>
      <Show when={campaign()} fallback={<Show when={!campaign.error}><div class="app-skeleton h-80" /></Show>}>
        {(current) => (
          <div class="space-y-6">
            <ResearchDisclosure />
            <Show when={error()}><div class="rounded-sm border border-red-800 bg-red-950/35 px-4 py-3 text-sm text-red-200">{error()}</div></Show>
            <Show when={trials.error || finalists.error || promotions.error}>
              <div class="rounded-sm border border-red-800 bg-red-950/35 px-4 py-3 text-sm text-red-200">
                Alpha Lab evidence could not be loaded. Refresh after checking the backend and PostgreSQL.
              </div>
            </Show>

            <section class="app-panel overflow-hidden">
              <div class="flex flex-col gap-4 border-b border-stone-800 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
                <div class="flex items-center gap-3">
                  <ResearchStatus status={current().status} />
                  <p class="text-xs text-stone-500">Updated {formatDate(current().updated_at)}</p>
                </div>
                <Show when={["queued", "running", "paused"].includes(current().status)}>
                  <button type="button" disabled={busy()} onClick={changeRunState} class="app-button-primary gap-2 disabled:opacity-50">
                    {current().status === "paused" ? <Play size={15} /> : <CirclePause size={15} />}
                    {current().status === "paused" ? "Resume campaign" : "Pause campaign"}
                  </button>
                </Show>
              </div>
              <div class="grid grid-cols-2 divide-x divide-stone-800 md:grid-cols-6">
                {[
                  ["Planned", numberValue(progress(), "planned_trials")],
                  ["Attempted", numberValue(progress(), "attempted_trials")],
                  ["Completed", numberValue(progress(), "completed_trials")],
                  ["Failed", numberValue(progress(), "failed_trials")],
                  ["Finalists", finalists()?.length ?? 0],
                  ["Promoted", promotions()?.length ?? 0],
                ].map(([label, value]) => <div class="px-4 py-4"><p class="app-metric-label">{label}</p><p class="app-metric-value text-xl">{value}</p></div>)}
              </div>
            </section>

            <section class="app-panel app-panel-section">
              <div class="mb-5">
                <h2 class="text-lg font-semibold">Chronological partitions</h2>
                <p class="mt-1 text-xs text-stone-500">Exact backend-calculated timestamps and bar counts. Segments do not overlap.</p>
              </div>
              <div class="flex h-12 w-full overflow-hidden rounded-sm border border-stone-700">
                <For each={current().partitions}>
                  {(partition) => (
                    <div class={`flex min-w-0 items-center justify-center px-2 text-center text-[10px] font-semibold uppercase tracking-[0.12em] ${partitionTone(partition.partition_name)}`} style={{ width: `${(partition.bar_count / current().total_bar_count) * 100}%` }}>
                      <span class="truncate">{partition.partition_name} {partition.bar_count.toLocaleString()}</span>
                    </div>
                  )}
                </For>
              </div>
              <div class="mt-4 grid gap-3 md:grid-cols-3">
                <For each={current().partitions}>
                  {(partition) => (
                    <div class="app-surface-muted px-4 py-3">
                      <div class="flex items-center justify-between"><p class="text-sm font-semibold capitalize">{partition.partition_name}</p><span class="app-data text-xs text-stone-400">{partition.bar_count.toLocaleString()} bars</span></div>
                      <p class="app-data mt-3 text-[11px] leading-5 text-stone-500">{formatDate(partition.start_time)}<br />{formatDate(partition.end_time)}</p>
                    </div>
                  )}
                </For>
              </div>
            </section>

            <Show when={current().status === "draft"}>
              <section class="app-panel-elevated app-panel-section">
                <div class="flex items-start gap-3 border-b border-stone-800 pb-5">
                  <FlaskConical class="mt-0.5 text-stone-300" size={20} />
                  <div><h2 class="text-lg font-semibold">Review search and budgets</h2><p class="mt-1 text-xs text-stone-500">Launching queues deterministic development-partition work only. Validation and holdout remain separate.</p></div>
                </div>
                <form class="mt-6 space-y-6" onSubmit={launch}>
                  <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
                    <div>
                      <p class={labelClass}>Strategy family</p>
                      <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                        <For each={STRATEGIES}>{(item) => <button type="button" onClick={() => selectStrategy(item.value)} class={`rounded-sm border px-3 py-3 text-left text-xs font-medium transition-colors ${strategy() === item.value ? "border-stone-400 bg-stone-800 text-stone-50" : "border-stone-800 bg-stone-950 text-stone-400 hover:border-stone-700"}`}>{item.label}</button>}</For>
                      </div>
                    </div>
                    <div class="app-surface-strong px-4 py-3">
                      <p class="app-metric-label">Deterministic plan</p>
                      <p class="app-data mt-2 text-2xl font-semibold">{searchSpace().toLocaleString()}</p>
                      <p class="mt-1 text-xs text-stone-500">grid combinations</p>
                    </div>
                  </div>
                  <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    <For each={STRATEGY_PARAMS[strategy()]}>
                      {(item) => <label><span class={labelClass}>{item.label}</span><input class={inputClass} value={gridInputs()[item.key] ?? ""} onInput={(event) => setGridInputs((values) => ({ ...values, [item.key]: event.currentTarget.value }))} /><span class="mt-1 block text-[10px] text-stone-600">Comma-separated values</span></label>}
                    </For>
                  </div>
                  <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <label><span class={labelClass}>Trial budget</span><input type="number" min="1" max="10000" class={inputClass} value={trialBudget()} onInput={(event) => setTrialBudget(event.currentTarget.value)} /></label>
                    <label><span class={labelClass}>Wall-clock budget (minutes)</span><input type="number" min="1" max="10080" class={inputClass} value={wallMinutes()} onInput={(event) => setWallMinutes(event.currentTarget.value)} /></label>
                    <label><span class={labelClass}>Initial balance</span><input type="number" min="1" class={inputClass} value={initialBalance()} onInput={(event) => setInitialBalance(event.currentTarget.value)} /></label>
                    <label><span class={labelClass}>Position size</span><input type="number" min="0.0001" step="0.0001" class={inputClass} value={positionSize()} onInput={(event) => setPositionSize(event.currentTarget.value)} /></label>
                    <label><span class={labelClass}>Commission</span><input type="number" min="0" step="0.01" class={inputClass} value={commission()} onInput={(event) => setCommission(event.currentTarget.value)} /></label>
                    <label><span class={labelClass}>Slippage ticks</span><input type="number" min="0" step="0.1" class={inputClass} value={slippageTicks()} onInput={(event) => setSlippageTicks(event.currentTarget.value)} /></label>
                    <label><span class={labelClass}>Tick size</span><input type="number" min="0.000001" step="0.01" class={inputClass} value={tickSize()} onInput={(event) => setTickSize(event.currentTarget.value)} /></label>
                    <label><span class={labelClass}>Tick value</span><input type="number" min="0.000001" step="0.01" class={inputClass} value={tickValue()} onInput={(event) => setTickValue(event.currentTarget.value)} /></label>
                  </div>
                  <div class="flex flex-col gap-3 border-t border-stone-800 pt-5 sm:flex-row sm:items-center sm:justify-between">
                    <p class="text-sm text-stone-300"><span class="app-data font-semibold">{plannedTrials().toLocaleString()}</span> {plannedTrials() === 1 ? "attempt" : "attempts"} will run from a {searchSpace().toLocaleString()}-plan space, capped at {wallMinutes()} minutes.</p>
                    <button type="submit" disabled={busy() || !parsedGrid()} class="app-button-primary gap-2 whitespace-nowrap disabled:opacity-50"><Play size={15} /> {busy() ? "Queueing..." : "Launch campaign"}</button>
                  </div>
                </form>
              </section>
            </Show>

            <section class="app-panel app-panel-section">
              <div class="mb-5 flex items-end justify-between"><div><h2 class="text-lg font-semibold">Complete trial ledger</h2><p class="mt-1 text-xs text-stone-500">Successful and failed attempts remain visible. Select a row to inspect validation evidence.</p></div><span class="app-data text-xs text-stone-500">{trials()?.length ?? 0} loaded</span></div>
              <Show when={!trials.loading} fallback={<div class="app-skeleton h-52" />}>
                <Show when={(trials() ?? []).length > 0} fallback={<div class="app-surface-muted px-5 py-10 text-center text-sm text-stone-500">No trial attempts have been recorded.</div>}>
                  <div class="overflow-x-auto"><table class="app-table min-w-[900px]"><thead><tr><th>Attempt</th><th>Strategy</th><th>Parameters</th><th>PnL</th><th>Trades</th><th>Completed</th></tr></thead><tbody><For each={trials()}>{(trial) => <tr class={`cursor-pointer ${selectedTrialId() === trial.trial_id ? "bg-stone-900" : ""}`} onClick={() => setSelectedTrialId(trial.trial_id)}><td><span class={`inline-flex rounded-sm border px-2 py-1 text-[10px] font-semibold uppercase ${trial.status === "failed" ? "border-red-800 bg-red-950/30 text-red-200" : "border-emerald-800 bg-emerald-950/30 text-emerald-200"}`}>{trial.status}</span><p class="app-data mt-1 max-w-36 truncate text-[10px] text-stone-600" title={trial.fingerprint}>{trial.fingerprint}</p></td><td class="text-xs text-stone-200">{trial.strategy_type.replace(/_/g, " ")}</td><td class="app-data max-w-xs text-[11px] text-stone-400">{Object.entries(trial.strategy_params).map(([key, value]) => `${key}=${value}`).join(", ") || "defaults"}</td><td class="app-data text-xs text-stone-200">{trial.status === "completed" ? formatCurrency(metricFromTrial(trial, "total_pnl")) : "n/a"}</td><td class="app-data text-xs text-stone-400">{trial.status === "completed" ? formatNumber(metricFromTrial(trial, "total_trades"), 0) : "n/a"}</td><td class="text-xs text-stone-500">{formatDate(trial.completed_at)}<Show when={trial.error}><p class="mt-1 max-w-xs text-red-300">{trial.error}</p></Show></td></tr>}</For></tbody></table></div>
                </Show>
              </Show>
            </section>

            <section class="grid gap-6 xl:grid-cols-[22rem_minmax(0,1fr)]">
              <div class="app-panel app-panel-section self-start">
                <h2 class="text-lg font-semibold">Finalist ranking</h2>
                <p class="mt-1 text-xs text-stone-500">Frozen validation scores only. Holdout results never rerank this list.</p>
                <Show when={(finalists() ?? []).length > 0} fallback={<p class="mt-6 text-sm text-stone-500">No frozen research finalists.</p>}>
                  <div class="mt-5 space-y-2"><For each={finalists()}>{(finalist, index) => <button type="button" onClick={() => setSelectedTrialId(finalist.trial_id)} class={`w-full rounded-sm border px-3 py-3 text-left ${selectedTrialId() === finalist.trial_id ? "border-stone-500 bg-stone-800" : "border-stone-800 bg-stone-950 hover:border-stone-700"}`}><div class="flex items-center justify-between"><span class="app-data text-xs text-stone-500">#{index() + 1}</span><span class="app-data text-sm font-semibold text-stone-100">{finalist.frozen_validation_score.toFixed(2)}</span></div><p class="app-data mt-2 truncate text-[10px] text-stone-500">{finalist.trial_id}</p><div class="mt-3 flex items-center gap-2 text-[10px] uppercase tracking-[0.12em] text-stone-400">{finalist.holdout_status === "sealed" ? <LockKeyhole size={13} /> : <ShieldCheck size={13} />} {resultOutcome(finalist)}</div></button>}</For></div>
                </Show>
              </div>

              <div class="app-panel app-panel-section min-w-0">
                <Show when={selectedTrial()} fallback={<div class="py-16 text-center text-sm text-stone-500">Select a trial or finalist to inspect its evidence.</div>}>
                  <div class="flex flex-col gap-3 border-b border-stone-800 pb-5 sm:flex-row sm:items-start sm:justify-between"><div><h2 class="text-lg font-semibold">Validation evidence</h2><p class="app-data mt-1 text-[10px] text-stone-600">{selectedTrialId()}</p></div><Show when={validation()}>{(item) => <span class={`rounded-sm border px-2.5 py-1 text-[10px] font-semibold uppercase ${item().outcome === "research_finalist" ? "border-emerald-800 bg-emerald-950/30 text-emerald-200" : "border-red-800 bg-red-950/30 text-red-200"}`}>{item().outcome.replace(/_/g, " ")} / {item().robustness_score.toFixed(2)}</span>}</Show></div>
                  <Show when={validation.error}><div class="mt-5 rounded-sm border border-red-800 bg-red-950/35 px-4 py-3 text-sm text-red-200">Validation evidence could not be loaded.</div></Show>
                  <Show when={!validation.loading && !validation.error} fallback={<Show when={!validation.error}><div class="app-skeleton mt-5 h-48" /></Show>}>
                    <Show when={validation()} fallback={<div class="mt-5 app-surface-muted px-5 py-10 text-center text-sm text-stone-500">No validation evidence is stored for this trial.</div>}>
                      {(item) => (
                        <div class="mt-5 space-y-6">
                          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><For each={Object.entries(item().score_components)}>{([key, value]) => <div class="app-surface-muted px-3 py-3"><p class="text-[10px] leading-4 text-stone-500">{key.replace(/_/g, " ")}</p><p class="app-data mt-2 text-lg font-semibold">{value.toFixed(2)}</p></div>}</For></div>
                          <div><h3 class="text-sm font-semibold">Validation gates</h3><div class="mt-3 grid gap-2 sm:grid-cols-2"><For each={Object.entries(item().gates)}>{([key, passed]) => <div class={`flex items-center gap-2 rounded-sm border px-3 py-2 text-xs ${passed ? "border-emerald-900 bg-emerald-950/20 text-emerald-200" : "border-red-900 bg-red-950/20 text-red-200"}`}>{passed ? <Check size={14} /> : <X size={14} />}{key.replace(/_/g, " ")}</div>}</For></div></div>
                          <div><h3 class="text-sm font-semibold">Walk-forward windows</h3><p class="mt-1 text-xs text-stone-500">{item().evidence.walk_forward_mode} mode. Test windows stay chronological inside validation.</p><div class="mt-3 overflow-x-auto"><table class="app-table min-w-[760px]"><thead><tr><th>Fold</th><th>Training window</th><th>Test window</th><th>Regime</th><th>Base PnL</th><th>2x cost PnL</th></tr></thead><tbody><For each={item().evidence.folds}>{(fold) => <tr><td class="app-data text-xs">{fold.fold_index}</td><td class="app-data text-[10px] text-stone-500">{formatDate(fold.train_start)}<br />{formatDate(fold.train_end)}</td><td class="app-data text-[10px] text-stone-500">{formatDate(fold.test_start)}<br />{formatDate(fold.test_end)}</td><td class="text-xs text-stone-300">{fold.regime}</td><td class="app-data text-xs">{formatCurrency(fold.cost_stresses.find((stress) => stress.cost_multiplier === 1)?.metrics.total_pnl)}</td><td class="app-data text-xs">{formatCurrency(fold.cost_stresses.find((stress) => stress.cost_multiplier === 2)?.metrics.total_pnl)}</td></tr>}</For></tbody></table></div></div>
                          <div class="grid gap-4 lg:grid-cols-2"><div class="app-surface-muted px-4 py-4"><h3 class="text-sm font-semibold">Cost stress and fragility</h3><div class="mt-4 grid grid-cols-3 gap-3"><For each={Object.entries((item().diagnostics.median_pnl_by_cost as Record<string, unknown>) ?? {})}>{([cost, value]) => <div><p class="text-[10px] text-stone-500">{cost}x median</p><p class="app-data mt-1 text-sm">{formatCurrency(value)}</p></div>}</For></div><p class="mt-4 text-xs text-stone-500">Parameter cliff: {String((item().diagnostics.parameter_sensitivity as Record<string, unknown> | undefined)?.parameter_cliff ?? "unknown")}</p></div><div class="app-surface-muted px-4 py-4"><h3 class="text-sm font-semibold">Warnings and rejection detail</h3><Show when={item().warnings.length + item().rejection_reasons.length > 0} fallback={<p class="mt-4 text-xs text-emerald-300">No warnings or rejection reasons recorded.</p>}><ul class="mt-3 space-y-2 text-xs leading-5 text-stone-400"><For each={[...item().rejection_reasons, ...item().warnings]}>{(message) => <li class="flex gap-2"><TriangleAlert class="mt-0.5 shrink-0 text-amber-500" size={13} /><span>{message}</span></li>}</For></ul></Show></div></div>
                          <Show when={selectedFinalist()}>{(finalist) => <div class="rounded-md border border-amber-800/60 bg-amber-950/15 px-4 py-4"><div class="flex items-center gap-2"><LockKeyhole size={15} class="text-amber-400" /><h3 class="text-sm font-semibold">Final holdout: {finalist().holdout_status}</h3></div><Show when={finalist().holdout_status === "evaluated"} fallback={<p class="mt-3 text-xs leading-5 text-amber-200/70">The final holdout remains sealed and excluded from discovery and ranking.</p>}><div class="mt-3 grid gap-2 sm:grid-cols-2"><p class="app-data text-xs">Outcome: {resultOutcome(finalist())}</p><p class="app-data text-xs">Base PnL: {formatCurrency(finalist().holdout_result?.base_total_pnl)}</p><p class="app-data text-xs">2x cost PnL: {formatCurrency(finalist().holdout_result?.two_x_cost_total_pnl)}</p><p class="app-data text-xs">Evaluated: {formatDate(finalist().holdout_evaluated_at)}</p></div></Show></div>}</Show>
                          <Show when={selectedFinalist()}><div class="border-t border-stone-800 pt-5"><Show when={selectedPromotion()} fallback={<div><h3 class="text-sm font-semibold">Manual candidate promotion</h3><p class="mt-1 text-xs leading-5 text-stone-500">Available because this finalist passed every validation gate and was frozen. This records a validated research candidate only.</p><textarea class="app-input mt-3 min-h-24 w-full resize-y text-sm" value={promotionReason()} onInput={(event) => setPromotionReason(event.currentTarget.value)} placeholder="State the evidence and operator judgment supporting promotion." /><div class="mt-3 flex justify-end"><button type="button" disabled={busy()} onClick={promote} class="app-button-primary gap-2 disabled:opacity-50"><ShieldCheck size={15} /> Promote manually</button></div></div>}>{(promotion) => <div class="flex items-start gap-3 rounded-sm border border-emerald-800 bg-emerald-950/20 px-4 py-3"><ShieldCheck class="mt-0.5 shrink-0 text-emerald-400" size={17} /><div><p class="text-sm font-semibold text-emerald-100">Validated research candidate</p><p class="mt-1 text-xs leading-5 text-emerald-200/70">{promotion().promotion_reason}</p><p class="app-data mt-2 text-[10px] text-emerald-300/60">{promotion().research_candidate_id} / {formatDate(promotion().promoted_at)}</p></div></div>}</Show></div></Show>
                        </div>
                      )}
                    </Show>
                  </Show>
                </Show>
              </div>
            </section>

            <section class="app-panel app-panel-section"><h2 class="text-lg font-semibold">Campaign audit</h2><div class="mt-4 grid gap-3 lg:grid-cols-2"><For each={current().audit_events}>{(event) => <div class="app-surface-muted px-4 py-3"><div class="flex items-center justify-between gap-4"><p class="text-xs font-semibold text-stone-200">{event.event_type.replace(/_/g, " ")}</p><time class="app-data text-[10px] text-stone-600">{formatDate(event.created_at)}</time></div><p class="mt-2 text-xs leading-5 text-stone-400">{event.summary}</p><p class="mt-2 text-[10px] text-stone-600">Actor: {event.actor}</p></div>}</For></div></section>
          </div>
        )}
      </Show>
    </AppShell>
  );
}
