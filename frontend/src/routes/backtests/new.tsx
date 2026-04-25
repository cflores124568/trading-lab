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
            class="app-button-secondary"
          >
            Back to Backtests
          </A>
          <A
            href="/experiments"
            class="app-button-secondary"
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
