"use client";

import { FormEvent, useState } from "react";
import { validate_evidence_url } from "@/lib/validation";
import type { ApiErrorResponse } from "@/lib/types";

interface SubmissionPanelProps {
  is_open: boolean;
  on_close: () => void;
}

/** Sliding crowdsourced-tip panel. Submit stays disabled until evidence_url is a valid domain. */
export default function SubmissionPanel({ is_open, on_close }: SubmissionPanelProps) {
  const [business_name, set_business_name] = useState("");
  const [street_address, set_street_address] = useState("");
  const [evidence_url, set_evidence_url] = useState("");
  const [evidence_touched, set_evidence_touched] = useState(false);
  const [is_submitting, set_is_submitting] = useState(false);
  const [submit_message, set_submit_message] = useState<
    { kind: "success" | "error"; text: string } | null
  >(null);

  const evidence_validation = validate_evidence_url(evidence_url);
  const evidence_error =
    evidence_touched && !evidence_validation.valid ? evidence_validation.reason : null;
  // Hard block: submit stays disabled until all fields are populated and the URL is valid.
  const can_submit =
    business_name.trim().length > 0 &&
    street_address.trim().length > 0 &&
    evidence_validation.valid &&
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
      set_is_submitting(false);
    }
  }

  const input_classes =
    "w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-base text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-900";

  return (
    <>
      {is_open && (
        <div
          className="fixed inset-0 z-40 bg-zinc-900/40"
          onClick={on_close}
          aria-hidden="true"
        />
      )}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Submit an ownership tip"
        aria-hidden={!is_open}
        className={`fixed inset-y-0 right-0 z-50 w-full max-w-md overflow-y-auto bg-white shadow-2xl transition-transform duration-300 ${
          is_open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <form onSubmit={handle_submit} noValidate className="flex min-h-full flex-col gap-5 p-6">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-xl font-bold text-zinc-900">Submit an ownership tip</h2>
              <p className="mt-1 text-sm text-zinc-500">
                Tips are reviewed by an admin before going live. A public source is required.
              </p>
            </div>
            <button
              type="button"
              onClick={on_close}
              className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
              aria-label="Close panel"
            >
              ✕
            </button>
          </div>

          <label className="block text-sm font-medium text-zinc-700">
            Business name
            <input
              className={`${input_classes} mt-1`}
              value={business_name}
              onChange={(event) => set_business_name(event.target.value)}
              placeholder="e.g. Blank Street Coffee"
              maxLength={200}
              required
              disabled={!is_open}
            />
          </label>

          <label className="block text-sm font-medium text-zinc-700">
            Street address
            <input
              className={`${input_classes} mt-1`}
              value={street_address}
              onChange={(event) => set_street_address(event.target.value)}
              placeholder="e.g. 284 Lafayette St, New York"
              maxLength={300}
              required
              disabled={!is_open}
            />
          </label>

          <label className="block text-sm font-medium text-zinc-700">
            Evidence URL (SEC filing, press release, or news article)
            <input
              className={`${input_classes} mt-1 ${evidence_error ? "border-red-500 focus:border-red-600" : ""}`}
              type="url"
              inputMode="url"
              value={evidence_url}
              onChange={(event) => set_evidence_url(event.target.value)}
              onBlur={() => set_evidence_touched(true)}
              placeholder="https://example.com/press-release"
              aria-invalid={evidence_error !== null}
              aria-describedby="evidence-url-error"
              required
              disabled={!is_open}
            />
            <span id="evidence-url-error" role="alert" className="mt-1 block min-h-5 text-sm text-red-600">
              {evidence_error}
            </span>
          </label>

          {submit_message && (
            <p
              role="status"
              className={`rounded-xl px-4 py-3 text-sm ${
                submit_message.kind === "success"
                  ? "bg-emerald-500/10 text-emerald-700"
                  : "bg-red-500/10 text-red-700"
              }`}
            >
              {submit_message.text}
            </p>
          )}

          <button
            type="submit"
            disabled={!can_submit}
            className={`mt-auto w-full rounded-xl px-4 py-3 text-base font-semibold text-white transition-colors ${
              is_submitting
                ? "cursor-wait bg-amber-500"
                : can_submit
                  ? "bg-zinc-900 hover:bg-zinc-700"
                  : "cursor-not-allowed bg-zinc-300"
            }`}
          >
            {is_submitting ? "Verifying link & submitting…" : "Submit for review"}
          </button>
        </form>
      </aside>
    </>
  );
}
