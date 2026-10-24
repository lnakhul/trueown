import Link from "next/link";
import { format_verified_month, provenance_status, source_type_label } from "@/lib/provenance";
import type { CorporateTarget } from "@/lib/types";
import { AlertIcon } from "./icons";

export const TIER_ALERT_LABEL: Record<1 | 2, string> = {
  1: "Private Equity Owned",
  2: "Venture Capital Funded",
};

interface CorporateProfileCardProps {
  target: CorporateTarget;
  /** "summary" drops the brand heading (the bottom sheet shows it in its title bar). */
  variant?: "full" | "summary";
  /** Opens the "Report an error" form for this listing. */
  on_report_error?: () => void;
}

/** Ownership profile for a corporate-backed storefront. Wording stays factual. */
export default function CorporateProfileCard({ target, variant = "full", on_report_error }: CorporateProfileCardProps) {
  const source = target.ownership_source ?? null;
  const status = provenance_status(source);
  return (
    <section className="overflow-hidden rounded-2xl bg-surface-card shadow-hairline">
      <div role="note" className="flex items-center gap-2 bg-corporate-muted px-4 py-2.5 text-corporate">
        <AlertIcon />
        <p className="text-xs font-semibold uppercase tracking-wider">
          {TIER_ALERT_LABEL[target.corporate_tier]}
        </p>
      </div>
      <div className={`space-y-3 px-4 ${variant === "full" ? "py-4" : "py-3"}`}>
        {variant === "full" && (
          <div className="space-y-1">
            <h2 className="text-xl font-semibold tracking-tight text-zinc-50">{target.brand_name}</h2>
            <p className="text-sm text-zinc-400">
              {[target.address, target.neighborhood].filter(Boolean).join(" · ")}
              {target.distance_meters !== null && (
                <span className="text-zinc-500"> · {target.distance_meters}m from you</span>
              )}
            </p>
          </div>
        )}
        <dl
          className={`grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm ${
            variant === "full" ? "border-t border-hairline pt-3" : ""
          }`}
        >
          <dt className="text-zinc-500">Ownership</dt>
          <dd className="text-zinc-200">
            <span className="font-medium">{target.parent_entity}</span>{" "}
            <span className="text-zinc-500">(Tier {target.corporate_tier})</span>
          </dd>
          {target.financial_backers.length > 0 && (
            <>
              <dt className="text-zinc-500">Backed by</dt>
              <dd className="font-medium text-zinc-200">{target.financial_backers.join(", ")}</dd>
            </>
          )}
          <dt className="text-zinc-500">Source</dt>
          <dd className="min-w-0 text-zinc-300">
            {source ? (
              <>
                <a
                  href={source.source_url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="font-medium text-zinc-100 underline decoration-zinc-600 underline-offset-2 hover:decoration-zinc-300"
                >
                  {source_type_label(source.source_type)}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
                <span className="text-zinc-500"> · verified {format_verified_month(source.verified_on)}</span>
                {status === "stale" && (
                  <span className="block text-xs text-zinc-500">
                    Last checked over a year ago; ownership may have changed since.
                  </span>
                )}
              </>
            ) : (
              <span className="text-zinc-500">Not yet recorded</span>
            )}
          </dd>
        </dl>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-hairline pt-2 text-xs">
          <Link
            href={`/brands/${target.brand_slug}`}
            className="inline-flex min-h-11 items-center font-semibold text-zinc-100 underline decoration-zinc-600 underline-offset-2 hover:decoration-zinc-300"
          >
            Full ownership profile
          </Link>
          {on_report_error && (
            <button
              type="button"
              onClick={on_report_error}
              className="inline-flex min-h-11 items-center font-medium text-zinc-400 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-100"
            >
              Report an error
            </button>
          )}
          <Link
            href="/how-we-classify"
            className="inline-flex min-h-11 items-center font-medium text-zinc-400 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-100"
          >
            How we classify
          </Link>
        </div>
      </div>
    </section>
  );
}
