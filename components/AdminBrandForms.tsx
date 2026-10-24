"use client";

import { FormEvent, ReactNode, useState } from "react";
import { SOURCE_TYPE_LABELS, source_types_for_tier, type OwnershipSourceType } from "@/lib/provenance";
import type { ApiErrorResponse } from "@/lib/types";

/** Shared pieces of the admin brand forms (Brands page and ownership Alerts). */

export const input_classes =
  "w-full rounded-lg border border-hairline bg-surface-page px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-500";
export const label_classes = "text-xs font-medium text-zinc-400";

export const TIER_LABELS: Record<1 | 2 | 3, string> = {
  1: "Tier 1 · PE owned",
  2: "Tier 2 · VC funded",
  3: "Tier 3 · Independent",
};

/** POSTs JSON; returns null on success or a message to show. */
export async function post_json(url: string, body: unknown): Promise<string | null> {
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

export function fits_tier(corporate_tier: 1 | 2 | 3, source_type: string | null | undefined): boolean {
  return (source_types_for_tier(corporate_tier) as readonly string[]).includes(source_type ?? "");
}

export function SourceTypeSelect({
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

export function SubmitRow({ is_busy, label, error_message }: { is_busy: boolean; label: string; error_message: string | null }) {
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

export interface ReverifyBody {
  ownership_source_type: string;
  ownership_source_url: string;
}

/** Same claim, fresh evidence: the verified date becomes today. */
export function ReverifyForm({
  corporate_tier,
  initial_source_type,
  initial_source_url,
  intro,
  submit_label,
  on_submit,
}: {
  corporate_tier: 1 | 2 | 3;
  initial_source_type: string;
  initial_source_url: string;
  intro: ReactNode;
  submit_label: string;
  on_submit: (body: ReverifyBody) => Promise<string | null>;
}) {
  const [source_type, set_source_type] = useState(fits_tier(corporate_tier, initial_source_type) ? initial_source_type : "");
  const [source_url, set_source_url] = useState(initial_source_url);
  const [is_busy, set_is_busy] = useState(false);
  const [error_message, set_error_message] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    set_is_busy(true);
    set_error_message(null);
    const failure = await on_submit({ ownership_source_type: source_type, ownership_source_url: source_url });
    set_is_busy(false);
    if (failure) set_error_message(failure);
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3 border-t border-hairline pt-4">
      <p className="text-sm text-zinc-400">{intro}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className={label_classes}>
          Source type
          <SourceTypeSelect corporate_tier={corporate_tier} value={source_type} on_change={set_source_type} />
        </label>
        <label className={label_classes}>
          Evidence link
          <input
            className={`${input_classes} mt-1`}
            type="url"
            required
            value={source_url}
            onChange={(event) => set_source_url(event.target.value)}
            placeholder="https://…"
          />
        </label>
      </div>
      <SubmitRow is_busy={is_busy} label={submit_label} error_message={error_message} />
    </form>
  );
}

export interface CorrectionBody extends ReverifyBody {
  corporate_tier: 1 | 2 | 3;
  parent_entity: string | null;
  financial_backers: string[] | string;
  review_note: string;
}

/** Changes tier / parent / backers; needs new evidence and a reason. */
export function CorrectionForm({
  initial,
  intro,
  submit_label,
  on_submit,
}: {
  initial: {
    corporate_tier: 1 | 2 | 3;
    parent_entity: string | null;
    financial_backers: string[];
    source_type?: string;
    source_url?: string;
    review_note?: string;
  };
  intro: ReactNode;
  submit_label: string;
  on_submit: (body: CorrectionBody) => Promise<string | null>;
}) {
  const [tier, set_tier] = useState<1 | 2 | 3>(initial.corporate_tier);
  const [parent_entity, set_parent_entity] = useState(initial.parent_entity ?? "");
  const [backers, set_backers] = useState(initial.financial_backers.join(", "));
  const [source_type, set_source_type] = useState<string>(fits_tier(initial.corporate_tier, initial.source_type) ? initial.source_type! : "");
  const [source_url, set_source_url] = useState(initial.source_url ?? "");
  const [review_note, set_review_note] = useState(initial.review_note ?? "");
  const [is_busy, set_is_busy] = useState(false);
  const [error_message, set_error_message] = useState<string | null>(null);

  function change_tier(next: 1 | 2 | 3): void {
    set_tier(next);
    if (!fits_tier(next, source_type)) set_source_type("");
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    set_is_busy(true);
    set_error_message(null);
    const failure = await on_submit({
      corporate_tier: tier,
      parent_entity: tier === 3 ? null : parent_entity,
      financial_backers: tier === 3 ? [] : backers,
      ownership_source_type: source_type,
      ownership_source_url: source_url,
      review_note,
    });
    set_is_busy(false);
    if (failure) set_error_message(failure);
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3 border-t border-hairline pt-4">
      <p className="text-sm text-zinc-400">{intro}</p>
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
          <SourceTypeSelect corporate_tier={tier} value={source_type} on_change={set_source_type} />
        </label>
        <label className={label_classes}>
          New evidence link
          <input
            className={`${input_classes} mt-1`}
            type="url"
            required
            value={source_url}
            onChange={(event) => set_source_url(event.target.value)}
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
      <SubmitRow is_busy={is_busy} label={submit_label} error_message={error_message} />
    </form>
  );
}
