import { A } from "@solidjs/router";
import AppShell from "../../components/AppShell";

const steps = [
  ["1", "Run an experiment", "Use Experiments to test a strategy configuration, then promote the run you want to evaluate."],
  ["2", "Prepare the candidate", "Open the promoted candidate, create its paper-bot draft, and mark the draft ready."],
  ["3", "Create the session", "Create the candidate's one durable paper session and open its runtime page."],
  ["4", "Start in Shadow", "Select Shadow, choose a historical date window, and start the runner without executing proposed orders."],
] as const;

const modes = [
  ["Shadow", "Records decisions and builds the scorecard. It never executes proposed orders."],
  ["Approval Required", "Pauses before position-changing actions until you approve or reject the durable decision."],
  ["Autonomous Paper", "Runs eligible simulated actions through pre-trade risk. It still cannot place real orders."],
] as const;

export default function PaperTradingGuidePage() {
  return (
    <AppShell
      title="Paper Trading Guide"
      subtitle="The operating path from an experiment result to a durable paper session."
      actions={
        <>
          <A
            href="/paper-sessions"
            class="rounded-sm border border-stone-700 px-4 py-2 text-sm font-medium text-stone-200 transition-colors hover:border-stone-500 hover:bg-stone-900"
          >
            Paper Sessions
          </A>
          <A
            href="/candidates"
            class="rounded-sm bg-stone-100 px-4 py-2 text-sm font-semibold text-stone-950 transition-colors hover:bg-white"
          >
            Candidate Registry
          </A>
        </>
      }
    >
      <div class="mx-auto w-full max-w-5xl space-y-6">
        <section class="app-panel app-panel-section space-y-5">
          <div>
            <p class="app-kicker">Required workflow</p>
            <h2 class="mt-2 text-xl font-semibold text-stone-100">
              Experiment → candidate → paper session
            </h2>
            <p class="mt-2 max-w-3xl text-sm leading-6 text-stone-400">
              Paper sessions are deliberately attached to promoted candidates. A normal saved backtest does not create one, and each candidate currently has at most one session.
            </p>
          </div>

          <div class="grid gap-3 md:grid-cols-2">
            {steps.map(([number, title, body]) => (
              <article class="app-subpanel flex gap-4 px-4 py-4">
                <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-stone-700 bg-stone-900 font-mono text-xs text-stone-200">
                  {number}
                </span>
                <div>
                  <h3 class="text-sm font-semibold text-stone-100">{title}</h3>
                  <p class="mt-1 text-sm leading-6 text-stone-400">{body}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section class="app-panel app-panel-section space-y-4">
          <div>
            <p class="app-kicker">Policy modes</p>
            <h2 class="mt-2 text-xl font-semibold text-stone-100">Choose how decisions are handled</h2>
          </div>
          <div class="grid gap-3 lg:grid-cols-3">
            {modes.map(([title, body], index) => (
              <article class="app-subpanel px-4 py-4">
                <p class={`text-sm font-semibold ${index === 0 ? "text-green-200" : index === 1 ? "text-amber-200" : "text-violet-200"}`}>
                  {title}
                </p>
                <p class="mt-2 text-sm leading-6 text-stone-400">{body}</p>
              </article>
            ))}
          </div>
          <p class="rounded-md border border-green-900/70 bg-green-950/20 px-4 py-3 text-sm text-green-100">
            Start every unfamiliar candidate in Shadow mode. It gives you a decision trace and scorecard without simulated execution.
          </p>
        </section>

        <section class="grid gap-6 lg:grid-cols-2">
          <article class="app-panel app-panel-section space-y-3">
            <p class="app-kicker">Finding sessions</p>
            <h2 class="text-lg font-semibold text-stone-100">Use Paper Sessions as the operating index</h2>
            <p class="text-sm leading-6 text-stone-400">
              A running session shows status <span class="font-mono text-stone-200">running</span> and runner health <span class="font-mono text-stone-200">healthy</span>. Paused sessions retain their cursor, decisions, positions, and scorecards without advancing.
            </p>
          </article>

          <article class="app-panel app-panel-section space-y-3">
            <p class="app-kicker">Safe shutdown</p>
            <h2 class="text-lg font-semibold text-stone-100">Pause before quitting Docker</h2>
            <p class="text-sm leading-6 text-stone-400">
              PostgreSQL preserves sessions when Docker stops. A session left running may resume when the worker returns, so pause it first. Never remove the Docker volume unless you intend to erase local state.
            </p>
          </article>
        </section>

        <section class="app-panel app-panel-section space-y-3">
          <p class="app-kicker">Current boundary</p>
          <h2 class="text-lg font-semibold text-stone-100">Historical paper execution, not live trading</h2>
          <p class="max-w-4xl text-sm leading-6 text-stone-400">
            The current runner replays database-backed historical candles with a synthetic book. MCP can inspect state and add audited notes. Databento MBP-1 intake, live exchange display, brokerage connectivity, and real-money orders are not available yet.
          </p>
          <p class="text-xs text-stone-500">
            The complete startup, persistence, status, MCP, and troubleshooting reference is in <code>docs/PAPER_TRADING_GUIDE.md</code>.
          </p>
        </section>
      </div>
    </AppShell>
  );
}
