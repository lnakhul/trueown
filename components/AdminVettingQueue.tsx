"use client";

import { FormEvent, useState } from "react";
import type { PendingSubmission } from "@/lib/db/submissions";
import type { ApiErrorResponse, IndustryVertical } from "@/lib/types";

const INDUSTRY_OPTIONS: { value: IndustryVertical; label: string }[] = [
  { value: "coffee_bakery", label: "Coffee & Bakery" },
  { value: "restaurant", label: "Restaurant" },
  { value: "bar_nightlife", label: "Bar & Nightlife" },
  { value: "retail_boutique", label: "Retail Boutique" },
  { value: "fitness_wellness", label: "Fitness & Wellness" },
];

const input_classes =
  "w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-900";

type RowStatus = { kind: "idle" } | { kind: "busy" } | { kind: "error"; message: string };

async function read_error_message(response: Response): Promise<string> {
  const failure = (await response.json().catch(() => null)) as ApiErrorResponse | null;
  return failure?.error ?? `Request failed (${response.status}).`;
}

interface SubmissionCardProps {
  submission: PendingSubmission;
  on_resolved: (submission_id: string) => void;
}

function SubmissionCard({ submission, on_resolved }: SubmissionCardProps) {
  const [corporate_tier, set_corporate_tier] = useState("2");
  const [parent_entity, set_parent_entity] = useState("");
  const [industry_vertical, set_industry_vertical] = useState<IndustryVertical>("coffee_bakery");
  const [unique_selling_proposition, set_unique_selling_proposition] = useState("");
  const [latitude, set_latitude] = useState("");
  const [longitude, set_longitude] = useState("");
  const [row_status, set_row_status] = useState<RowStatus>({ kind: "idle" });

  const is_busy = row_status.kind === "busy";
  const is_independent = corporate_tier === "3";

  async function post_decision(action: "approve" | "reject", body?: unknown): Promise<void> {
    set_row_status({ kind: "busy" });
    try {
      const response = await fetch(`/api/admin/submissions/${submission.id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(await read_error_message(response));
      }
      on_resolved(submission.id);
    } catch (caught_error) {
      set_row_status({
        kind: "error",
        message: caught_error instanceof Error ? caught_error.message : "Request failed.",
      });
    }
  }

  async function handle_approve(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await post_decision("approve", {
      corporate_tier: Number(corporate_tier),
      parent_entity: is_independent ? null : parent_entity,
      industry_vertical,
      unique_selling_proposition,
      latitude,
      longitude,
    });
  }

  return (
    <li className="space-y-4 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-bold text-zinc-900">{submission.business_name}</h2>
          <p className="text-sm text-zinc-500">{submission.street_address}</p>
        </div>
        <time className="text-xs text-zinc-400" dateTime={submission.created_at}>
          Submitted {new Date(submission.created_at).toLocaleString()}
        </time>
      </div>

      <a
        href={submission.evidence_url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="inline-flex max-w-full items-center gap-2 break-all rounded-lg bg-blue-600/10 px-3 py-2 text-sm font-semibold text-blue-700 underline underline-offset-2 hover:bg-blue-600/20"
      >
        <span aria-hidden="true">↗</span>
        {submission.evidence_url}
      </a>

      <form onSubmit={handle_approve} className="space-y-3 border-t border-zinc-100 pt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Verified details required to publish
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-xs font-medium text-zinc-600">
            Corporate tier
            <select
              className={`${input_classes} mt-1`}
              value={corporate_tier}
              onChange={(event) => set_corporate_tier(event.target.value)}
            >
              <option value="1">Tier 1 — PE buyout</option>
              <option value="2">Tier 2 — VC / growth equity</option>
              <option value="3">Tier 3 — Independent</option>
            </select>
          </label>
          <label className="text-xs font-medium text-zinc-600">
            Parent entity {is_independent ? "(none)" : ""}
            <input
              className={`${input_classes} mt-1 disabled:bg-zinc-50`}
              value={is_independent ? "" : parent_entity}
              onChange={(event) => set_parent_entity(event.target.value)}
              disabled={is_independent}
              required={!is_independent}
              maxLength={200}
              placeholder="e.g. Acme Capital Partners"
            />
          </label>
          <label className="text-xs font-medium text-zinc-600">
            Industry
            <select
              className={`${input_classes} mt-1`}
              value={industry_vertical}
              onChange={(event) => set_industry_vertical(event.target.value as IndustryVertical)}
            >
              {INDUSTRY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-zinc-600">
            Unique selling proposition
            <input
              className={`${input_classes} mt-1`}
              value={unique_selling_proposition}
              onChange={(event) => set_unique_selling_proposition(event.target.value)}
              maxLength={300}
              placeholder="e.g. Locally roasted beans"
            />
          </label>
          <label className="text-xs font-medium text-zinc-600">
            Latitude
            <input
              className={`${input_classes} mt-1`}
              inputMode="decimal"
              value={latitude}
              onChange={(event) => set_latitude(event.target.value)}
              required
              placeholder="40.7324"
            />
          </label>
          <label className="text-xs font-medium text-zinc-600">
            Longitude
            <input
              className={`${input_classes} mt-1`}
              inputMode="decimal"
              value={longitude}
              onChange={(event) => set_longitude(event.target.value)}
              required
              placeholder="-74.0021"
            />
          </label>
        </div>

        {row_status.kind === "error" && (
          <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700">
            {row_status.message}
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="submit"
            disabled={is_busy}
            className="rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:cursor-wait disabled:bg-zinc-300"
          >
            {is_busy ? "Working…" : "Approve & publish"}
          </button>
          <button
            type="button"
            disabled={is_busy}
            onClick={() => void post_decision("reject")}
            className="rounded-lg border border-red-200 px-4 py-2.5 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 disabled:cursor-wait disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      </form>
    </li>
  );
}

export interface AdminVettingQueueProps {
  initial_submissions: PendingSubmission[];
}

export default function AdminVettingQueue({ initial_submissions }: AdminVettingQueueProps) {
  const [submissions, set_submissions] = useState(initial_submissions);

  function remove_from_queue(submission_id: string): void {
    set_submissions((current) => current.filter((entry) => entry.id !== submission_id));
  }

  if (submissions.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-10 text-center text-sm text-zinc-500">
        The queue is clear. No pending submissions.
      </p>
    );
  }

  return (
    <ul className="space-y-4">
      {submissions.map((submission) => (
        <SubmissionCard key={submission.id} submission={submission} on_resolved={remove_from_queue} />
      ))}
    </ul>
  );
}
