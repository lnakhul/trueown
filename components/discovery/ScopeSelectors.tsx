"use client";

import { VERTICAL_LABELS } from "@/lib/catalog";
import type { CatalogResponse, IndustryVertical } from "@/lib/types";
import type { DiscoveryScope } from "./use-discovery";

interface ScopeSelectorsProps {
  catalog: CatalogResponse;
  scope: DiscoveryScope;
  on_change: (scope: DiscoveryScope) => void;
}

const SELECT_CLASSES =
  "mt-1.5 min-h-11 w-full appearance-none rounded-xl border border-hairline bg-surface-card bg-[length:16px] bg-[right_0.75rem_center] bg-no-repeat px-3 py-2 pr-9 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-500";

// A small chevron drawn as a data URI, since `appearance-none` hides the native one.
const SELECT_CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E\")";

/** City + business-type selectors; changing either re-runs the current search. */
export default function ScopeSelectors({ catalog, scope, on_change }: ScopeSelectorsProps) {
  return (
    <form
      aria-label="Narrow results"
      onSubmit={(event) => event.preventDefault()}
      className="grid grid-cols-2 gap-3"
    >
      <label className="block text-xs font-medium uppercase tracking-wider text-zinc-500">
        City
        <select
          value={scope.city}
          onChange={(event) => on_change({ ...scope, city: event.target.value })}
          className={SELECT_CLASSES}
          style={{ backgroundImage: SELECT_CHEVRON }}
        >
          <option value="">All cities</option>
          {catalog.cities.map((city) => (
            <option key={city} value={city}>
              {city}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-xs font-medium uppercase tracking-wider text-zinc-500">
        Type of business
        <select
          value={scope.vertical}
          onChange={(event) => on_change({ ...scope, vertical: event.target.value as IndustryVertical })}
          className={SELECT_CLASSES}
          style={{ backgroundImage: SELECT_CHEVRON }}
        >
          {catalog.verticals.map((vertical) => (
            <option key={vertical} value={vertical}>
              {VERTICAL_LABELS[vertical]}
            </option>
          ))}
        </select>
      </label>
    </form>
  );
}
