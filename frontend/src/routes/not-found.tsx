import { A, useLocation } from "@solidjs/router";
import { BarChart3, Compass, Gauge } from "lucide-solid";

import AppShell from "../components/AppShell";
import EmptyState from "../components/EmptyState";

export default function NotFoundPage() {
  const location = useLocation();

  return (
    <AppShell title="Page not found">
      <div class="mx-auto w-full max-w-5xl">
        <EmptyState
          icon={<Compass size={18} />}
          title="Nothing lives at this address"
          description={
            <>
              <span class="app-data text-stone-300">{location.pathname}</span> isn't a page in Trading Lab.
              The link may be old, or the saved run it pointed to may have been removed.
            </>
          }
          actions={
            <>
              <A href="/" class="app-button-primary gap-2">
                <Gauge size={16} />
                Go to Dashboard
              </A>
              <A href="/backtests" class="app-button-secondary gap-2">
                <BarChart3 size={16} />
                Saved Backtests
              </A>
            </>
          }
        />
      </div>
    </AppShell>
  );
}
