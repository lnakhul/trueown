"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  CorrectionForm,
  ReverifyForm,
  TIER_LABELS,
  input_classes,
  post_json,
  type CorrectionBody,
  type ReverifyBody,
} from "@/components/AdminBrandForms";
import type { BrandForReview, BrandReviewFilter } from "@/lib/db/brands";
import { format_verified_month, provenance_status, source_type_label, type ProvenanceStatus } from "@/lib/provenance";
import type { IndustryVertical } from "@/lib/types";

const VERTICAL_LABELS: Record<IndustryVertical, string> = {
  coffee_bakery: "Coffee & Bakery",
  restaurant: "Restaurant",
  bar_nightlife: "Bar & Nightlife",
  retail_boutique: "Retail Boutique",
  fitness_wellness: "Fitness & Wellness",
};

const STATUS_BADGES: Record<ProvenanceStatus, { label: string; classes: string }> = {
  missing: { label: "No source", classes: "bg-red-500/10 text-red-300" },
  stale: { label: "Over a year old", classes: "bg-corporate-muted text-corporate" },
  current: { label: "Current", classes: "bg-independent-muted text-independent" },
};

const ACTION_LABELS: Record<string, string> = {
  approve: "Approved",
  reject: "Rejected",
  reverify: "Re-verified",
  correct: "Corrected",
};

type Panel = "none" | "reverify" | "correct";

function BrandCard({ brand }: { brand: BrandForReview }) {
  const router = useRouter();
  const [panel, set_panel] = useState<Panel>("none");
  const [saved_message, set_saved_message] = useState<string | null>(null);

  const status = provenance_status(brand.source);
  const badge = STATUS_BADGES[status];

  function open_panel(next: Panel): void {
    set_panel((current) => (current === next ? "none" : next));
    set_saved_message(null);
  }

  async function save(action: "reverify" | "correct", body: ReverifyBody | CorrectionBody): Promise<string | null> {
    const failure = await post_json(`/api/admin/brands/${brand.id}/${action}`, body);
    if (failure) return failure;
    set_panel("none");
    set_saved_message(action === "reverify" ? "Re-verified." : "Correction saved.");
    router.refresh();
    return null;
  }

  return (
    <li className="space-y-4 rounded-xl border border-hairline bg-surface-card p-5 shadow-hairline">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-zinc-50">{brand.name}</h2>
          <p className="text-sm text-zinc-400">
            {TIER_LABELS[brand.corporate_tier]} · {VERTICAL_LABELS[brand.industry_vertical]} ·{" "}
            {brand.storefront_count} storefront{brand.storefront_count === 1 ? "" : "s"}
            {brand.market_names.length > 0 && ` in ${brand.market_names.join(", ")}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {brand.open_reports > 0 && (
            <Link
              href="/admin/corrections"
              className="rounded-full bg-red-500/10 px-2.5 py-0.5 text-xs font-semibold text-red-300 underline-offset-2 hover:underline"
            >
              {brand.open_reports} open error report{brand.open_reports === 1 ? "" : "s"}
            </Link>
          )}
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${badge.classes}`}>{badge.label}</span>
        </div>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-hairline pt-3 text-sm">
        {brand.corporate_tier !== 3 && (
          <>
            <dt className="text-zinc-500">Owner</dt>
            <dd className="text-zinc-200">{brand.parent_entity}</dd>
            <dt className="text-zinc-500">Backers</dt>
            <dd className="text-zinc-200">{brand.financial_backers.join(", ") || "None recorded"}</dd>
          </>
        )}
        <dt className="text-zinc-500">Source</dt>
        <dd className="min-w-0 text-zinc-200">
          {brand.source ? (
            <>
              {source_type_label(brand.source.source_type)} · verified {format_verified_month(brand.source.verified_on)}
              <a
                href={brand.source.source_url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="block break-all text-sky-300 underline underline-offset-2"
              >
                {brand.source.source_url}
              </a>
            </>
          ) : (
            <span className="text-red-300">No source recorded</span>
          )}
        </dd>
        {brand.last_action && (
          <>
            <dt className="text-zinc-500">Last change</dt>
            <dd className="text-zinc-400">
              {ACTION_LABELS[brand.last_action.action] ?? brand.last_action.action} by{" "}
              {brand.last_action.actor_email ?? "unknown"} ·{" "}
              <time dateTime={brand.last_action.at}>{new Date(brand.last_action.at).toLocaleDateString()}</time>
            </dd>
          </>
        )}
      </dl>

      {saved_message && (
        <p role="status" className="rounded-lg bg-independent-muted px-3 py-2 text-sm text-independent">
          {saved_message}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => open_panel("reverify")}
          aria-expanded={panel === "reverify"}
          className="min-h-11 rounded-lg bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-white"
        >
          Re-verify
        </button>
        <button
          type="button"
          onClick={() => open_panel("correct")}
          aria-expanded={panel === "correct"}
          className="min-h-11 rounded-lg border border-hairline px-4 py-2 text-sm font-semibold text-zinc-200 transition-colors hover:border-zinc-500"
        >
          Correct claim
        </button>
      </div>

      {panel === "reverify" && (
        <ReverifyForm
          corporate_tier={brand.corporate_tier}
          initial_source_type={brand.source?.source_type ?? ""}
          initial_source_url={brand.source?.source_url ?? ""}
          intro="The claim stays as is. Record the evidence you just checked; the verified date becomes today."
          submit_label="Save re-verification"
          on_submit={(body) => save("reverify", body)}
        />
      )}

      {panel === "correct" && (
        <CorrectionForm
          initial={{
            corporate_tier: brand.corporate_tier,
            parent_entity: brand.parent_entity,
            financial_backers: brand.financial_backers,
          }}
          intro="Use this when ownership changed (for example a PE exit or a new buyer). A correction needs new evidence and a reason."
          submit_label="Save correction"
          on_submit={(body) => save("correct", body)}
        />
      )}
    </li>
  );
}

export interface AdminBrandReviewProps {
  brands: BrandForReview[];
  filter: BrandReviewFilter;
  search: string;
}

export default function AdminBrandReview({ brands, filter, search }: AdminBrandReviewProps) {
  const filters: { id: BrandReviewFilter; label: string }[] = [
    { id: "needs_review", label: "Needs review" },
    { id: "all", label: "All brands" },
  ];
  const query = (next_filter: BrandReviewFilter) =>
    `/admin/brands?filter=${next_filter}${search ? `&q=${encodeURIComponent(search)}` : ""}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-2">
          {filters.map((option) => (
            <Link
              key={option.id}
              href={query(option.id)}
              aria-current={option.id === filter ? "page" : undefined}
              className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium transition-colors ${
                option.id === filter
                  ? "border-zinc-100 bg-zinc-100 text-zinc-950"
                  : "border-hairline bg-surface-card text-zinc-300 hover:border-zinc-500"
              }`}
            >
              {option.label}
            </Link>
          ))}
        </div>
        <form action="/admin/brands" method="get" role="search" className="flex gap-2">
          <input type="hidden" name="filter" value={filter} />
          <input
            name="q"
            defaultValue={search}
            maxLength={100}
            aria-label="Search brands by name"
            placeholder="Search brands"
            className={`${input_classes} min-h-11`}
          />
          <button
            type="submit"
            className="min-h-11 shrink-0 rounded-lg border border-hairline px-4 text-sm font-semibold text-zinc-200 hover:border-zinc-500"
          >
            Search
          </button>
        </form>
      </div>

      {brands.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-700 px-4 py-10 text-center text-sm text-zinc-400">
          {filter === "needs_review"
            ? "Every claim has a source verified within the last year."
            : "No brands match."}
        </p>
      ) : (
        <ul className="space-y-4">
          {brands.map((brand) => (
            <BrandCard key={`${brand.id}:${brand.source?.verified_on ?? ""}:${brand.corporate_tier}`} brand={brand} />
          ))}
        </ul>
      )}
    </div>
  );
}
