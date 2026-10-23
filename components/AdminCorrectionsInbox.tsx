"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { ISSUE_LABELS, RELATIONSHIP_LABELS, type CorrectionOutcome } from "@/lib/corrections";
import type { CorrectionListFilter, CorrectionRequestRecord } from "@/lib/db/corrections";
import type { ApiErrorResponse } from "@/lib/types";

const input_classes =
  "w-full rounded-lg border border-hairline bg-surface-page px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-500";

function RequestCard({ request }: { request: CorrectionRequestRecord }) {
  const router = useRouter();
  const [note, set_note] = useState("");
  const [busy_outcome, set_busy_outcome] = useState<CorrectionOutcome | null>(null);
  const [error_message, set_error_message] = useState<string | null>(null);
  const is_open = request.status === "open";

  async function close_request(event: FormEvent<HTMLFormElement>, outcome: CorrectionOutcome): Promise<void> {
    event.preventDefault();
    set_busy_outcome(outcome);
    set_error_message(null);
    try {
      const response = await fetch(`/api/admin/corrections/${request.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome, note }),
      });
      if (!response.ok) {
        const failure = (await response.json().catch(() => null)) as ApiErrorResponse | null;
        throw new Error(failure?.error ?? `Request failed (${response.status}).`);
      }
      router.refresh();
    } catch (caught_error) {
      set_error_message(caught_error instanceof Error ? caught_error.message : "Request failed.");
      set_busy_outcome(null);
    }
  }

  return (
    <li className="space-y-4 rounded-xl border border-hairline bg-surface-card p-5 shadow-hairline">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-zinc-50">{request.brand_name}</h2>
          {request.address && <p className="text-sm text-zinc-400">{request.address}</p>}
        </div>
        <time className="text-xs text-zinc-500" dateTime={request.created_at}>
          Reported {new Date(request.created_at).toLocaleString()}
        </time>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-hairline pt-3 text-sm">
        <dt className="text-zinc-500">Issue</dt>
        <dd className="font-medium text-zinc-100">{ISSUE_LABELS[request.issue]}</dd>
        <dt className="text-zinc-500">Reporter</dt>
        <dd className="text-zinc-200">
          {RELATIONSHIP_LABELS[request.reporter_relationship]}
          {request.contact_email && (
            <>
              {" · "}
              <a href={`mailto:${request.contact_email}`} className="text-sky-300 underline underline-offset-2">
                {request.contact_email}
              </a>
            </>
          )}
        </dd>
        <dt className="text-zinc-500">Details</dt>
        <dd className="whitespace-pre-wrap text-zinc-200">{request.details}</dd>
        {request.evidence_url && (
          <>
            <dt className="text-zinc-500">Evidence</dt>
            <dd className="min-w-0">
              <a
                href={request.evidence_url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="break-all text-sky-300 underline underline-offset-2"
              >
                {request.evidence_url}
              </a>
            </dd>
          </>
        )}
        {!is_open && (
          <>
            <dt className="text-zinc-500">Outcome</dt>
            <dd className="text-zinc-300">
              {request.status === "resolved" ? "Resolved" : "Dismissed"} by {request.resolver_email ?? "unknown"}
              {request.resolved_at && ` · ${new Date(request.resolved_at).toLocaleDateString()}`}
              {request.resolution_note && <span className="block text-zinc-400">{request.resolution_note}</span>}
            </dd>
          </>
        )}
      </dl>

      {is_open && (
        <form onSubmit={(event) => void close_request(event, "resolved")} className="space-y-3 border-t border-hairline pt-4">
          {request.brand_id && (
            <Link
              href={`/admin/brands?filter=all&q=${encodeURIComponent(request.brand_name)}`}
              className="inline-flex min-h-11 items-center text-sm font-semibold text-sky-300 underline underline-offset-2"
            >
              Open {request.brand_name} on the Brands page to re-verify or correct it
            </Link>
          )}
          <label className="block text-xs font-medium text-zinc-400">
            Note (required to dismiss; kept in the audit log)
            <input
              className={`${input_classes} mt-1`}
              value={note}
              onChange={(event) => set_note(event.target.value)}
              maxLength={500}
              placeholder="e.g. Corrected to Tier 3 with the state registry record"
            />
          </label>
          {error_message && (
            <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error_message}
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="submit"
              disabled={busy_outcome !== null}
              className="min-h-11 rounded-lg bg-independent px-4 py-2.5 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-300 disabled:cursor-wait disabled:bg-zinc-800"
            >
              {busy_outcome === "resolved" ? "Saving…" : "Mark resolved"}
            </button>
            <button
              type="button"
              disabled={busy_outcome !== null}
              onClick={(event) => void close_request(event as unknown as FormEvent<HTMLFormElement>, "dismissed")}
              className="min-h-11 rounded-lg border border-red-500/30 px-4 py-2.5 text-sm font-semibold text-red-300 transition-colors hover:bg-red-500/10 disabled:cursor-wait disabled:opacity-50"
            >
              {busy_outcome === "dismissed" ? "Saving…" : "Dismiss"}
            </button>
          </div>
        </form>
      )}
    </li>
  );
}

export default function AdminCorrectionsInbox({
  requests,
  filter,
}: {
  requests: CorrectionRequestRecord[];
  filter: CorrectionListFilter;
}) {
  const filters: { id: CorrectionListFilter; label: string }[] = [
    { id: "open", label: "Open" },
    { id: "closed", label: "Closed" },
  ];
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {filters.map((option) => (
          <Link
            key={option.id}
            href={`/admin/corrections?filter=${option.id}`}
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
      {requests.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-700 px-4 py-10 text-center text-sm text-zinc-400">
          {filter === "open" ? "No open error reports." : "No closed reports yet."}
        </p>
      ) : (
        <ul className="space-y-4">
          {requests.map((request) => (
            <RequestCard key={request.id} request={request} />
          ))}
        </ul>
      )}
    </div>
  );
}
