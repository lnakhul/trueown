"use client";

import type { AlternativeRecommendation } from "@/lib/types";
import ProximityBadge from "./ProximityBadge";
import { NavigateIcon } from "./icons";

function build_directions_url(alternative: AlternativeRecommendation): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${alternative.latitude},${alternative.longitude}&travelmode=walking`;
}

interface AlternativeCardProps {
  alternative: AlternativeRecommendation;
  is_active: boolean;
  on_activate: (location_id: string) => void;
}

/** One independent (Tier 3) alternative with walking estimate and directions. */
export default function AlternativeCard({ alternative, is_active, on_activate }: AlternativeCardProps) {
  return (
    <article
      onMouseEnter={() => on_activate(alternative.location_id)}
      onFocusCapture={() => on_activate(alternative.location_id)}
      className={`flex h-full flex-col justify-between gap-4 rounded-2xl bg-surface-card p-4 transition-shadow duration-200 ${
        is_active ? "shadow-[inset_0_0_0_1px_rgb(52_211_153/0.45)]" : "shadow-hairline"
      }`}
    >
      <div className="space-y-3">
        <div className="flex items-start gap-2">
          <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-independent" />
          <div className="min-w-0">
            <h4 className="font-semibold leading-snug text-zinc-50">{alternative.brand_name}</h4>
            <p className="mt-0.5 line-clamp-2 text-sm text-zinc-400">
              {alternative.unique_selling_proposition ?? "Independently owned"}
            </p>
          </div>
        </div>
        <ProximityBadge distance_meters={alternative.distance_meters} />
        <p className="truncate text-xs text-zinc-500">
          {[alternative.address, alternative.neighborhood].filter(Boolean).join(" · ")}
        </p>
        <a
          href={`/claim?location=${alternative.location_id}`}
          className="inline-flex min-h-11 items-center text-xs text-zinc-500 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-200"
        >
          Own this business? Claim it
        </a>
      </div>
      <a
        href={build_directions_url(alternative)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-independent px-4 py-2.5 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-300"
      >
        <NavigateIcon />
        Navigate
        <span className="sr-only"> to {alternative.brand_name} (opens in a new tab)</span>
      </a>
    </article>
  );
}
