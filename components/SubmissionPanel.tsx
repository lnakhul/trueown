"use client";

import { FormEvent, useCallback, useRef, useState } from "react";
import SidePanel from "@/components/SidePanel";
import TurnstileWidget from "@/components/TurnstileWidget";
import { validate_evidence_url } from "@/lib/validation";
import type { ApiErrorResponse } from "@/lib/types";

interface SubmissionPanelProps {
  is_open: boolean;
  on_close: () => void;
}

/** Sliding crowdsourced-tip panel. Submit stays disabled until evidence_url is a valid domain. */
export default function SubmissionPanel({ is_open, on_close }: SubmissionPanelProps) {
  const [business_name, set_business_name] = useState("");
  // Honeypot: hidden from people, filled in by naive bots.
  const [honeypot, set_honeypot] = useState("");
  const [street_address, set_street_address] = useState("");
  const turnstile_site_key = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() ?? "";
  const [turnstile_token, set_turnstile_token] = useState<string | null>(null);
  const [turnstile_reset_count, set_turnstile_reset_count] = useState(0);
  const handle_turnstile_token = useCallback((token: string | null) => set_turnstile_token(token), []);
  const [evidence_url, set_evidence_url] = useState("");
  const [evidence_touched, set_evidence_touched] = useState(false);
  const [is_submitting, set_is_submitting] = useState(false);
  const [submit_message, set_submit_message] = useState<
    { kind: "success" | "error"; text: string } | null
  >(null);

  const first_input_ref = useRef<HTMLInputElement>(null);

  const evidence_validation = validate_evidence_url(evidence_url);
  const evidence_error =
    evidence_touched && !evidence_validation.valid ? evidence_validation.reason : null;
  // Hard block: submit stays disabled until all fields are populated and the URL is valid.
  const can_submit =
    business_name.trim().length > 0 &&
    street_address.trim().length > 0 &&
    evidence_validation.valid &&
    (!turnstile_site_key || turnstile_token !== null) &&
    !is_submitting;

  async function handle_submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    set_evidence_touched(true);
    if (!can_submit || !evidence_validation.valid) return;

    set_is_submitting(true);
    set_submit_message(null);
    try {
      const response = await fetch("/api/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business_name,
          street_address,
          evidence_url: evidence_validation.normalized_url,
          website: honeypot,
          turnstile_token,
        }),
      });
      if (!response.ok) {
        const failure = (await response.json().catch(() => null)) as ApiErrorResponse | null;
        throw new Error(failure?.error ?? "Submission failed. Please try again.");
      }
      set_submit_message({
        kind: "success",
        text: "Thanks! Your tip is pending review and will not appear until verified.",
      });
      set_business_name("");
      set_street_address("");
      set_evidence_url("");
      set_evidence_touched(false);
    } catch (caught_error) {
      set_submit_message({
        kind: "error",
        text: caught_error instanceof Error ? caught_error.message : "Submission failed.",
      });
    } finally {
      // Tokens are single-use: force a fresh challenge after every attempt.
      set_turnstile_token(null);
      set_turnstile_reset_count((count) => count + 1);
      set_is_submitting(false);
    }
  }

  const input_classes =
    "min-h-11 w-full rounded-xl border border-hairline bg-surface-page px-4 py-3 text-base text-zinc-100 outline-none transition-colors placeholder:text-zinc-500 focus:border-zinc-500";

  return (
    <SidePanel
      is_open={is_open}
      on_close={on_close}
      heading_id="tip-panel-heading"
      title="Submit an ownership tip"
      description="Tips are reviewed by an admin before going live. A public source is required."
      initial_focus_ref={first_input_ref}
    >
        <form onSubmit={handle_submit} noValidate className="flex flex-1 flex-col gap-5">
          <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
            <label>
              Website
              <input
                tabIndex={-1}
                autoComplete="off"
                value={honeypot}
                onChange={(event) => set_honeypot(event.target.value)}
              />
            </label>
          </div>

          <label className="block text-sm font-medium text-zinc-300">
            Business name
            <input
              ref={first_input_ref}
              className={`${input_classes} mt-1`}
              autoComplete="organization"
              value={business_name}
              onChange={(event) => set_business_name(event.target.value)}
              placeholder="e.g. Blank Street Coffee"
              maxLength={200}
              required
              disabled={!is_open}
            />
          </label>

          <label className="block text-sm font-medium text-zinc-300">
            Street address
            <input
              className={`${input_classes} mt-1`}
              autoComplete="street-address"
              value={street_address}
              onChange={(event) => set_street_address(event.target.value)}
              placeholder="e.g. 284 Lafayette St, New York"
              maxLength={300}
              required
              disabled={!is_open}
            />
          </label>

          <label className="block text-sm font-medium text-zinc-300">
            Evidence URL (SEC filing, press release, or news article)
            <input
              className={`${input_classes} mt-1 ${evidence_error ? "border-red-400/70 focus:border-red-400" : ""}`}
              type="url"
              inputMode="url"
              value={evidence_url}
              onChange={(event) => set_evidence_url(event.target.value)}
              onBlur={() => set_evidence_touched(true)}
              placeholder="https://example.com/press-release"
              aria-invalid={evidence_error !== null}
              aria-describedby="evidence-url-error"
              autoComplete="off"
              required
              disabled={!is_open}
            />
            <span id="evidence-url-error" role="alert" className="mt-1 block min-h-5 text-sm text-red-300">
              {evidence_error}
            </span>
          </label>

          {turnstile_site_key && is_open && (
            <TurnstileWidget
              site_key={turnstile_site_key}
              reset_signal={turnstile_reset_count}
              on_token={handle_turnstile_token}
            />
          )}

          {submit_message && (
            <p
              role="status"
              className={`rounded-xl px-4 py-3 text-sm ${
                submit_message.kind === "success"
                  ? "bg-independent-muted text-independent"
                  : "bg-red-500/10 text-red-300"
              }`}
            >
              {submit_message.text}
            </p>
          )}

          <button
            type="submit"
            disabled={!can_submit}
            className={`mt-auto min-h-11 w-full rounded-xl px-4 py-3 text-base font-semibold transition-colors ${
              is_submitting
                ? "cursor-wait bg-corporate-strong text-zinc-950"
                : can_submit
                  ? "bg-zinc-100 text-zinc-950 hover:bg-white"
                  : "cursor-not-allowed bg-zinc-800 text-zinc-500"
            }`}
          >
            {is_submitting ? "Verifying link & submitting…" : "Submit for review"}
            {is_submitting && <span className="sr-only"> Please wait</span>}
          </button>
        </form>
    </SidePanel>
  );
}
