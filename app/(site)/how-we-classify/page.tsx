import type { Metadata } from "next";
import Link from "next/link";
import {
  CORPORATE_SOURCE_TYPES,
  INDEPENDENT_SOURCE_TYPES,
  PROVENANCE_STALE_AFTER_DAYS,
  SOURCE_TYPE_LABELS,
  type OwnershipSourceType,
} from "@/lib/provenance";

export const metadata: Metadata = {
  title: "How we classify — TrueOwn",
  description: "How TrueOwn decides whether a business is private-equity owned, venture-backed or independent, and what evidence it requires.",
};

/** NYC-only source types kept for older records; the generic types replace them. */
const LEGACY_SOURCE_TYPES: readonly OwnershipSourceType[] = ["nys_dos_corporations", "eater_ny"];

const TIERS = [
  {
    tier: 1,
    name: "Private equity owned",
    accent: "text-corporate",
    summary:
      "A private equity fund or similar institutional investor owns a majority of the business or otherwise controls it, typically after a buyout.",
  },
  {
    tier: 2,
    name: "Venture capital funded",
    accent: "text-corporate",
    summary:
      "The business has raised institutional venture capital or growth equity to expand. Founders may still run it, but outside investors hold a stake.",
  },
  {
    tier: 3,
    name: "Independent",
    accent: "text-independent",
    summary:
      "Owned and operated by individuals or families, with no institutional investors behind it.",
  },
] as const;

function SourceList({ types }: { types: readonly OwnershipSourceType[] }) {
  return (
    <ul className="mt-2 space-y-1 text-sm text-zinc-300">
      {types
        .filter((type) => !LEGACY_SOURCE_TYPES.includes(type))
        .map((type) => (
          <li key={type} className="flex gap-2">
            <span aria-hidden="true" className="text-zinc-600">
              —
            </span>
            {SOURCE_TYPE_LABELS[type]}
          </li>
        ))}
    </ul>
  );
}

const section_heading = "text-lg font-semibold tracking-tight text-zinc-50";
const body_text = "text-sm leading-relaxed text-zinc-300";

export default function HowWeClassifyPage() {
  const recheck_months = Math.round(PROVENANCE_STALE_AFTER_DAYS / 30);
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-3xl space-y-10 px-4 pb-16 pt-8 outline-none sm:px-6">
      <div className="space-y-3">
        <Link href="/" className="inline-flex min-h-11 items-center text-sm font-medium text-zinc-400 hover:text-zinc-100">
          ← Back to the map
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">How we classify</h1>
        <p className={body_text}>
          TrueOwn describes who owns or funds a business, based on public records. It is not a judgement of quality,
          service or the people who work there. Every ownership claim on the site links to the evidence behind it.
        </p>
      </div>

      <section aria-labelledby="tiers-heading" className="space-y-4">
        <h2 id="tiers-heading" className={section_heading}>
          The three tiers
        </h2>
        <ul className="grid gap-3 sm:grid-cols-3">
          {TIERS.map((tier) => (
            <li key={tier.tier} className="rounded-2xl bg-surface-card p-4 shadow-hairline">
              <p className={`text-xs font-semibold uppercase tracking-wider ${tier.accent}`}>Tier {tier.tier}</p>
              <p className="mt-1 font-semibold text-zinc-50">{tier.name}</p>
              <p className="mt-2 text-sm text-zinc-400">{tier.summary}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="evidence-heading" className="space-y-4">
        <h2 id="evidence-heading" className={section_heading}>
          What counts as evidence
        </h2>
        <p className={body_text}>
          A claim needs a public source that anyone can check. Different tiers need different kinds of evidence:
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl bg-surface-card p-4 shadow-hairline">
            <p className="font-semibold text-zinc-50">Tier 1 and Tier 2 (institutional backing)</p>
            <SourceList types={CORPORATE_SOURCE_TYPES} />
          </div>
          <div className="rounded-2xl bg-surface-card p-4 shadow-hairline">
            <p className="font-semibold text-zinc-50">Tier 3 (independent)</p>
            <SourceList types={INDEPENDENT_SOURCE_TYPES} />
          </div>
        </div>
        <p className={body_text}>
          Each card shows which kind of source we used, links to it, and says when we last checked it.
        </p>
      </section>

      <section aria-labelledby="process-heading" className="space-y-3">
        <h2 id="process-heading" className={section_heading}>
          How a claim gets on the map
        </h2>
        <ul className={`${body_text} list-disc space-y-2 pl-5`}>
          <li>Researchers add businesses with the source and the date they checked it. Entries without a source are refused.</li>
          <li>
            Anyone can send a tip about an ownership change, but a tip must include a public source link, and nothing goes
            live until an admin has checked it.
          </li>
          <li>Every approval, correction and re-check is recorded with who made it and when.</li>
        </ul>
      </section>

      <section aria-labelledby="current-heading" className="space-y-3">
        <h2 id="current-heading" className={section_heading}>
          Keeping it current
        </h2>
        <p className={body_text}>
          Ownership changes: funds sell businesses, founders buy them back, chains close locations. Claims checked more
          than {recheck_months} months ago are flagged for review, and the card says so until they are re-checked. When
          ownership changes, the claim is corrected with new evidence, and the reason is kept on record.
        </p>
      </section>

      <section aria-labelledby="errors-heading" className="space-y-3 rounded-2xl bg-surface-card p-5 shadow-hairline">
        <h2 id="errors-heading" className={section_heading}>
          Something wrong?
        </h2>
        <p className={body_text}>
          If you own or work at a business we describe incorrectly, or you know its ownership has changed, use{" "}
          <span className="font-semibold text-zinc-100">Report an error</span> on that business&apos;s card. Every report is
          read by an admin. Including a link to evidence (for example a state registry record or an announcement) helps us
          fix it quickly.
        </p>
        <Link
          href="/"
          className="inline-flex min-h-11 items-center rounded-xl bg-zinc-100 px-4 text-sm font-semibold text-zinc-950 hover:bg-white"
        >
          Find the business on the map
        </Link>
      </section>

      <section aria-labelledby="claim-heading" className="space-y-3 rounded-2xl bg-surface-card p-5 shadow-hairline">
        <h2 id="claim-heading" className={section_heading}>
          Own an independent business?
        </h2>
        <p className={body_text}>
          Confirm that your café or bakery is independently owned. Once checked, your confirmation (linked to your website)
          becomes the evidence on your listing.
        </p>
        <Link
          href="/claim"
          className="inline-flex min-h-11 items-center rounded-xl border border-hairline px-4 text-sm font-semibold text-zinc-100 hover:border-zinc-500"
        >
          Claim your business
        </Link>
      </section>
    </main>
  );
}
