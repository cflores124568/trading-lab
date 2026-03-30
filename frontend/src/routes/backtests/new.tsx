import BackTestConfigForm from "../../components/BackTestConfigForm";

export default function NewBacktest() {
  return (
    <div class="min-h-screen bg-zinc-950 text-zinc-100">
      <div class="max-w-2xl mx-auto px-6 py-10">
        <div class="mb-8">
          <h1 class="text-2xl font-bold tracking-tight">New Backtest</h1>
          <p class="text-zinc-400 mt-1 text-sm">
            Configure your strategy and prop firm rules, then run.
          </p>
        </div>
        <BackTestConfigForm />
      </div>
    </div>
  );
}