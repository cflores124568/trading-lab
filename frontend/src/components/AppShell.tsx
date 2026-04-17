import { A, useLocation } from "@solidjs/router";
import type { JSX } from "solid-js";

type AppShellProps = {
  title?: string;
  subtitle?: string;
  actions?: JSX.Element;
  children: JSX.Element;
};

const navItems = [
  { href: "/", label: "Dashboard" },
  { href: "/replay", label: "Replay Lab" },
  { href: "/replay-sessions", label: "Replay Sessions" },
  { href: "/backtests", label: "Backtests" },
  { href: "/experiments", label: "Experiments" },
  { href: "/candidates", label: "Candidates" },
  { href: "/paper-sessions", label: "Paper Sessions" },
  { href: "/backtests/new", label: "New Backtest" },
];

export default function AppShell(props: AppShellProps) {
  const location = useLocation();

  const isActive = (href: string) =>
    href === "/" ? location.pathname === "/" : location.pathname.startsWith(href);

  return (
    <div class="min-h-screen bg-zinc-950 text-zinc-100">
      <header class="border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <div class="mx-auto flex max-w-7xl items-center justify-between gap-6 px-6 py-4">
          <div class="flex items-center gap-8">
            <A href="/" class="text-sm font-semibold tracking-tight text-zinc-100">
              Trading Lab
            </A>

            <nav class="flex flex-wrap items-center gap-2">
              {navItems.map((item) => (
                <A
                  href={item.href}
                  class={`rounded-full px-3 py-2 text-sm font-medium transition-colors ${
                    isActive(item.href)
                      ? "bg-zinc-100 text-zinc-950"
                      : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
                  }`}
                >
                  {item.label}
                </A>
              ))}
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
