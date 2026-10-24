import type { Metadata } from "next";
import Link from "next/link";
import ClaimForm from "@/components/ClaimForm";
import { UUID_PATTERN } from "@/lib/approval";
import { fetch_claimable_listing, type ClaimableListing } from "@/lib/db/claims";
import { report_error } from "@/lib/monitoring";

export const metadata: Metadata = {
  title: "Claim your business — TrueOwn",
  description: "Own an independent coffee shop or bakery? Confirm it is independently owned.",
};
export const dynamic = "force-dynamic";

export default async function ClaimPage({ searchParams }: { searchParams: { location?: string } }) {
  let listing: ClaimableListing | null = null;
  const location_id = searchParams.location && UUID_PATTERN.test(searchParams.location) ? searchParams.location : null;
  if (location_id) {
    try {
      listing = await fetch_claimable_listing(location_id);
    } catch (caught_error) {
      report_error("[claim] failed to load listing", caught_error);
    }
  }

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-2xl space-y-8 px-4 pb-16 pt-8 outline-none sm:px-6">
      <div className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">Claim your business</h1>
        <p className="text-sm leading-relaxed text-zinc-300">
          Own an independent café, bakery or coffee roaster? Confirm it is independently owned, and we will show your
          confirmation as the evidence on your listing (linked to your website). Every claim is checked by a person
          before anything changes, and we may contact you to confirm.
        </p>
      </div>

      {listing && listing.corporate_tier !== 3 ? (
        <section className="space-y-3 rounded-2xl bg-surface-card p-5 shadow-hairline">
          <h2 className="text-lg font-semibold text-zinc-50">{listing.brand_name}</h2>
          <p className="text-sm text-zinc-300">
            This listing is shown as backed by private equity or venture capital. If that is wrong, open the business on the
            map and use <span className="font-semibold text-zinc-100">Report an error</span> on its card, with a link to
            evidence if you have one.
          </p>
          <Link href="/" className="inline-flex min-h-11 items-center rounded-xl bg-zinc-100 px-4 text-sm font-semibold text-zinc-950 hover:bg-white">
            Go to the map
          </Link>
        </section>
      ) : (
        <ClaimForm listing={listing ? { location_id: listing.location_id, brand_name: listing.brand_name, address: listing.address } : null} />
      )}

      <p className="text-xs text-zinc-500">
        See{" "}
        <Link href="/how-we-classify" className="underline underline-offset-2 hover:text-zinc-300">
          how we classify
        </Link>{" "}
        businesses. Your email and phone number are only visible to TrueOwn admins and are only used about this claim.
      </p>
    </main>
  );
}
