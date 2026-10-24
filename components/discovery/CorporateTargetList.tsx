"use client";

import type { NearbyCorporateResult } from "@/lib/types";
import { TIER_ALERT_LABEL } from "./CorporateProfileCard";
import { format_distance } from "@/lib/ui/ownership-labels";
import { ChevronRightIcon } from "./icons";

interface CorporateTargetListProps {
  results: NearbyCorporateResult[];
  selected_index: number;
  on_select: (index: number) => void;
  /** True when choosing a target opens the bottom sheet (below `md`). */
  opens_dialog: boolean;
  /**
   * nearby: brand name and ownership. brand: every card is the same brand, so the
   * street leads. owner: brand name with its street.
   */
  variant?: "nearby" | "brand" | "owner";
}

function street_of(address: string): string {
  return address.split(",")[0]?.trim() || address;
}

/** Tappable cards for each nearby corporate-backed storefront. */
export default function CorporateTargetList({
  results,
  selected_index,
  on_select,
  opens_dialog,
  variant = "nearby",
}: CorporateTargetListProps) {
  return (
    <nav aria-label="Nearby corporate locations">
      <ul role="list" className="space-y-2">
        {results.map((result, index) => {
          const { target, alternatives } = result;
          const is_selected = index === selected_index;
          return (
            <li key={target.location_id}>
              <button
                type="button"
                data-target-id={target.location_id}
                onClick={() => on_select(index)}
                aria-current={is_selected ? "true" : undefined}
                aria-haspopup={opens_dialog ? "dialog" : undefined}
                className={`group flex min-h-11 w-full items-center gap-3 rounded-2xl px-4 py-3.5 text-left transition-colors ${
                  is_selected && !opens_dialog
                    ? "bg-surface-raised shadow-[inset_0_0_0_1px_rgb(245_158_11/0.35)]"
                    : "bg-surface-card shadow-hairline hover:bg-surface-raised"
                }`}
              >
                <span
                  aria-hidden="true"
                  className="mt-0.5 h-2.5 w-2.5 shrink-0 rotate-45 rounded-[2px] bg-corporate-strong"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="truncate font-semibold text-zinc-50">
                      {variant === "brand" ? street_of(target.address) : target.brand_name}
                    </span>
                    {target.distance_meters !== null && (
                      <span className="shrink-0 text-xs tabular-nums text-zinc-500">{format_distance(target.distance_meters)}</span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-corporate/90">
                    {variant === "nearby" ? (
                      TIER_ALERT_LABEL[target.corporate_tier]
                    ) : (
                      <span className="text-zinc-400">
                        {variant === "brand" ? target.neighborhood : street_of(target.address)}
                      </span>
                    )}
                    <span className="text-zinc-500">
                      {variant === "brand" && !target.neighborhood ? "" : " · "}
                      {alternatives.length === 0
                        ? "no independents nearby yet"
                        : `${alternatives.length} independent ${alternatives.length === 1 ? "alternative" : "alternatives"}`}
                    </span>
                  </span>
                </span>
                <ChevronRightIcon className="h-4 w-4 shrink-0 text-zinc-600 transition-colors group-hover:text-zinc-300" />
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
