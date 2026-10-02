export default function DataLoadError(props: { title: string; error: unknown; onRetry: () => unknown }) {
  return (
    <div role="alert" class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-900/70 bg-red-950/20 p-4">
      <div class="min-w-0"><p class="text-sm font-semibold text-red-200">{props.title}</p>
        <p class="mt-1 break-words text-xs text-stone-400">{props.error instanceof Error ? props.error.message : "The service is unavailable. Try again in a moment."}</p>
      </div>
      <button type="button" class="app-button-compact-secondary" onClick={() => props.onRetry()}>Try again</button>
    </div>
  );
}
