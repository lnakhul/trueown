import type { ReactNode } from "react";
import BrandMark from "@/components/site/BrandMark";
import SiteMenu from "@/components/site/SiteMenu";

interface DiscoveryShellProps {
  /** Search bar (sits beside the brand mark). */
  search: ReactNode;
  /** Filters and the one-line status under the search. */
  controls: ReactNode;
  map: ReactNode;
  results: ReactNode;
}

/**
 * Search-first frame. Phones: a sticky search bar, filters, then a full-bleed map
 * and the results below it. Desktop: search, filters and results in a left
 * column beside a tall sticky map. The logo opens the site menu.
 */
export default function DiscoveryShell({ search, controls, map, results }: DiscoveryShellProps) {
  return (
    <div className="mx-auto w-full max-w-7xl pb-10 md:px-6 md:pt-6">
      <div className="discovery-grid">
        <header className="discovery-grid__header sticky top-0 z-30 border-b border-hairline bg-surface-page/85 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-xl md:static md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none">
          <h1 className="sr-only">TrueOwn: see who really owns the shops around you</h1>
          <div className="flex items-center gap-2">
            <SiteMenu align="left" label="TrueOwn menu" className="-ml-1 shrink-0">
              <BrandMark className="h-9 w-9 md:h-10 md:w-10" />
            </SiteMenu>
            <div className="min-w-0 flex-1">{search}</div>
          </div>
        </header>
        <div className="discovery-grid__controls space-y-2 px-4 pt-3 md:px-0 md:pt-0">{controls}</div>
        <div className="discovery-grid__map">{map}</div>
        <div className="discovery-grid__results px-4 md:px-0">{results}</div>
      </div>
    </div>
  );
}
