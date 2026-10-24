"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import {
  CorrectionForm,
  ReverifyForm,
  SubmitRow,
  TIER_LABELS,
  input_classes,
  label_classes,
  post_json,
  type CorrectionBody,
  type ReverifyBody,
} from "@/components/AdminBrandForms";
import type { AlertListFilter, BrandAlertGroup, OwnershipAlertRecord } from "@/lib/db/alerts";
import { ALERT_SOURCE_LABELS, DISMISS_REASONS, SIGNAL_LABELS } from "@/lib/ownership-alerts";
import { format_verified_month, source_type_label } from "@/lib/provenance";

const SIGNAL_CLASSES: Record<OwnershipAlertRecord["signal"], string> = {
  acquisition: "bg-corporate-muted text-corporate",
  investment: "bg-sky-500/10 text-sky-300",
  public_offering: "bg-violet-500/10 text-violet-300",
};

function strength(score: number): { label: string; classes: string } {
  if (score >= 80) return { label: "Strong", classes: "text-zinc-50" };
  if (score >= 65) return { label: "Likely", classes: "text-zinc-300" };
  return { label: "Possible", classes: "text-zinc-500" };
}

function format_day(iso: string | null): string {
  if (!iso) return "date unknown";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * What the update form starts with: an independent that was bought becomes Tier 1,
 * one that took investment Tier 2; the alert's link is the new evidence.
 */
function suggested_correction(group: BrandAlertGroup, alert: OwnershipAlertRecord) {
  let corporate_tier = group.corporate_tier;
  if (group.corporate_tier === 3) corporate_tier = alert.signal === "investment" ? 2 : 1;
  const source_type = alert.source === "sec_edgar" ? "sec_edgar" : corporate_tier === 3 ? "local_press" : "reputable_news";
  return {
    corporate_tier,
    parent_entity: group.parent_entity,
    financial_backers: group.financial_backers,
    source_type,
    source_url: alert.url,
    review_note: `${SIGNAL_LABELS[alert.signal]}: ${alert.title}`.slice(0, 500),
  };
}

type Panel = "none" | "correct" | "reverify" | "dismiss";

function DismissForm({ on_submit }: { on_submit: (note: string) => Promise<string | null> }) {
  const [reason, set_reason] = useState<string>(DISMISS_REASONS[0]);
  const [other, set_other] = useState("");
  const [is_busy, set_is_busy] = useState(false);
  const [error_message, set_error_message] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    set_is_busy(true);
    set_error_message(null);
    const failure = await on_submit(reason === "other" ? other : reason);
    set_is_busy(false);
    if (failure) set_error_message(failure);
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3 border-t border-hairline pt-4">
      <fieldset className="space-y-2">
        <legend className={label_classes}>Why dismiss it? (kept in the audit log)</legend>
        {[...DISMISS_REASONS, "other"].map((option) => (
          <label key={option} className="flex min-h-11 items-center gap-3 text-sm text-zinc-200">
            <input
              type="radio"
              name="reason"
              value={option}
              checked={reason === option}
              onChange={() => set_reason(option)}
              className="h-4 w-4 accent-zinc-100"
            />
            {option === "other" ? "Something else" : option}
          </label>
        ))}
      </fieldset>
      {reason === "other" && (
        <input
          className={input_classes}
          required
          maxLength={500}
          value={other}
          onChange={(event) => set_other(event.target.value)}
          placeholder="Reason"
          aria-label="Reason"
        />
      )}
      <SubmitRow is_busy={is_busy} label="Dismiss alert" error_message={error_message} />
    </form>
  );
}

function AlertItem({ group, alert, is_open_filter }: { group: BrandAlertGroup; alert: OwnershipAlertRecord; is_open_filter: boolean }) {
  const router = useRouter();
  const [panel, set_panel] = useState<Panel>("none");
  const level = strength(alert.score);
  const suggestion = suggested_correction(group, alert);

  async function resolve(body: Record<string, unknown>): Promise<string | null> {
    const failure = await post_json(`/api/admin/alerts/${alert.id}/resolve`, body);
    if (failure) return failure;
    set_panel("none");
    router.refresh();
    return null;
  }

  const toggle = (next: Panel) => set_panel((current) => (current === next ? "none" : next));
  const button = (next: Panel, label: string, primary = false) => (
    <button
      type="button"
      onClick={() => toggle(next)}
      aria-expanded={panel === next}
      className={
        primary
          ? "min-h-11 rounded-lg bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-white"
          : "min-h-11 rounded-lg border border-hairline px-4 py-2 text-sm font-semibold text-zinc-200 transition-colors hover:border-zinc-500"
      }
    >
      {label}
    </button>
  );

  return (
    <li className="space-y-3 border-t border-hairline pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`rounded-full px-2.5 py-0.5 font-semibold ${SIGNAL_CLASSES[alert.signal]}`}>{SIGNAL_LABELS[alert.signal]}</span>
        <span className={`font-semibold ${level.classes}`}>{level.label}</span>
        <span className="text-zinc-500">
          {ALERT_SOURCE_LABELS[alert.source]}
          {alert.publisher && alert.source === "gdelt_news" ? ` · ${alert.publisher}` : ""} · {format_day(alert.published_at)}
        </span>
      </div>
      <a
        href={alert.url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="block font-medium leading-snug text-zinc-50 underline decoration-zinc-700 underline-offset-2 hover:decoration-zinc-300"
      >
        {alert.title}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
      {alert.matched_terms.length > 0 && (
        <p className="text-xs text-zinc-500">Matched: {alert.matched_terms.join(", ")}</p>
      )}

      {is_open_filter ? (
        <>
          <div className="flex flex-wrap gap-2">
            {button("correct", "Update listing", true)}
            {button("reverify", "Use as fresh evidence")}
            {button("dismiss", "Dismiss")}
          </div>
          {panel === "correct" && (
            <CorrectionForm
              initial={suggestion}
              intro="Read the source first. Change only what it supports: the tier, the new owner, any named backers. Saving updates the listing and closes this alert."
              submit_label="Update listing"
              on_submit={(body: CorrectionBody) => resolve({ action: "correct", ...body })}
            />
          )}
          {panel === "reverify" && (
            <ReverifyForm
              corporate_tier={group.corporate_tier}
              initial_source_type={suggestion.source_type}
              initial_source_url={alert.url}
              intro="The listing is still right and this source confirms it. It becomes the listing's evidence, verified today."
              submit_label="Save as evidence"
              on_submit={(body: ReverifyBody) => resolve({ action: "reverify", ...body })}
            />
          )}
          {panel === "dismiss" && <DismissForm on_submit={(note) => resolve({ action: "dismiss", note })} />}
        </>
      ) : (
        <p className="text-sm text-zinc-400">
          {alert.status === "applied" ? "Applied" : "Dismissed"} by {alert.resolver_email ?? "an admin"} · {format_day(alert.resolved_at)}
          {alert.resolution_note && <span className="block text-zinc-500">{alert.resolution_note}</span>}
        </p>
      )}
    </li>
  );
}

function BrandGroup({ group, is_open_filter }: { group: BrandAlertGroup; is_open_filter: boolean }) {
  return (
    <li className="space-y-4 rounded-xl border border-hairline bg-surface-card p-5 shadow-hairline">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-zinc-50">{group.brand_name}</h2>
        <p className="text-sm text-zinc-400">
          Listed as {TIER_LABELS[group.corporate_tier]}
          {group.parent_entity && ` · owner ${group.parent_entity}`}
          {group.financial_backers.length > 0 && ` · backers ${group.financial_backers.join(", ")}`} · {group.storefront_count}{" "}
          storefront{group.storefront_count === 1 ? "" : "s"}
        </p>
        <p className="text-xs text-zinc-500">
          {group.source ? (
            <>
              Evidence: {source_type_label(group.source.source_type)}, verified {format_verified_month(group.source.verified_on)} ·{" "}
              <a href={group.source.source_url} target="_blank" rel="noopener noreferrer nofollow" className="text-sky-300 underline underline-offset-2">
                current source
              </a>
            </>
          ) : (
            <span className="text-red-300">No evidence recorded</span>
          )}
        </p>
      </div>
      <ul className="space-y-4 border-t border-hairline pt-4">
        {group.alerts.map((alert) => (
          <AlertItem key={alert.id} group={group} alert={alert} is_open_filter={is_open_filter} />
        ))}
      </ul>
    </li>
  );
}

export default function AdminAlertsInbox({ groups, filter }: { groups: BrandAlertGroup[]; filter: AlertListFilter }) {
  const filters: { id: AlertListFilter; label: string }[] = [
    { id: "open", label: "To review" },
    { id: "closed", label: "Handled" },
  ];
  const total = groups.reduce((sum, group) => sum + group.alerts.length, 0);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {filters.map((option) => (
          <Link
            key={option.id}
            href={`/admin/alerts?filter=${option.id}`}
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
        {total > 0 && (
          <span className="text-sm text-zinc-500">
            {total} alert{total === 1 ? "" : "s"} for {groups.length} brand{groups.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {groups.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-700 px-4 py-10 text-center text-sm text-zinc-400">
          {filter === "open"
            ? "Nothing to review. New alerts appear after the next ownership watch run."
            : "No alerts have been handled yet."}
        </p>
      ) : (
        <ul className="space-y-4">
          {groups.map((group) => (
            <BrandGroup key={group.brand_id} group={group} is_open_filter={filter === "open"} />
          ))}
        </ul>
      )}
    </div>
  );
}
