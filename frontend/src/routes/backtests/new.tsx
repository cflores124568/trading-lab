import AppShell from "../../components/AppShell";
import { A } from "@solidjs/router";
import BackTestConfigForm from "../../components/BackTestConfigForm";

export default function NewBacktest() {
  return (
    <AppShell
      title="New Backtest"
      subtitle="Configure the run in sequence, then open the saved result straight into replay."
      actions={
        <>
          <A
            href="/backtests"
            class="rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
          >
            Back to Backtests
          </A>
          <A
            href="/experiments"
            class="rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
          >
            Build Experiment
          </A>
        </>
      }
    >
      <div class="mx-auto w-full max-w-5xl">
        <BackTestConfigForm />
      </div>
    </AppShell>
  );
}
