import type { ReactNode } from "react";

interface DiscoveryShellProps {
  controls: ReactNode;
  map: ReactNode;
  results: ReactNode;
  footer: ReactNode;
}

/** Page frame: brand header, then controls / map / results in a responsive grid. */
export default function DiscoveryShell({ controls, map, results, footer }: DiscoveryShellProps) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-10 pt-6 sm:px-6 md:pt-10">
      <header className="mb-6 flex items-center gap-3 md:mb-8">
        <svg aria-hidden="true" viewBox="0 0 32 32" className="h-8 w-8 shrink-0">
          <rect x="1" y="1" width="30" height="30" rx="9" fill="#18181b" />
          <rect x="1.5" y="1.5" width="29" height="29" rx="8.5" fill="none" stroke="white" strokeOpacity="0.08" />
          <rect x="8.5" y="12" width="7" height="7" rx="1.2" transform="rotate(45 12 15.5)" fill="#fbbf24" />
          <circle cx="21" cy="17" r="3.6" fill="#34d399" />
        </svg>
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-50">TrueOwn</h1>
          <p className="text-sm text-zinc-400">See who really owns the shops around you — and keep it local.</p>
        </div>
      </header>

      <div className="discovery-grid">
        <div className="discovery-grid__controls space-y-4">{controls}</div>
        <div className="discovery-grid__map">{map}</div>
        <div className="discovery-grid__results">{results}</div>
      </div>

      <footer className="mt-10 border-t border-hairline pt-6">{footer}</footer>
    </div>
  );
}
