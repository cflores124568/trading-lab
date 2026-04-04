import AppShell from "../../components/AppShell";
import BackTestConfigForm from "../../components/BackTestConfigForm";

export default function NewBacktest() {
  return (
    <AppShell
      title="New Backtest"
      subtitle="Configure your strategy and prop firm rules, then run."
    >
      <div class="mx-auto w-full max-w-2xl">
        <BackTestConfigForm />
      </div>
    </AppShell>
  );
}
