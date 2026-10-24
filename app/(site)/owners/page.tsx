import type { Metadata } from "next";
import Link from "next/link";
import { fetch_owners, type OwnerSummary } from "@/lib/db/directory";
import { report_error } from "@/lib/monitoring";
import { SITE_NAME, absolute_url } from "@/lib/site";
import { summarize_names } from "@/lib/ui/ownership-labels";

// Always rendered from the database, never baked in at build time.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Owners & backers — ${SITE_NAME}`,
  description: "The private equity firms, venture capital investors and parent companies behind the brands on TrueOwn.",
  alternates: { canonical: absolute_url("/owners") },
};

export default async function OwnersIndex() {
  let owners: OwnerSummary[] | null = null;
  try {
    owners = (await fetch_owners()).sort((a, b) => b.brands.length - a.brands.length || a.name.localeCompare(b.name));
  } catch (caught_error) {
    report_error("[owners] index failed", caught_error);
  }

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-6xl space-y-8 px-4 pb-16 pt-8 outline-none sm:px-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">Owners &amp; backers</h1>
        <p className="max-w-2xl text-zinc-400">
          The private equity firms, venture capital investors and parent companies behind brands on TrueOwn. Owners of the most brands come first.
        </p>
      </header>
      {!owners ? (
        <p role="alert" className="rounded-2xl bg-red-500/10 px-4 py-3 text-sm text-red-300">
          This list is unavailable right now. Please try again shortly.
        </p>
      ) : owners.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-white/10 px-4 py-10 text-center text-sm text-zinc-400">No owners on record yet.</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {owners.map((owner) => (
            <li key={owner.slug}>
              <Link
                href={`/owners/${owner.slug}`}
                className="flex h-full flex-col gap-1 rounded-2xl bg-surface-card px-4 py-3.5 shadow-hairline transition-colors hover:bg-surface-raised"
              >
                <span className="font-semibold text-zinc-50">{owner.name}</span>
                <span className="text-xs text-corporate">
                  {owner.brands.length} brand{owner.brands.length === 1 ? "" : "s"} · {owner.location_count} location{owner.location_count === 1 ? "" : "s"}
                </span>
                <span className="text-xs text-zinc-500">{summarize_names(owner.brands.map((brand) => brand.name), 3)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
