import { A, useLocation } from "@solidjs/router";
import { AlertTriangle, Gauge, RotateCw } from "lucide-solid";
import { ErrorBoundary, createEffect, on, type JSX } from "solid-js";

import AppShell from "./AppShell";
import EmptyState from "./EmptyState";

// Without this, a failed API call that a page doesn't handle itself leaves a
// blank screen. Catch it, say what happened, and clear it on the next navigation.
export default function RouteErrorBoundary(props: { children?: JSX.Element }) {
  const location = useLocation();

  return (
    <ErrorBoundary
      fallback={(error, reset) => {
        createEffect(on(() => location.pathname, () => reset(), { defer: true }));

        const message = error instanceof Error ? error.message : String(error);

        return (
          <AppShell title="Something went wrong">
            <div class="mx-auto w-full max-w-5xl">
              <EmptyState
                tone="error"
                icon={<AlertTriangle size={18} />}
                title="This page couldn't load"
                description={
                  <>
                    <p>
                      The server may be restarting or unreachable. Try again in a moment. Your saved work is
                      still stored on the server.
                    </p>
                    <p class="mt-3 rounded-xl border border-stone-800 bg-stone-950 px-3 py-2 font-mono text-xs text-red-200">
                      {message}
                    </p>
                  </>
                }
                actions={
                  <>
                    <button type="button" class="app-button-primary gap-2" onClick={() => window.location.reload()}>
                      <RotateCw size={16} />
                      Try Again
                    </button>
                    <A href="/" class="app-button-secondary gap-2">
                      <Gauge size={16} />
                      Go to Dashboard
                    </A>
                  </>
                }
              />
            </div>
          </AppShell>
        );
      }}
    >
      {props.children}
    </ErrorBoundary>
  );
}
