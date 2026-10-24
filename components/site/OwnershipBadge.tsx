import type { CorporateTier } from "@/lib/types";
import { OWNERSHIP_TAG } from "@/lib/ui/ownership-labels";

/** Amber for corporate-backed, green for independent: the same colors as the map. */
export default function OwnershipBadge({ tier, size = "sm" }: { tier: CorporateTier; size?: "sm" | "lg" }) {
  const is_independent = tier === 3;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-semibold ${
        is_independent ? "bg-independent-muted text-independent" : "bg-corporate-muted text-corporate"
      } ${size === "lg" ? "px-3 py-1 text-sm" : "px-2.5 py-0.5 text-xs"}`}
    >
      <span aria-hidden="true" className={is_independent ? "h-2 w-2 rounded-full bg-independent" : "h-2 w-2 rotate-45 rounded-[1px] bg-corporate"} />
      {OWNERSHIP_TAG[tier]}
    </span>
  );
}
