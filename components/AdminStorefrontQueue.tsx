"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import type {
  ChainGroup,
  IndependentGroup,
  IndependentSort,
  PossibleMatch,
  RegistrySuggestionView,
  RejectedGroup,
  StorefrontCandidate,
  StorefrontQueue,
  StorefrontQueueView,
} from "@/lib/db/storefronts";
import { CORPORATE_SOURCE_TYPES, INDEPENDENT_SOURCE_TYPES, SOURCE_TYPE_LABELS } from "@/lib/provenance";
import type { ApiErrorResponse } from "@/lib/types";

const MAX_BATCH = 500;
const TIER_LABELS: Record<number, string> = { 1: "Tier 1 · PE owned", 2: "Tier 2 · VC funded", 3: "Tier 3 · Independent" };
const REJECT_REASONS = [
  "A chain we don't track",
  "Not a coffee or bakery business",
  "Closed, duplicate or not a public storefront",
];
const LEGACY_SOURCE_TYPES = ["nys_dos_corporations", "eater_ny"];

const input_classes =
  "w-full rounded-lg border border-hairline bg-surface-page px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-500";
const secondary_button =
  "min-h-11 rounded-lg border border-hairline px-3 py-2 text-sm font-semibold text-zinc-200 transition-colors hover:border-zinc-500 disabled:cursor-wait disabled:opacity-50";
const primary_button =
  "min-h-11 rounded-lg bg-independent px-4 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-300 disabled:cursor-wait disabled:bg-zinc-800 disabled:text-zinc-500";

async function post(path: string, body: unknown): Promise<string | null> {
  try {
    const response = await fetch(`/api/admin/storefronts/${path}`, {
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

/** Sends ids in chunks the database accepts; stops at the first failure. */
async function post_in_batches(path: string, ids: string[], extra: Record<string, unknown>): Promise<string | null> {
  for (let start = 0; start < ids.length; start += MAX_BATCH) {
    const failure = await post(path, { candidate_ids: ids.slice(start, start + MAX_BATCH), ...extra });
    if (failure) return failure;
  }
  return null;
}

function map_link(candidate: StorefrontCandidate): string | null {
  if (candidate.latitude === null || candidate.longitude === null) return null;
  return `https://www.openstreetmap.org/?mlat=${candidate.latitude}&mlon=${candidate.longitude}#map=19/${candidate.latitude}/${candidate.longitude}`;
}

function CandidateLine({ candidate }: { candidate: StorefrontCandidate }) {
  const link = map_link(candidate);
  return (
    <span className="min-w-0">
      <span className="text-zinc-200">{candidate.address}</span>
      {candidate.name && <span className="text-zinc-500"> · listed as “{candidate.name}”</span>}
      {link ? (
        <a href={link} target="_blank" rel="noopener noreferrer" className="ml-2 text-xs text-sky-300 underline underline-offset-2">
          map
        </a>
      ) : (
        <span className="ml-2 text-xs text-corporate">no coordinates</span>
      )}
    </span>
  );
}

function use_action() {
  const router = useRouter();
  const [is_busy, set_is_busy] = useState(false);
  const [error_message, set_error_message] = useState<string | null>(null);
  async function run(action: () => Promise<string | null>): Promise<boolean> {
    set_is_busy(true);
    set_error_message(null);
    const failure = await action();
    set_is_busy(false);
    if (failure) {
      set_error_message(failure);
      return false;
    }
    router.refresh();
    return true;
  }
  return { is_busy, error_message, run };
}

function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">
      {message}
    </p>
  );
}

function RejectForm({ ids, label, on_done }: { ids: string[]; label: string; on_done?: () => void }) {
  const [reason, set_reason] = useState(REJECT_REASONS[0]!);
  const { is_busy, error_message, run } = use_action();
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (await run(() => post_in_batches("reject", ids, { note: reason }))) on_done?.();
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="flex-1 text-xs font-medium text-zinc-400">
          Reason
          <input
            className={`${input_classes} mt-1`}
            list="storefront-reject-reasons"
            value={reason}
            onChange={(event) => set_reason(event.target.value)}
            maxLength={500}
            required
          />
        </label>
        <button type="submit" disabled={is_busy} className={`${secondary_button} self-end border-red-500/30 text-red-300 hover:bg-red-500/10`}>
          {is_busy ? "Saving…" : label}
        </button>
      </div>
      <ErrorLine message={error_message} />
    </form>
  );
}

function ChainCard({ group }: { group: ChainGroup }) {
  const [show_list, set_show_list] = useState(false);
  const [show_reject, set_show_reject] = useState(false);
  const { is_busy, error_message, run } = use_action();
  const placeable = group.candidates.filter((candidate) => candidate.latitude !== null);
  const unplaceable = group.candidates.length - placeable.length;

  return (
    <li className="space-y-3 rounded-xl border border-hairline bg-surface-card p-5 shadow-hairline">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-zinc-50">{group.brand_name}</h2>
          <p className="text-sm text-zinc-400">
            {TIER_LABELS[group.corporate_tier] ?? `Tier ${group.corporate_tier}`} · {group.candidates.length} new storefront
            {group.candidates.length === 1 ? "" : "s"}
            {unplaceable > 0 && <span className="text-corporate"> · {unplaceable} without coordinates</span>}
          </p>
        </div>
      </div>
      <p className="text-sm text-zinc-500">
        The brand&apos;s ownership claim and source are already on record; approving adds these storefronts to the map.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={is_busy || placeable.length === 0}
          onClick={() => void run(() => post_in_batches("approve", placeable.map((candidate) => candidate.id), {}))}
          className={primary_button}
        >
          {is_busy ? "Approving…" : `Approve all ${placeable.length}`}
        </button>
        <button type="button" onClick={() => set_show_list((open) => !open)} aria-expanded={show_list} className={secondary_button}>
          {show_list ? "Hide storefronts" : "Review one by one"}
        </button>
        <button type="button" onClick={() => set_show_reject((open) => !open)} aria-expanded={show_reject} className={secondary_button}>
          Reject…
        </button>
      </div>
      <ErrorLine message={error_message} />
      {show_reject && <RejectForm ids={group.candidates.map((candidate) => candidate.id)} label={`Reject all ${group.candidates.length}`} />}
      {show_list && (
        <ul className="divide-y divide-white/[0.06] border-t border-hairline text-sm">
          {group.candidates.map((candidate) => (
            <SingleCandidateRow key={candidate.id} candidate={candidate} brand_id={null} />
          ))}
        </ul>
      )}
    </li>
  );
}

function SingleCandidateRow({ candidate, brand_id }: { candidate: StorefrontCandidate; brand_id: string | null }) {
  const [show_reject, set_show_reject] = useState(false);
  const { is_busy, error_message, run } = use_action();
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CandidateLine candidate={candidate} />
        <div className="flex gap-2">
          <button
            type="button"
            disabled={is_busy || candidate.latitude === null}
            onClick={() => void run(() => post("approve", { candidate_ids: [candidate.id], brand_id }))}
            className={secondary_button}
          >
            Approve
          </button>
          <button type="button" onClick={() => set_show_reject((open) => !open)} className={secondary_button}>
            Reject…
          </button>
        </div>
      </div>
      <ErrorLine message={error_message} />
      {show_reject && <RejectForm ids={[candidate.id]} label="Reject" />}
    </li>
  );
}

function PossibleRow({ match }: { match: PossibleMatch }) {
  const [show_reject, set_show_reject] = useState(false);
  const { is_busy, error_message, run } = use_action();
  return (
    <li className="space-y-2 rounded-xl border border-hairline bg-surface-card p-4 shadow-hairline text-sm">
      <p className="font-semibold text-zinc-50">
        “{match.name}” — is this <span className="text-corporate">{match.brand_name}</span>?
      </p>
      <CandidateLine candidate={match} />
      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          disabled={is_busy || match.latitude === null}
          onClick={() => void run(() => post("approve", { candidate_ids: [match.id], brand_id: match.brand_id }))}
          className={primary_button}
        >
          Yes, add to {match.brand_name}
        </button>
        <button type="button" onClick={() => set_show_reject((open) => !open)} className={secondary_button}>
          No…
        </button>
      </div>
      <ErrorLine message={error_message} />
      {show_reject && <RejectForm ids={[match.id]} label="Reject" />}
    </li>
  );
}

const REGISTRY_REASON: Record<RegistrySuggestionView["match_reason"], { label: string; classes: string }> = {
  name_at_address: { label: "Strong: same name, registered at this address", classes: "bg-independent-muted text-independent" },
  business_at_address: { label: "Likely: a food business registered at this address", classes: "bg-sky-400/10 text-sky-300" },
  name_elsewhere: { label: "Name only: registered elsewhere in NYC, check it is the same business", classes: "bg-white/[0.06] text-zinc-300" },
};

/** The best New York State registry lead for one shop, with a one-click "add with this record". */
function RegistryLead({ candidate, display_name }: { candidate: StorefrontCandidate; display_name: string }) {
  const { is_busy, error_message, run } = use_action();
  const [show_more, set_show_more] = useState(false);
  const leads = candidate.registry ?? [];
  if (leads.length === 0) return null;
  const visible = show_more ? leads : leads.slice(0, 1);
  return (
    <div className="space-y-2 rounded-lg border border-hairline bg-surface-page p-3">
      {visible.map((lead) => {
        const reason = REGISTRY_REASON[lead.match_reason];
        const out_of_state = lead.jurisdiction !== null && lead.jurisdiction !== "New York";
        return (
          <div key={lead.record_url} className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${reason.classes}`}>{reason.label}</span>
              {out_of_state && (
                <span className="rounded-full bg-corporate-muted px-2 py-0.5 text-xs font-semibold text-corporate">
                  Registered in {lead.jurisdiction}: larger companies often are, check for outside owners
                </span>
              )}
            </div>
            <p className="text-zinc-200">
              <span className="font-semibold">{lead.entity_name}</span>
              <span className="text-zinc-500">
                {lead.entity_type && ` · ${lead.entity_type.toLowerCase()}`}
                {lead.filed_on && ` · filed ${lead.filed_on.slice(0, 4)}`}
                {lead.entity_address && ` · ${lead.entity_address}`}
              </span>{" "}
              <a href={lead.record_url} target="_blank" rel="noopener noreferrer" className="text-xs text-sky-300 underline underline-offset-2">
                state record
              </a>
            </p>
            <button
              type="button"
              disabled={is_busy || candidate.latitude === null}
              onClick={() =>
                void run(() =>
                  post("independent", {
                    candidate_id: candidate.id,
                    brand_name: display_name,
                    ownership_source_type: "state_business_registry",
                    ownership_source_url: lead.record_url,
                  }),
                )
              }
              className={lead.match_reason === "name_at_address" && !out_of_state ? primary_button : secondary_button}
            >
              {is_busy ? "Saving…" : `Add “${display_name}” as independent with this record`}
            </button>
          </div>
        );
      })}
      {leads.length > 1 && (
        <button type="button" onClick={() => set_show_more((open) => !open)} className="text-xs text-zinc-400 underline underline-offset-2">
          {show_more ? "Show fewer leads" : `${leads.length - 1} more lead${leads.length > 2 ? "s" : ""}`}
        </button>
      )}
      <ErrorLine message={error_message} />
    </div>
  );
}

/**
 * A chain the queue does not know yet, backed by private equity or venture capital:
 * create the brand with its evidence, then approve its storefronts under Chain matches.
 */
function CorporateBrandForm({ group }: { group: IndependentGroup }) {
  const router = useRouter();
  const [brand_name, set_brand_name] = useState(group.name);
  const [tier, set_tier] = useState<1 | 2>(1);
  const [parent_entity, set_parent_entity] = useState("");
  const [backers, set_backers] = useState("");
  const [source_type, set_source_type] = useState("");
  const [source_url, set_source_url] = useState("");
  const [is_busy, set_is_busy] = useState(false);
  const [error_message, set_error_message] = useState<string | null>(null);
  const first = group.candidates[0];

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!first) return;
    set_is_busy(true);
    set_error_message(null);
    const failure = await post("corporate-brand", {
      candidate_id: first.id,
      brand_name,
      corporate_tier: tier,
      parent_entity,
      financial_backers: backers,
      ownership_source_type: source_type,
      ownership_source_url: source_url,
    });
    set_is_busy(false);
    if (failure) {
      set_error_message(failure);
      return;
    }
    // Its shops are now chain matches: go straight to them for "Approve all".
    router.push(`/admin/storefronts?view=chains&q=${encodeURIComponent(brand_name)}`);
    router.refresh();
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3 border-t border-hairline pt-3">
      <p className="text-zinc-400">
        Creates the brand with its ownership evidence. Its {group.location_count} storefront
        {group.location_count === 1 ? "" : "s"} then appear under Chain matches, where you approve them. Use this only
        when a public source names the private equity or venture capital investor.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium text-zinc-400">
          Brand name as it should appear
          <input className={`${input_classes} mt-1`} value={brand_name} onChange={(event) => set_brand_name(event.target.value)} maxLength={200} required />
        </label>
        <label className="text-xs font-medium text-zinc-400">
          Tier
          <select
            className={`${input_classes} mt-1`}
            value={tier}
            onChange={(event) => {
              set_tier(Number(event.target.value) as 1 | 2);
              set_source_type("");
            }}
          >
            <option value={1}>Tier 1 — majority owned or controlled by private equity</option>
            <option value={2}>Tier 2 — venture capital / growth equity funded</option>
          </select>
        </label>
        <label className="text-xs font-medium text-zinc-400">
          Owner or lead investor
          <input
            className={`${input_classes} mt-1`}
            value={parent_entity}
            onChange={(event) => set_parent_entity(event.target.value)}
            maxLength={200}
            placeholder="e.g. TA Associates (majority)"
            required
          />
        </label>
        <label className="text-xs font-medium text-zinc-400">
          Named backers, comma-separated (only ones you can cite)
          <input className={`${input_classes} mt-1`} value={backers} onChange={(event) => set_backers(event.target.value)} placeholder="e.g. TA Associates, Bain Capital" />
        </label>
        <label className="text-xs font-medium text-zinc-400">
          Evidence type
          <select className={`${input_classes} mt-1`} value={source_type} onChange={(event) => set_source_type(event.target.value)} required>
            <option value="" disabled>
              Choose…
            </option>
            {CORPORATE_SOURCE_TYPES.map((type) => (
              <option key={type} value={type}>
                {SOURCE_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-zinc-400">
          Evidence link
          <input
            className={`${input_classes} mt-1`}
            type="url"
            value={source_url}
            onChange={(event) => set_source_url(event.target.value)}
            placeholder="https://… press release, filing or major news article"
            required
          />
        </label>
      </div>
      <button type="submit" disabled={is_busy} className={primary_button}>
        {is_busy ? "Saving…" : "Add brand and move its storefronts"}
      </button>
      <ErrorLine message={error_message} />
    </form>
  );
}

function IndependentCard({ group }: { group: IndependentGroup }) {
  const [panel, set_panel] = useState<"none" | "corporate" | "add" | "reject" | "list">("none");
  const first_placeable = group.candidates.find((candidate) => candidate.latitude !== null) ?? null;
  const [brand_name, set_brand_name] = useState(group.name);
  const [source_type, set_source_type] = useState("");
  const [source_url, set_source_url] = useState("");
  const { is_busy, error_message, run } = use_action();
  const looks_like_chain = group.location_count >= 5;
  const best_lead_candidate =
    group.candidates
      .filter((candidate) => (candidate.registry?.length ?? 0) > 0)
      .sort((a, b) => (b.registry?.[0]?.score ?? 0) - (a.registry?.[0]?.score ?? 0))[0] ?? null;

  async function add(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!first_placeable) return;
    await run(() =>
      post("independent", {
        candidate_id: first_placeable.id,
        brand_name,
        ownership_source_type: source_type,
        ownership_source_url: source_url,
      }),
    );
  }

  return (
    <li className="space-y-3 rounded-xl border border-hairline bg-surface-card p-4 shadow-hairline text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-zinc-50">{group.name}</p>
          <p className="text-zinc-500">
            {group.location_count} location{group.location_count === 1 ? "" : "s"} · {group.candidates[0]?.category ?? "Uncategorized"}
          </p>
        </div>
        {looks_like_chain && (
          <span className="rounded-full bg-corporate-muted px-2.5 py-0.5 text-xs font-semibold text-corporate">
            Many locations: check it is not a chain
          </span>
        )}
      </div>
      {group.location_count === 1 && group.candidates[0] && (
        <>
          <CandidateLine candidate={group.candidates[0]} />
          <RegistryLead candidate={group.candidates[0]} display_name={group.name} />
        </>
      )}
      {group.location_count > 1 && best_lead_candidate && panel !== "list" && (
        <div className="space-y-1">
          <p className="text-xs text-zinc-500">
            Best registry lead, for the location at {best_lead_candidate.address} (other locations under “Show locations”):
          </p>
          <RegistryLead candidate={best_lead_candidate} display_name={group.name} />
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => set_panel((open) => (open === "corporate" ? "none" : "corporate"))}
          aria-expanded={panel === "corporate"}
          className={secondary_button}
        >
          Add as PE/VC-backed brand…
        </button>
        <button type="button" onClick={() => set_panel((open) => (open === "add" ? "none" : "add"))} aria-expanded={panel === "add"} className={secondary_button}>
          Add as independent…
        </button>
        <button type="button" onClick={() => set_panel((open) => (open === "reject" ? "none" : "reject"))} className={secondary_button}>
          Reject{group.location_count > 1 ? ` all ${group.location_count}` : ""}…
        </button>
        {group.location_count > 1 && (
          <button type="button" onClick={() => set_panel((open) => (open === "list" ? "none" : "list"))} className={secondary_button}>
            {panel === "list" ? "Hide locations" : "Show locations"}
          </button>
        )}
      </div>

      {panel === "corporate" && <CorporateBrandForm group={group} />}
      {panel === "add" && (
        <form onSubmit={(event) => void add(event)} className="space-y-3 border-t border-hairline pt-3">
          <p className="text-zinc-400">
            Calling a business independent is an ownership claim, so it needs evidence (for example its state business
            registry record). {group.location_count > 1 && "Its other locations will then appear under Chain matches for approval."}
          </p>
          {!first_placeable && <p className="text-corporate">None of these locations has coordinates yet.</p>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-zinc-400 sm:col-span-2">
              Business name as it should appear
              <input className={`${input_classes} mt-1`} value={brand_name} onChange={(event) => set_brand_name(event.target.value)} maxLength={200} required />
            </label>
            <label className="text-xs font-medium text-zinc-400">
              Evidence type
              <select className={`${input_classes} mt-1`} value={source_type} onChange={(event) => set_source_type(event.target.value)} required>
                <option value="" disabled>
                  Choose…
                </option>
                {INDEPENDENT_SOURCE_TYPES.filter((type) => !LEGACY_SOURCE_TYPES.includes(type)).map((type) => (
                  <option key={type} value={type}>
                    {SOURCE_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-zinc-400">
              Evidence link
              <input
                className={`${input_classes} mt-1`}
                type="url"
                value={source_url}
                onChange={(event) => set_source_url(event.target.value)}
                placeholder="https://…"
                required
              />
            </label>
          </div>
          <button type="submit" disabled={is_busy || !first_placeable} className={primary_button}>
            {is_busy ? "Saving…" : "Publish as independent"}
          </button>
          <ErrorLine message={error_message} />
        </form>
      )}
      {panel === "reject" && (
        <RejectForm
          ids={group.candidates.map((candidate) => candidate.id)}
          label={group.location_count > 1 ? `Reject all ${group.location_count}` : "Reject"}
        />
      )}
      {panel === "list" && (
        <ul className="divide-y divide-white/[0.06] border-t border-hairline">
          {group.candidates.map((candidate) => (
            <li key={candidate.id} className="space-y-2 py-2">
              <CandidateLine candidate={candidate} />
              <RegistryLead candidate={candidate} display_name={group.name} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function RejectedCard({ group }: { group: RejectedGroup }) {
  const [show_list, set_show_list] = useState(false);
  const { is_busy, error_message, run } = use_action();
  const ids = group.candidates.map((candidate) => candidate.id);
  return (
    <li className="space-y-3 rounded-xl border border-hairline bg-surface-card p-4 shadow-hairline text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-zinc-50">{group.name}</p>
          <p className="text-zinc-500">
            {group.candidates.length} location{group.candidates.length === 1 ? "" : "s"} · rejected
            {group.reviewed_at && ` ${new Date(group.reviewed_at).toLocaleDateString()}`}
            {group.reason && ` · “${group.reason}”`}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={is_busy}
          onClick={() => void run(() => post_in_batches("reopen", ids, { note: "Reopened from the Rejected list" }))}
          className={secondary_button}
        >
          {is_busy ? "Reopening…" : `Reopen ${ids.length > 1 ? `all ${ids.length}` : ""}`.trim()}
        </button>
        {ids.length > 1 && (
          <button type="button" onClick={() => set_show_list((open) => !open)} className={secondary_button}>
            {show_list ? "Hide locations" : "Show locations"}
          </button>
        )}
      </div>
      <ErrorLine message={error_message} />
      {(show_list || ids.length === 1) && (
        <ul className="divide-y divide-white/[0.06] border-t border-hairline">
          {group.candidates.map((candidate) => (
            <li key={candidate.id} className="py-2">
              <CandidateLine candidate={candidate} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export default function AdminStorefrontQueue({
  queue,
  view,
  search,
  sort = "size",
}: {
  queue: StorefrontQueue;
  view: StorefrontQueueView;
  search: string;
  sort?: IndependentSort;
}) {
  const tabs: { id: StorefrontQueueView; label: string }[] = [
    { id: "chains", label: `Chain matches (${queue.counts.chains})` },
    { id: "possible", label: `Possible matches (${queue.counts.possible})` },
    { id: "independents", label: `Possible independents (${queue.counts.independents})` },
    { id: "rejected", label: `Rejected (${queue.counts.rejected})` },
  ];
  const href = (next: StorefrontQueueView) => `/admin/storefronts?view=${next}${search ? `&q=${encodeURIComponent(search)}` : ""}`;

  return (
    <div className="space-y-4">
      <datalist id="storefront-reject-reasons">
        {REJECT_REASONS.map((reason) => (
          <option key={reason} value={reason} />
        ))}
      </datalist>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-2">
          {tabs.map((tab) => (
            <Link
              key={tab.id}
              href={href(tab.id)}
              aria-current={tab.id === view ? "page" : undefined}
              className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium transition-colors ${
                tab.id === view
                  ? "border-zinc-100 bg-zinc-100 text-zinc-950"
                  : "border-hairline bg-surface-card text-zinc-300 hover:border-zinc-500"
              }`}
            >
              {tab.label}
            </Link>
          ))}
        </div>
        <form action="/admin/storefronts" method="get" role="search" className="flex gap-2">
          <input type="hidden" name="view" value={view} />
          <input name="q" defaultValue={search} maxLength={100} aria-label="Search by name or address" placeholder="Name or address" className={`${input_classes} min-h-11`} />
          <button type="submit" className={`${secondary_button} shrink-0`}>
            Search
          </button>
        </form>
      </div>

      {view === "chains" &&
        (queue.chains.length === 0 ? (
          <Empty text="No new storefronts for brands you track." />
        ) : (
          <ul className="space-y-4">
            {queue.chains.map((group) => (
              <ChainCard key={group.brand_id} group={group} />
            ))}
          </ul>
        ))}

      {view === "possible" &&
        (queue.possible.length === 0 ? (
          <Empty text="No possible matches to confirm." />
        ) : (
          <>
            <p className="text-sm text-zinc-400">
              These names look like a brand you track but are not an exact match. Confirm only when you are sure it is the
              same business; “No” takes it off the queue.
            </p>
            <ul className="space-y-3">
              {queue.possible.map((match) => (
                <PossibleRow key={match.id} match={match} />
              ))}
            </ul>
          </>
        ))}

      {view === "independents" &&
        (queue.independents.length === 0 ? (
          <Empty text="No possible independents left to review." />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-zinc-500">Order:</span>
              {(
                [
                  ["size", "Most locations first"],
                  ["registry", "Strongest registry matches first"],
                ] as const
              ).map(([value, label]) => (
                <Link
                  key={value}
                  href={`/admin/storefronts?view=independents&sort=${value}${search ? `&q=${encodeURIComponent(search)}` : ""}`}
                  aria-current={sort === value ? "true" : undefined}
                  className={`inline-flex min-h-11 items-center rounded-full border px-3 text-sm ${
                    sort === value ? "border-zinc-400 text-zinc-100" : "border-hairline text-zinc-400 hover:border-zinc-500"
                  }`}
                >
                  {label}
                </Link>
              ))}
            </div>
            <p className="text-sm text-zinc-400">
              Registry leads come from New York State&apos;s business registry (run{" "}
              <code className="text-xs">npm run db:match:registry</code> to refresh them). A record shows a local business is
              registered there, not that no investor is behind it: check before adding.
            </p>
            <p className="text-sm text-zinc-400">
              Shops that match no brand you track, grouped by name. Big groups are usually
              chains you don&apos;t track yet. If a public source names a private equity or venture capital investor, use{" "}
              <span className="font-semibold text-zinc-200">Add as PE/VC-backed brand</span>; if it is a corporate chain
              that is not PE/VC-backed, reject it as &ldquo;A chain we don&apos;t track&rdquo; (you can reopen it later).
              {queue.independents_truncated && " Showing the first groups; search to find others."}
            </p>
            <ul className="space-y-3">
              {queue.independents.map((group) => (
                <IndependentCard key={group.name} group={group} />
              ))}
            </ul>
          </>
        ))}

      {view === "rejected" && <RejectedView groups={queue.rejected} />}
    </div>
  );
}

function RejectedView({ groups }: { groups: RejectedGroup[] }) {
  if (groups.length === 0) return <Empty text="Nothing has been rejected." />;
  return (
    <>
      <p className="text-sm text-zinc-400">
        Rejected shops stay off the queue on every re-import. Reopen them if a brand was rejected too early (for example
        a chain you have since added with its evidence): they go back to the queue and are matched again.
      </p>
      <ul className="space-y-3">
        {groups.map((group) => (
          <RejectedCard key={`${group.name}|${group.reason ?? ""}`} group={group} />
        ))}
      </ul>
    </>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-xl border border-dashed border-zinc-700 px-4 py-10 text-center text-sm text-zinc-400">{text}</p>;
}
