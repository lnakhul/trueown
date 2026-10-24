"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CLAIMANT_ROLE_LABELS, type ClaimOutcome } from "@/lib/claims";
import type { BusinessClaimRecord, ClaimListFilter } from "@/lib/db/claims";
import { source_type_label } from "@/lib/provenance";
import type { ApiErrorResponse } from "@/lib/types";

const input_classes =
  "w-full rounded-lg border border-hairline bg-surface-page px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-500";

function listing_status(claim: BusinessClaimRecord): string {
  if (!claim.brand_id) return "Not on the map yet";
  if (claim.listing_tier === 3) {
    return claim.listing_source_type ? `Listed as independent · source: ${source_type_label(claim.listing_source_type)}` : "Listed as independent · no source yet";
  }
  return `Listed as Tier ${claim.listing_tier}`;
}

function ClaimCard({ claim }: { claim: BusinessClaimRecord }) {
  const router = useRouter();
  const [note, set_note] = useState("");
  const can_record = claim.listing_tier === 3;
  const [record_evidence, set_record_evidence] = useState(can_record);
  const [busy, set_busy] = useState<ClaimOutcome | null>(null);
  const [error_message, set_error_message] = useState<string | null>(null);
  const is_open = claim.status === "open";

  async function resolve(outcome: ClaimOutcome): Promise<void> {
    set_busy(outcome);
    set_error_message(null);
    try {
      const response = await fetch(`/api/admin/claims/${claim.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome, note, record_evidence: outcome === "verified" && record_evidence }),
      });
      if (!response.ok) {
        const failure = (await response.json().catch(() => null)) as ApiErrorResponse | null;
        throw new Error(failure?.error ?? `Request failed (${response.status}).`);
      }
      router.refresh();
    } catch (caught_error) {
      set_error_message(caught_error instanceof Error ? caught_error.message : "Request failed.");
      set_busy(null);
    }
  }

  return (
    <li className="space-y-4 rounded-xl border border-hairline bg-surface-card p-5 shadow-hairline">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-zinc-50">{claim.business_name}</h2>
          <p className="text-sm text-zinc-400">{claim.business_address}</p>
          <p className="text-xs text-zinc-500">{listing_status(claim)}</p>
        </div>
        <time className="text-xs text-zinc-500" dateTime={claim.created_at}>
          Claimed {new Date(claim.created_at).toLocaleString()}
        </time>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-hairline pt-3 text-sm">
        <dt className="text-zinc-500">Claimant</dt>
        <dd className="text-zinc-200">
          {claim.claimant_name} · {CLAIMANT_ROLE_LABELS[claim.claimant_role]}
        </dd>
        <dt className="text-zinc-500">Contact</dt>
        <dd className="text-zinc-200">
          <a href={`mailto:${claim.contact_email}`} className="text-sky-300 underline underline-offset-2">
            {claim.contact_email}
          </a>
          {claim.contact_phone && ` · ${claim.contact_phone}`}
        </dd>
        <dt className="text-zinc-500">Website</dt>
        <dd className="min-w-0">
          <a href={claim.website_url} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-sky-300 underline underline-offset-2">
            {claim.website_url}
          </a>
        </dd>
        <dt className="text-zinc-500">Statement</dt>
        <dd className="text-zinc-300">Confirmed independently owned, with no private equity, venture capital or corporate parent.</dd>
        {claim.details && (
          <>
            <dt className="text-zinc-500">Notes</dt>
            <dd className="whitespace-pre-wrap text-zinc-300">{claim.details}</dd>
          </>
        )}
        {!is_open && (
          <>
            <dt className="text-zinc-500">Outcome</dt>
            <dd className="text-zinc-300">
              {claim.status === "verified" ? "Verified" : "Rejected"} by {claim.resolver_email ?? "unknown"}
              {claim.resolved_at && ` · ${new Date(claim.resolved_at).toLocaleDateString()}`}
              {claim.resolution_note && <span className="block text-zinc-400">{claim.resolution_note}</span>}
            </dd>
          </>
        )}
      </dl>

      {is_open && (
        <div className="space-y-3 border-t border-hairline pt-4">
          {!claim.brand_id && (
            <p className="text-sm text-zinc-400">
              Not on the map yet: find it under{" "}
              <Link href={`/admin/storefronts?view=independents&q=${encodeURIComponent(claim.business_name)}`} className="text-sky-300 underline underline-offset-2">
                Storefronts → Possible independents
              </Link>{" "}
              and add it as an independent with “Owner confirmation” evidence and this website, then verify the claim here.
            </p>
          )}
          {can_record && (
            <label className="flex items-start gap-2 text-sm text-zinc-300">
              <input type="checkbox" className="mt-1 h-4 w-4 accent-emerald-400" checked={record_evidence} onChange={(event) => set_record_evidence(event.target.checked)} />
              Record the owner&apos;s confirmation (linked to their website) as this listing&apos;s evidence
            </label>
          )}
          <label className="block text-xs font-medium text-zinc-400">
            Note (required to reject; kept in the audit log)
            <input className={`${input_classes} mt-1`} value={note} onChange={(event) => set_note(event.target.value)} maxLength={500} placeholder="e.g. Called the shop to confirm" />
          </label>
          {error_message && (
            <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error_message}
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void resolve("verified")}
              className="min-h-11 rounded-lg bg-independent px-4 py-2.5 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-300 disabled:cursor-wait disabled:bg-zinc-800"
            >
              {busy === "verified" ? "Saving…" : "Verify"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void resolve("rejected")}
              className="min-h-11 rounded-lg border border-red-500/30 px-4 py-2.5 text-sm font-semibold text-red-300 transition-colors hover:bg-red-500/10 disabled:cursor-wait disabled:opacity-50"
            >
              {busy === "rejected" ? "Saving…" : "Reject"}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export default function AdminClaimsInbox({ claims, filter }: { claims: BusinessClaimRecord[]; filter: ClaimListFilter }) {
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {(["open", "closed"] as const).map((option) => (
          <Link
            key={option}
            href={`/admin/claims?filter=${option}`}
            aria-current={option === filter ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium transition-colors ${
              option === filter ? "border-zinc-100 bg-zinc-100 text-zinc-950" : "border-hairline bg-surface-card text-zinc-300 hover:border-zinc-500"
            }`}
          >
            {option === "open" ? "Open" : "Closed"}
          </Link>
        ))}
      </div>
      {claims.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-700 px-4 py-10 text-center text-sm text-zinc-400">
          {filter === "open" ? "No open claims." : "No closed claims yet."}
        </p>
      ) : (
        <ul className="space-y-4">
          {claims.map((claim) => (
            <ClaimCard key={claim.id} claim={claim} />
          ))}
        </ul>
      )}
    </div>
  );
}
