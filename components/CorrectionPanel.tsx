"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import SidePanel from "@/components/SidePanel";
import TurnstileWidget from "@/components/TurnstileWidget";
import {
  CORRECTION_ISSUES,
  ISSUE_LABELS,
  MAX_DETAILS_LENGTH,
  MIN_DETAILS_LENGTH,
  RELATIONSHIP_LABELS,
  REPORTER_RELATIONSHIPS,
  type CorrectionIssue,
  type ReporterRelationship,
} from "@/lib/corrections";
import type { ApiErrorResponse } from "@/lib/types";

export interface ReportedListing {
  location_id: string;
  brand_name: string;
  address: string;
}

interface CorrectionPanelProps {
  listing: ReportedListing | null;
  on_close: () => void;
}

const input_classes =
  "min-h-11 w-full rounded-xl border border-hairline bg-surface-page px-4 py-3 text-base text-zinc-100 outline-none transition-colors placeholder:text-zinc-500 focus:border-zinc-500";
const label_classes = "block text-sm font-medium text-zinc-300";

/** "Report an error" for one listing. Stored for an admin to review; nothing on the site changes automatically. */
export default function CorrectionPanel({ listing, on_close }: CorrectionPanelProps) {
  const is_open = listing !== null;
  const first_field_ref = useRef<HTMLSelectElement>(null);
  const [issue, set_issue] = useState<CorrectionIssue | "">("");
  const [relationship, set_relationship] = useState<ReporterRelationship | "">("");
  const [details, set_details] = useState("");
  const [evidence_url, set_evidence_url] = useState("");
  const [contact_email, set_contact_email] = useState("");
  const [honeypot, set_honeypot] = useState("");
  const turnstile_site_key = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() ?? "";
  const [turnstile_token, set_turnstile_token] = useState<string | null>(null);
  const [turnstile_reset_count, set_turnstile_reset_count] = useState(0);
  const handle_turnstile_token = useCallback((token: string | null) => set_turnstile_token(token), []);
  const [is_submitting, set_is_submitting] = useState(false);
  const [message, set_message] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  // A fresh form for every listing.
  const listing_id = listing?.location_id ?? null;
  useEffect(() => {
    set_issue("");
    set_relationship("");
    set_details("");
    set_evidence_url("");
    set_contact_email("");
    set_message(null);
  }, [listing_id]);

  const can_submit =
    issue !== "" &&
    relationship !== "" &&
    details.trim().length >= MIN_DETAILS_LENGTH &&
    (!turnstile_site_key || turnstile_token !== null) &&
    !is_submitting &&
    message?.kind !== "success";

  async function handle_submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!listing || !can_submit) return;
    set_is_submitting(true);
    set_message(null);
    try {
      const response = await fetch("/api/corrections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location_id: listing.location_id,
          issue,
          reporter_relationship: relationship,
          details,
          evidence_url,
          contact_email,
          website: honeypot,
          turnstile_token,
        }),
      });
      if (!response.ok) {
        const failure = (await response.json().catch(() => null)) as ApiErrorResponse | null;
        throw new Error(failure?.error ?? "Your report could not be sent. Please try again.");
      }
      set_message({
        kind: "success",
        text: "Thank you. An admin will review your report. The listing stays as it is until then.",
      });
    } catch (caught_error) {
      set_message({ kind: "error", text: caught_error instanceof Error ? caught_error.message : "Your report could not be sent." });
    } finally {
      // Tokens are single-use: force a fresh challenge after every attempt.
      set_turnstile_token(null);
      set_turnstile_reset_count((count) => count + 1);
      set_is_submitting(false);
    }
  }

  return (
    <SidePanel
      is_open={is_open}
      on_close={on_close}
      heading_id="correction-panel-heading"
      title="Report an error"
      description={
        listing ? (
          <>
            <span className="font-medium text-zinc-200">{listing.brand_name}</span> · {listing.address}
          </>
        ) : null
      }
      initial_focus_ref={first_field_ref}
    >
      <form onSubmit={handle_submit} noValidate className="flex flex-1 flex-col gap-5">
        <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
          <label>
            Website
            <input tabIndex={-1} autoComplete="off" value={honeypot} onChange={(event) => set_honeypot(event.target.value)} />
          </label>
        </div>

        <label className={label_classes}>
          What is wrong?
          <select
            ref={first_field_ref}
            className={`${input_classes} mt-1`}
            value={issue}
            onChange={(event) => set_issue(event.target.value as CorrectionIssue)}
            required
            disabled={!is_open}
          >
            <option value="" disabled>
              Choose one…
            </option>
            {CORRECTION_ISSUES.map((option) => (
              <option key={option} value={option}>
                {ISSUE_LABELS[option]}
              </option>
            ))}
          </select>
        </label>

        <label className={label_classes}>
          How do you know this business?
          <select
            className={`${input_classes} mt-1`}
            value={relationship}
            onChange={(event) => set_relationship(event.target.value as ReporterRelationship)}
            required
            disabled={!is_open}
          >
            <option value="" disabled>
              Choose one…
            </option>
            {REPORTER_RELATIONSHIPS.map((option) => (
              <option key={option} value={option}>
                {RELATIONSHIP_LABELS[option]}
              </option>
            ))}
          </select>
        </label>

        <label className={label_classes}>
          Details
          <textarea
            className={`${input_classes} mt-1 min-h-28 resize-y`}
            value={details}
            onChange={(event) => set_details(event.target.value)}
            maxLength={MAX_DETAILS_LENGTH}
            placeholder="e.g. We are family-owned and have never taken outside investment."
            required
            disabled={!is_open}
          />
          <span className="mt-1 block text-xs text-zinc-500">At least {MIN_DETAILS_LENGTH} characters.</span>
        </label>

        <label className={label_classes}>
          Evidence link (optional)
          <input
            className={`${input_classes} mt-1`}
            type="url"
            inputMode="url"
            value={evidence_url}
            onChange={(event) => set_evidence_url(event.target.value)}
            placeholder="https://… state registry record, announcement, article"
            autoComplete="off"
            disabled={!is_open}
          />
        </label>

        <label className={label_classes}>
          Email for follow-up (optional)
          <input
            className={`${input_classes} mt-1`}
            type="email"
            inputMode="email"
            autoComplete="email"
            value={contact_email}
            onChange={(event) => set_contact_email(event.target.value)}
            maxLength={320}
            disabled={!is_open}
          />
          <span className="mt-1 block text-xs text-zinc-500">
            Only TrueOwn admins can see it, and we only use it to ask about this report.
          </span>
        </label>

        {turnstile_site_key && is_open && (
          <TurnstileWidget site_key={turnstile_site_key} reset_signal={turnstile_reset_count} on_token={handle_turnstile_token} />
        )}

        {message && (
          <p
            role="status"
            className={`rounded-xl px-4 py-3 text-sm ${
              message.kind === "success" ? "bg-independent-muted text-independent" : "bg-red-500/10 text-red-300"
            }`}
          >
            {message.text}
          </p>
        )}

        <p className="text-xs text-zinc-500">
          See{" "}
          <Link href="/how-we-classify" className="underline underline-offset-2 hover:text-zinc-300">
            how we classify
          </Link>{" "}
          businesses and what evidence we accept.
        </p>

        <button
          type="submit"
          disabled={!can_submit}
          className={`mt-auto min-h-11 w-full rounded-xl px-4 py-3 text-base font-semibold transition-colors ${
            can_submit ? "bg-zinc-100 text-zinc-950 hover:bg-white" : "cursor-not-allowed bg-zinc-800 text-zinc-500"
          }`}
        >
          {is_submitting ? "Sending…" : message?.kind === "success" ? "Report sent" : "Send report"}
        </button>
      </form>
    </SidePanel>
  );
}
