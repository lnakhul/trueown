"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import type { BrandForReview, BrandReviewFilter } from "@/lib/db/brands";
import {
  SOURCE_TYPE_LABELS,
  format_verified_month,
  provenance_status,
  source_type_label,
  source_types_for_tier,
  type OwnershipSourceType,
  type ProvenanceStatus,
} from "@/lib/provenance";
import type { ApiErrorResponse, IndustryVertical } from "@/lib/types";

const VERTICAL_LABELS: Record<IndustryVertical, string> = {
  coffee_bakery: "Coffee & Bakery",
  restaurant: "Restaurant",
  bar_nightlife: "Bar & Nightlife",
  retail_boutique: "Retail Boutique",
  fitness_wellness: "Fitness & Wellness",
};

const TIER_LABELS: Record<1 | 2 | 3, string> = {
  1: "Tier 1 · PE owned",
  2: "Tier 2 · VC funded",
  3: "Tier 3 · Independent",
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

const input_classes =
  "w-full rounded-lg border border-hairline bg-surface-page px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-500";
const label_classes = "text-xs font-medium text-zinc-400";

async function post_json(url: string, body: unknown): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return null;
    const failure = (await response.json().catch(() => null)) as ApiErrorResponse | null;
    return failure?.error ?? `Request failed (${response.status}).`;
  } catch {
    return "Network error. Try again.";
  }
}

function SourceTypeSelect({
  corporate_tier,
  value,
  on_change,
}: {
  corporate_tier: 1 | 2 | 3;
  value: string;
  on_change: (value: OwnershipSourceType | "") => void;
}) {
  return (
    <select
      className={`${input_classes} mt-1`}
      value={value}
      onChange={(event) => on_change(event.target.value as OwnershipSourceType)}
      required
    >
      <option value="" disabled>
        Choose a source type…
      </option>
      {source_types_for_tier(corporate_tier).map((source_type) => (
        <option key={source_type} value={source_type}>
          {SOURCE_TYPE_LABELS[source_type]}
        </option>
      ))}
    </select>
  );
}

type Panel = "none" | "reverify" | "correct";

function BrandCard({ brand }: { brand: BrandForReview }) {
  const router = useRouter();
  const [panel, set_panel] = useState<Panel>("none");
  const [is_busy, set_is_busy] = useState(false);
  const [error_message, set_error_message] = useState<string | null>(null);
  const [saved_message, set_saved_message] = useState<string | null>(null);

  // Re-verify fields (start from the current evidence, which is often just re-checked).
  const fits_current = (source_types_for_tier(brand.corporate_tier) as readonly string[]).includes(
    brand.source?.source_type ?? "",
  );
  const [reverify_type, set_reverify_type] = useState<string>(fits_current ? brand.source!.source_type : "");
  const [reverify_url, set_reverify_url] = useState(brand.source?.source_url ?? "");

  // Correction fields.
  const [tier, set_tier] = useState<1 | 2 | 3>(brand.corporate_tier);
  const [parent_entity, set_parent_entity] = useState(brand.parent_entity ?? "");
  const [backers, set_backers] = useState(brand.financial_backers.join(", "));
  const [correct_type, set_correct_type] = useState<string>("");
  const [correct_url, set_correct_url] = useState("");
  const [review_note, set_review_note] = useState("");

  const status = provenance_status(brand.source);
  const badge = STATUS_BADGES[status];

  function open_panel(next: Panel): void {
    set_panel((current) => (current === next ? "none" : next));
    set_error_message(null);
    set_saved_message(null);
  }

  function change_tier(next: 1 | 2 | 3): void {
    set_tier(next);
    if (!(source_types_for_tier(next) as readonly string[]).includes(correct_type)) set_correct_type("");
  }

  async function submit(event: FormEvent<HTMLFormElement>, action: "reverify" | "correct"): Promise<void> {
    event.preventDefault();
    set_is_busy(true);
    set_error_message(null);
    const body =
      action === "reverify"
        ? { ownership_source_type: reverify_type, ownership_source_url: reverify_url }
        : {
            corporate_tier: tier,
            parent_entity: tier === 3 ? null : parent_entity,
            financial_backers: tier === 3 ? [] : backers,
            ownership_source_type: correct_type,
            ownership_source_url: correct_url,
            review_note,
          };
    const failure = await post_json(`/api/admin/brands/${brand.id}/${action}`, body);
    set_is_busy(false);
    if (failure) {
      set_error_message(failure);
      return;
    }
    set_panel("none");
    set_saved_message(action === "reverify" ? "Re-verified." : "Correction saved.");
    router.refresh();
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
        <form onSubmit={(event) => void submit(event, "reverify")} className="space-y-3 border-t border-hairline pt-4">
          <p className="text-sm text-zinc-400">
            The claim stays as is. Record the evidence you just checked; the verified date becomes today.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={label_classes}>
              Source type
              <SourceTypeSelect corporate_tier={brand.corporate_tier} value={reverify_type} on_change={set_reverify_type} />
            </label>
            <label className={label_classes}>
              Evidence link
              <input
                className={`${input_classes} mt-1`}
                type="url"
                required
                value={reverify_url}
                onChange={(event) => set_reverify_url(event.target.value)}
                placeholder="https://…"
              />
            </label>
          </div>
          <SubmitRow is_busy={is_busy} label="Save re-verification" error_message={error_message} />
        </form>
      )}

      {panel === "correct" && (
        <form onSubmit={(event) => void submit(event, "correct")} className="space-y-3 border-t border-hairline pt-4">
          <p className="text-sm text-zinc-400">
            Use this when ownership changed (for example a PE exit or a new buyer). A correction needs new evidence
            and a reason.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={label_classes}>
              Corporate tier
              <select
                className={`${input_classes} mt-1`}
                value={tier}
                onChange={(event) => change_tier(Number(event.target.value) as 1 | 2 | 3)}
              >
                <option value={1}>Tier 1 — PE buyout</option>
                <option value={2}>Tier 2 — VC / growth equity</option>
                <option value={3}>Tier 3 — Independent</option>
              </select>
            </label>
            <label className={label_classes}>
              Parent entity {tier === 3 ? "(none for independents)" : ""}
              <input
                className={`${input_classes} mt-1 disabled:bg-zinc-900 disabled:text-zinc-600`}
                value={tier === 3 ? "" : parent_entity}
                onChange={(event) => set_parent_entity(event.target.value)}
                disabled={tier === 3}
                required={tier !== 3}
                maxLength={200}
              />
            </label>
            <label className={`${label_classes} sm:col-span-2`}>
              Named backers, comma-separated {tier === 3 ? "(none for independents)" : "(only ones you can cite)"}
              <input
                className={`${input_classes} mt-1 disabled:bg-zinc-900 disabled:text-zinc-600`}
                value={tier === 3 ? "" : backers}
                onChange={(event) => set_backers(event.target.value)}
                disabled={tier === 3}
              />
            </label>
            <label className={label_classes}>
              New source type
              <SourceTypeSelect corporate_tier={tier} value={correct_type} on_change={set_correct_type} />
            </label>
            <label className={label_classes}>
              New evidence link
              <input
                className={`${input_classes} mt-1`}
                type="url"
                required
                value={correct_url}
                onChange={(event) => set_correct_url(event.target.value)}
                placeholder="https://…"
              />
            </label>
            <label className={`${label_classes} sm:col-span-2`}>
              Reason (kept in the audit log)
              <input
                className={`${input_classes} mt-1`}
                required
                maxLength={500}
                value={review_note}
                onChange={(event) => set_review_note(event.target.value)}
                placeholder="e.g. Acquired by Example Capital in Sept 2026"
              />
            </label>
          </div>
          <SubmitRow is_busy={is_busy} label="Save correction" error_message={error_message} />
        </form>
      )}
    </li>
  );
}

function SubmitRow({ is_busy, label, error_message }: { is_busy: boolean; label: string; error_message: string | null }) {
  return (
    <>
      {error_message && (
        <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error_message}
        </p>
      )}
      <button
        type="submit"
        disabled={is_busy}
        className="min-h-11 rounded-lg bg-independent px-4 py-2.5 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-300 disabled:cursor-wait disabled:bg-zinc-800"
      >
        {is_busy ? "Saving…" : label}
      </button>
    </>
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
