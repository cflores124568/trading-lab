import { A, useLocation } from "@solidjs/router";
import type { JSX } from "solid-js";
import {
  BarChart3,
  Beaker,
  CandlestickChart,
  Gauge,
  History,
  ListChecks,
  PlayCircle,
  Plus,
} from "lucide-solid";

type AppShellProps = {
  title?: string;
  subtitle?: string;
  actions?: JSX.Element;
  children: JSX.Element;
};

const navItems = [
  { href: "/", label: "Dashboard", icon: Gauge, match: "exact" },
  { href: "/replay", label: "Replay Lab", icon: PlayCircle },
  { href: "/replay-sessions", label: "Replay Sessions", icon: History },
  { href: "/backtests", label: "Backtests", icon: BarChart3 },
  { href: "/experiments", label: "Experiments", icon: Beaker },
  { href: "/candidates", label: "Candidates", icon: ListChecks },
  { href: "/paper-sessions", label: "Paper Sessions", icon: CandlestickChart },
  { href: "/backtests/new", label: "New Backtest", icon: Plus, intent: "action" },
];

export default function AppShell(props: AppShellProps) {
  const location = useLocation();

  const isActive = (href: string, match?: string) => {
    if (href === "/" || match === "exact") {
      return location.pathname === href;
    }

    if (href === "/backtests") {
      return location.pathname === href || (
        location.pathname.startsWith("/backtests/") &&
        location.pathname !== "/backtests/new"
      );
    }

    return location.pathname.startsWith(href);
  };

  return (
    <div class="min-h-screen bg-zinc-950 text-zinc-100">
      <header class="sticky top-0 z-40 border-b border-zinc-800/80 bg-zinc-950/92 backdrop-blur-xl">
        <div class="mx-auto flex max-w-7xl items-center justify-between gap-6 px-6 py-3">
          <div class="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:gap-7">
            <A
              href="/"
              class="group inline-flex items-center gap-2 text-sm font-semibold tracking-tight text-zinc-100"
            >
              <span class="flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/80 text-sky-300 transition-colors group-hover:border-zinc-700 group-hover:text-sky-200">
                <CandlestickChart size={17} />
              </span>
              <span class="leading-tight">
                Trading
                <span class="block text-zinc-400">Lab</span>
              </span>
            </A>

            <nav class="flex max-w-[calc(100vw-3rem)] flex-nowrap items-center gap-1.5 overflow-x-auto rounded-2xl border border-zinc-800/80 bg-zinc-950/80 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:max-w-none">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href, item.match);

                return (
                  <A
                    href={item.href}
                    title={item.label}
                    class={`group relative inline-flex shrink-0 items-center gap-1.5 rounded-xl px-2 py-2 text-sm font-medium transition-all duration-150 hover:-translate-y-px sm:px-2.5 ${
                      active
                        ? "bg-zinc-900 text-zinc-100 shadow-sm shadow-black/25"
                        : item.intent === "action"
                          ? "text-sky-300 hover:bg-sky-950/35 hover:text-sky-200"
                          : "text-zinc-400 hover:bg-zinc-900/80 hover:text-zinc-100"
                    }`}
                  >
                    <Icon
                      size={15}
                      class={`shrink-0 transition-colors ${
                        active
                          ? "text-sky-300"
                          : item.intent === "action"
                            ? "text-sky-300"
                            : "text-zinc-500 group-hover:text-zinc-300"
                      }`}
                    />
                    <span class="hidden sm:inline">{item.label}</span>
                    {active ? (
                      <span class="absolute inset-x-2 -bottom-1 h-px rounded-full bg-sky-300/80" />
                    ) : null}
                  </A>
                );
              })}
            </nav>
          </div>
        </div>
      </header>

      <main class="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-8">
        {(props.title || props.subtitle || props.actions) && (
          <div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div class="space-y-2">
              {props.title && <h1 class="text-3xl font-semibold tracking-tight">{props.title}</h1>}
              {props.subtitle && <p class="max-w-3xl text-sm text-zinc-400">{props.subtitle}</p>}
            </div>

            {props.actions && (
              <div class="flex flex-wrap items-center gap-3 lg:justify-end">{props.actions}</div>
            )}
          </div>
        )}

        {props.children}
      </main>
    </div>
  );
}
