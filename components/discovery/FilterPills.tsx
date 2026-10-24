"use client";

import { VERTICAL_LABELS } from "@/lib/catalog";
import type { CatalogResponse, IndustryVertical } from "@/lib/types";
import { ChevronDownIcon } from "./icons";
import type { DiscoveryScope } from "./use-discovery";

interface FilterPillsProps {
  catalog: CatalogResponse | null;
  scope: DiscoveryScope;
  on_change: (scope: DiscoveryScope) => void;
}

const PILL =
  "relative inline-flex min-h-11 items-center gap-1.5 rounded-full border border-hairline bg-surface-card/95 px-4 text-sm font-medium text-zinc-100 shadow-hairline backdrop-blur transition-colors focus-within:border-zinc-500 hover:border-zinc-600";
// A transparent native select covers the pill: the phone's own picker opens, and screen readers get a real select.
const NATIVE_SELECT = "absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-full opacity-0";

/** Business type and city as compact pills; changing either re-runs the current search. */
export default function FilterPills({ catalog, scope, on_change }: FilterPillsProps) {
  const verticals: IndustryVertical[] = catalog?.verticals.length ? catalog.verticals : [scope.vertical];
  const cities = catalog?.cities ?? [];
  return (
    <div className="flex gap-2 overflow-x-auto pb-0.5 scrollbar-none" role="group" aria-label="Filters">
      <label className={PILL}>
        <span>{VERTICAL_LABELS[scope.vertical]}</span>
        <ChevronDownIcon className="h-3.5 w-3.5 text-zinc-400" />
        <select
          aria-label="Type of business"
          value={scope.vertical}
          onChange={(event) => on_change({ ...scope, vertical: event.target.value as IndustryVertical })}
          className={NATIVE_SELECT}
        >
          {verticals.map((vertical) => (
            <option key={vertical} value={vertical}>
              {VERTICAL_LABELS[vertical]}
            </option>
          ))}
        </select>
      </label>
      {cities.length > 1 && (
        <label className={PILL}>
          <span>{scope.city || "All cities"}</span>
          <ChevronDownIcon className="h-3.5 w-3.5 text-zinc-400" />
          <select aria-label="City" value={scope.city} onChange={(event) => on_change({ ...scope, city: event.target.value })} className={NATIVE_SELECT}>
            <option value="">All cities</option>
            {cities.map((city) => (
              <option key={city} value={city}>
                {city}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
