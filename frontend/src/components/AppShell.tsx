import { A, useLocation } from "@solidjs/router";
import { createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import {
  BarChart3,
  Beaker,
  FlaskConical,
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
  mainClass?: string;
  children: JSX.Element;
};

const navItems = [
  { href: "/", label: "Dashboard", icon: Gauge, match: "exact" },
  { href: "/replay", label: "Replay Lab", icon: PlayCircle },
  { href: "/replay-sessions", label: "Replay Sessions", icon: History },
  { href: "/backtests", label: "Backtests", icon: BarChart3 },
  { href: "/experiments", label: "Experiments", icon: Beaker },
  { href: "/alpha-lab", label: "Alpha Lab", icon: FlaskConical },
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

    return location.pathname === href || location.pathname.startsWith(`${href}/`);
  };

  let navRef: HTMLElement | undefined;
  const [navClipped, setNavClipped] = createSignal(false);

  const measureNav = () => {
    if (!navRef) return;
    setNavClipped(navRef.scrollLeft + navRef.clientWidth < navRef.scrollWidth - 1);
  };

  onMount(() => {
    measureNav();
    window.addEventListener("resize", measureNav);
    onCleanup(() => window.removeEventListener("resize", measureNav));
  });

  // On narrow screens the nav scrolls sideways, so keep the current page's tab in view.
  createEffect(() => {
    location.pathname;
    queueMicrotask(() => {
      navRef
        ?.querySelector<HTMLElement>("[data-active]")
        ?.scrollIntoView({ block: "nearest", inline: "center" });
      measureNav();
    });
  });

  return (
    <div class="flex min-h-screen flex-col bg-stone-950 text-stone-100">
      <a
        href="#main-content"
        class="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-stone-100 focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-stone-950"
      >
        Skip to content
      </a>
      <header class="sticky top-0 z-40 border-b border-stone-800/80 bg-stone-950/92 backdrop-blur-xl">
        <div class="mx-auto flex max-w-screen-2xl items-center justify-between gap-6 px-4 py-3 sm:px-6">
          <div class="flex min-w-0 flex-1 flex-col gap-3 xl:flex-row xl:items-center xl:gap-6">
            <A
              href="/"
              class="group inline-flex shrink-0 items-center gap-2 text-sm font-semibold text-stone-100"
            >
              <span class="flex h-8 w-8 items-center justify-center rounded-md border border-stone-800 bg-stone-900/80 text-stone-100 transition-colors group-hover:border-stone-700 group-hover:text-stone-50">
                <CandlestickChart size={17} />
              </span>
              <span class="app-brand whitespace-nowrap text-lg leading-none text-stone-100">Trading Lab</span>
            </A>

            <nav
              ref={navRef}
              aria-label="Main"
              onScroll={measureNav}
              class={`flex min-w-0 flex-nowrap items-center gap-1 overflow-x-auto rounded-md border border-stone-800/80 bg-stone-950/80 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
                navClipped() ? "[mask-image:linear-gradient(to_right,black_calc(100%-3rem),transparent)]" : ""
              }`}
            >
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href, item.match);

                return (
                  <A
                    href={item.href}
                    data-active={active ? "" : undefined}
                    class={`group relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 py-2 text-sm font-medium transition-colors duration-150 ${
                      active
                        ? "bg-stone-900 text-stone-100 shadow-sm shadow-black/25"
                        : item.intent === "action"
                          ? "text-stone-100 hover:bg-stone-800/60 hover:text-stone-50"
                          : "text-stone-400 hover:bg-stone-900/80 hover:text-stone-100"
                    }`}
                  >
                    <Icon
                      size={15}
                      class={`shrink-0 transition-colors xl:hidden 2xl:block ${
                        active
                          ? "text-stone-100"
                          : item.intent === "action"
                            ? "text-stone-200"
                            : "text-stone-500 group-hover:text-stone-300"
                      }`}
                    />
                    <span>{item.label}</span>
                    {active ? (
                      <span class="absolute inset-x-2 -bottom-1 h-px rounded-full bg-stone-200/80" />
                    ) : null}
                  </A>
                );
              })}
            </nav>
          </div>
        </div>
      </header>

      <main
        id="main-content"
        tabindex="-1"
        class={`mx-auto flex min-h-0 w-full flex-1 min-w-0 max-w-screen-2xl flex-col gap-6 overflow-x-hidden px-4 py-6 outline-none sm:px-6 sm:py-8 ${
          props.mainClass ?? ""
        }`}
      >
        {(props.title || props.subtitle || props.actions) && (
          <div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div class="space-y-2">
              {props.title && <h1 class="text-3xl font-semibold tracking-tight">{props.title}</h1>}
              {props.subtitle && <p class="max-w-3xl text-sm text-stone-400">{props.subtitle}</p>}
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
