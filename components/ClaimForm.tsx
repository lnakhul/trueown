"use client";

import { FormEvent, useCallback, useState } from "react";
import TurnstileWidget from "@/components/TurnstileWidget";
import { CLAIMANT_ROLES, CLAIMANT_ROLE_LABELS, INDEPENDENCE_STATEMENT, type ClaimantRole } from "@/lib/claims";
import type { ApiErrorResponse } from "@/lib/types";

const input_classes =
  "min-h-11 w-full rounded-xl border border-hairline bg-surface-page px-4 py-3 text-base text-zinc-100 outline-none transition-colors placeholder:text-zinc-500 focus:border-zinc-500";
const label_classes = "block text-sm font-medium text-zinc-300";

export interface ClaimedListing {
  location_id: string;
  brand_name: string;
  address: string;
}

/** Owner claim form. Listed businesses arrive with their listing; others type their name and address. */
export default function ClaimForm({ listing }: { listing: ClaimedListing | null }) {
  const [business_name, set_business_name] = useState("");
  const [business_address, set_business_address] = useState("");
  const [claimant_name, set_claimant_name] = useState("");
  const [claimant_role, set_claimant_role] = useState<ClaimantRole | "">("");
  const [contact_email, set_contact_email] = useState("");
  const [contact_phone, set_contact_phone] = useState("");
  const [website_url, set_website_url] = useState("");
  const [details, set_details] = useState("");
  const [attests, set_attests] = useState(false);
  const [honeypot, set_honeypot] = useState("");
  const turnstile_site_key = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() ?? "";
  const [turnstile_token, set_turnstile_token] = useState<string | null>(null);
  const [turnstile_reset_count, set_turnstile_reset_count] = useState(0);
  const handle_turnstile_token = useCallback((token: string | null) => set_turnstile_token(token), []);
  const [is_submitting, set_is_submitting] = useState(false);
  const [message, set_message] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const sent = message?.kind === "success";
  const can_submit =
    (listing !== null || (business_name.trim() !== "" && business_address.trim() !== "")) &&
    claimant_name.trim() !== "" &&
    claimant_role !== "" &&
    contact_email.trim() !== "" &&
    website_url.trim() !== "" &&
    attests &&
    (!turnstile_site_key || turnstile_token !== null) &&
    !is_submitting &&
    !sent;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!can_submit) return;
    set_is_submitting(true);
    set_message(null);
    try {
      const response = await fetch("/api/claims", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location_id: listing?.location_id ?? null,
          business_name,
          business_address,
          claimant_name,
          claimant_role,
          contact_email,
          contact_phone,
          website_url,
          details,
          attests_independent: attests,
          website: honeypot,
          turnstile_token,
        }),
      });
      if (!response.ok) {
        const failure = (await response.json().catch(() => null)) as ApiErrorResponse | null;
        throw new Error(failure?.error ?? "Your claim could not be sent. Please try again.");
      }
      set_message({ kind: "success", text: "Thank you. We will review your claim and may email you to confirm it." });
    } catch (caught_error) {
      set_message({ kind: "error", text: caught_error instanceof Error ? caught_error.message : "Your claim could not be sent." });
    } finally {
      set_turnstile_token(null);
      set_turnstile_reset_count((count) => count + 1);
      set_is_submitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="space-y-5 rounded-2xl bg-surface-card p-5 shadow-hairline">
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>
          Website
          <input tabIndex={-1} autoComplete="off" value={honeypot} onChange={(event) => set_honeypot(event.target.value)} />
        </label>
      </div>

      {listing ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Business</p>
          <p className="mt-1 font-semibold text-zinc-50">{listing.brand_name}</p>
          <p className="text-sm text-zinc-400">{listing.address}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className={label_classes}>
            Business name
            <input className={`${input_classes} mt-1`} value={business_name} onChange={(event) => set_business_name(event.target.value)} maxLength={200} required />
          </label>
          <label className={label_classes}>
            Street address
            <input
              className={`${input_classes} mt-1`}
              value={business_address}
              onChange={(event) => set_business_address(event.target.value)}
              maxLength={300}
              autoComplete="street-address"
              required
            />
          </label>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className={label_classes}>
          Your name
          <input className={`${input_classes} mt-1`} value={claimant_name} onChange={(event) => set_claimant_name(event.target.value)} maxLength={120} autoComplete="name" required />
        </label>
        <label className={label_classes}>
          Your role
          <select className={`${input_classes} mt-1`} value={claimant_role} onChange={(event) => set_claimant_role(event.target.value as ClaimantRole)} required>
            <option value="" disabled>
              Choose…
            </option>
            {CLAIMANT_ROLES.map((role) => (
              <option key={role} value={role}>
                {CLAIMANT_ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </label>
        <label className={label_classes}>
          Business email
          <input
            className={`${input_classes} mt-1`}
            type="email"
            inputMode="email"
            autoComplete="email"
            value={contact_email}
            onChange={(event) => set_contact_email(event.target.value)}
            maxLength={320}
            required
          />
        </label>
        <label className={label_classes}>
          Phone (optional)
          <input className={`${input_classes} mt-1`} type="tel" autoComplete="tel" value={contact_phone} onChange={(event) => set_contact_phone(event.target.value)} maxLength={40} />
        </label>
        <label className={`${label_classes} sm:col-span-2`}>
          Business website
          <input
            className={`${input_classes} mt-1`}
            type="url"
            inputMode="url"
            value={website_url}
            onChange={(event) => set_website_url(event.target.value)}
            placeholder="https://yourcafe.com"
            required
          />
          <span className="mt-1 block text-xs text-zinc-500">Shown as the public link on your listing once verified.</span>
        </label>
        <label className={`${label_classes} sm:col-span-2`}>
          Anything we should know (optional)
          <textarea className={`${input_classes} mt-1 min-h-24 resize-y`} value={details} onChange={(event) => set_details(event.target.value)} maxLength={2000} />
        </label>
      </div>

      <label className="flex items-start gap-3 text-sm text-zinc-200">
        <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-emerald-400" checked={attests} onChange={(event) => set_attests(event.target.checked)} required />
        <span>{INDEPENDENCE_STATEMENT}</span>
      </label>

      {turnstile_site_key && (
        <TurnstileWidget site_key={turnstile_site_key} reset_signal={turnstile_reset_count} on_token={handle_turnstile_token} />
      )}

      {message && (
        <p role="status" className={`rounded-xl px-4 py-3 text-sm ${message.kind === "success" ? "bg-independent-muted text-independent" : "bg-red-500/10 text-red-300"}`}>
          {message.text}
        </p>
      )}

      <button
        type="submit"
        disabled={!can_submit}
        className={`min-h-11 w-full rounded-xl px-4 py-3 text-base font-semibold transition-colors ${
          can_submit ? "bg-zinc-100 text-zinc-950 hover:bg-white" : "cursor-not-allowed bg-zinc-800 text-zinc-500"
        }`}
      >
        {is_submitting ? "Sending…" : sent ? "Claim sent" : "Send claim"}
      </button>
    </form>
  );
}
