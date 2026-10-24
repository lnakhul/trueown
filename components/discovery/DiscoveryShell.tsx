import type { ReactNode } from "react";

interface DiscoveryShellProps {
  /** Search bar (sits beside the brand mark). */
  search: ReactNode;
  /** Filters and the one-line status under the search. */
  controls: ReactNode;
  map: ReactNode;
  results: ReactNode;
  footer: ReactNode;
}

function BrandMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 32 32" className="h-9 w-9 shrink-0 md:h-10 md:w-10">
      <rect x="1" y="1" width="30" height="30" rx="9" fill="#18181b" />
      <rect x="1.5" y="1.5" width="29" height="29" rx="8.5" fill="none" stroke="white" strokeOpacity="0.08" />
      <rect x="8.5" y="12" width="7" height="7" rx="1.2" transform="rotate(45 12 15.5)" fill="#fbbf24" />
      <circle cx="21" cy="17" r="3.6" fill="#34d399" />
    </svg>
  );
}

/**
 * Search-first frame. Phones: a sticky search bar, filters, then a full-bleed map
 * and the results below it. Desktop: search, filters and results in a left
 * column beside a tall sticky map.
 */
export default function DiscoveryShell({ search, controls, map, results, footer }: DiscoveryShellProps) {
  return (
    <div className="mx-auto w-full max-w-7xl pb-10 md:px-6 md:pt-6">
      <div className="discovery-grid">
        <header className="discovery-grid__header sticky top-0 z-30 border-b border-hairline bg-surface-page/85 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-xl md:static md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none">
          <h1 className="sr-only">TrueOwn: see who really owns the shops around you</h1>
          <div className="flex items-center gap-2.5">
            <a href="/" aria-label="TrueOwn home" className="shrink-0 rounded-xl">
              <BrandMark />
            </a>
            <div className="min-w-0 flex-1">{search}</div>
          </div>
        </header>
        <div className="discovery-grid__controls space-y-2 px-4 pt-3 md:px-0 md:pt-0">{controls}</div>
        <div className="discovery-grid__map">{map}</div>
        <div className="discovery-grid__results px-4 md:px-0">{results}</div>
      </div>

      <footer className="mx-4 mt-10 border-t border-hairline pt-6 md:mx-0">{footer}</footer>
    </div>
  );
}
