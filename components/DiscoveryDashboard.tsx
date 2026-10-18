"use client";

import dynamic from "next/dynamic";
import { FormEvent, useEffect, useState } from "react";
import { validate_evidence_url } from "@/lib/validation";
import type {
  AlternativeRecommendation,
  ApiErrorResponse,
  ProximityResponse,
  SelectedLocation,
} from "@/lib/types";

/** Leaflet touches `window`, so the map must render client-side only. */
const IndependentMap = dynamic(() => import("./IndependentMap"), {
  ssr: false,
  loading: () => <div className="h-56 w-full animate-pulse rounded-xl bg-zinc-200 sm:h-72" />,
});

export interface DiscoveryDashboardProps {
  selected_location: SelectedLocation;
}

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; payload: ProximityResponse };

const TIER_ALERT_LABEL: Record<1 | 2, string> = {
  1: "Private Equity Owned",
  2: "Venture Capital Funded",
};

/** Explicit icon placeholder for the Navigate action. */
function NavigateIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polygon points="3 11 22 2 13 21 11 13 3 11" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function build_directions_url(alternative: AlternativeRecommendation): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${alternative.latitude},${alternative.longitude}&travelmode=walking`;
}

/* ------------------------------------------------------------------------- */
/* Crowdsourced submission panel                                              */
/* ------------------------------------------------------------------------- */

interface SubmissionPanelProps {
  is_open: boolean;
  on_close: () => void;
}

function SubmissionPanel({ is_open, on_close }: SubmissionPanelProps) {
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

/* ------------------------------------------------------------------------- */
/* Dashboard                                                                  */
/* ------------------------------------------------------------------------- */

export default function DiscoveryDashboard({ selected_location }: DiscoveryDashboardProps) {
  const [fetch_state, set_fetch_state] = useState<FetchState>({ status: "loading" });
  const [is_panel_open, set_is_panel_open] = useState(false);

  const { latitude, longitude } = selected_location;

  // Fetch independent alternatives whenever the selected corporate location changes.
  useEffect(() => {
    const abort_controller = new AbortController();
    set_fetch_state({ status: "loading" });

    async function fetch_nearby_independent_alternatives(): Promise<void> {
      try {
        const response = await fetch(`/api/proximity?lat=${latitude}&lng=${longitude}`, {
          signal: abort_controller.signal,
        });
        if (!response.ok) {
          const failure = (await response.json().catch(() => null)) as ApiErrorResponse | null;
          throw new Error(failure?.error ?? `Request failed (${response.status}).`);
        }
        const payload = (await response.json()) as ProximityResponse;
        set_fetch_state({ status: "success", payload });
      } catch (caught_error) {
        if (abort_controller.signal.aborted) return;
        set_fetch_state({
          status: "error",
          message:
            caught_error instanceof Error ? caught_error.message : "Unable to load alternatives.",
        });
      }
    }

    void fetch_nearby_independent_alternatives();
    return () => abort_controller.abort();
  }, [latitude, longitude]);

  const alternatives =
    fetch_state.status === "success" ? fetch_state.payload.alternatives : [];

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-6 sm:px-6">
      {/* 1. Selection view: corporate profile + alert banner */}
      <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 text-zinc-50 shadow-lg">
        <div
          role="alert"
          className="flex items-center gap-3 bg-amber-500/10 px-5 py-3 text-amber-500"
        >
          <AlertIcon />
          <p className="text-sm font-semibold uppercase tracking-wide">
            {TIER_ALERT_LABEL[selected_location.corporate_tier]}
          </p>
        </div>
        <div className="space-y-1 px-5 py-5">
          <h1 className="text-2xl font-bold">{selected_location.brand_name}</h1>
          <p className="text-sm text-zinc-400">{selected_location.address}</p>
          <p className="pt-2 text-sm text-zinc-300">
            Ownership: <span className="font-medium">{selected_location.parent_entity}</span>{" "}
            <span className="text-zinc-500">(Tier {selected_location.corporate_tier})</span>
          </p>
        </div>
      </section>

      <IndependentMap target={selected_location} alternatives={alternatives} />

      {/* 2. Independent recommendation slider */}
      <section aria-labelledby="alternatives-heading" className="space-y-4">
        <h2 id="alternatives-heading" className="text-xl font-extrabold text-zinc-900 sm:text-2xl">
          Keep it local instead? Here are independent alternatives within a 5-minute walk.
        </h2>

        {fetch_state.status === "loading" && (
          <p className="text-sm text-zinc-500" aria-live="polite">
            Finding independent alternatives…
          </p>
        )}
        {fetch_state.status === "error" && (
          <p role="alert" className="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-700">
            {fetch_state.message}
          </p>
        )}
        {fetch_state.status === "success" && alternatives.length === 0 && (
          <p className="text-sm text-zinc-500">
            No verified independent alternatives nearby yet. Know one? Submit a tip below.
          </p>
        )}

        {alternatives.length > 0 && (
          <ul className="-mx-4 flex snap-x snap-mandatory space-x-4 overflow-x-auto px-4 pb-4 sm:mx-0 sm:px-0">
            {alternatives.map((alternative) => (
              <li
                key={alternative.location_id}
                className="flex w-64 shrink-0 snap-start flex-col justify-between rounded-xl border border-zinc-200 bg-white p-4 transition-shadow hover:shadow-md"
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-bold text-zinc-900">{alternative.brand_name}</h3>
                    <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-600">
                      {alternative.distance_meters}m away
                    </span>
                  </div>
                  <p className="text-sm text-zinc-500">
                    {alternative.unique_selling_proposition ?? "Independently owned"}
                  </p>
                  <p className="text-xs text-zinc-400">
                    {[alternative.address, alternative.neighborhood].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <a
                  href={build_directions_url(alternative)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-700"
                >
                  <NavigateIcon />
                  Navigate
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 3. Crowdsourced pipeline */}
      <section className="flex justify-center border-t border-zinc-200 pt-6">
        <button
          type="button"
          onClick={() => set_is_panel_open(true)}
          className="rounded-xl border border-zinc-200 px-5 py-3 text-sm font-semibold text-zinc-900 transition-colors hover:border-zinc-900"
        >
          Know of an ownership change? Submit a tip
        </button>
      </section>

      <SubmissionPanel is_open={is_panel_open} on_close={() => set_is_panel_open(false)} />
    </div>
  );
}
