import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import LocationsMapClient from "@/components/site/LocationsMapClient";
import OwnershipBadge from "@/components/site/OwnershipBadge";
import ReportErrorButton from "@/components/site/ReportErrorButton";
import ShareButton from "@/components/site/ShareButton";
import { VERTICAL_LABELS } from "@/lib/catalog";
import { fetch_brand_page, type BrandPage } from "@/lib/db/directory";
import { format_verified_month, source_type_label } from "@/lib/provenance";
import { SITE_NAME, SLUG_PATTERN, absolute_url } from "@/lib/site";
import { OWNERSHIP_TAG, format_distance, ownership_sentence } from "@/lib/ui/ownership-labels";

/** Rebuilt at most every 10 minutes, so admin corrections show up quickly. */
export const revalidate = 600;

async function load(slug: string): Promise<BrandPage | null> {
  if (!SLUG_PATTERN.test(slug)) return null;
  return fetch_brand_page(slug);
}

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const brand = await load(params.slug);
  if (!brand) return { title: `Brand not found — ${SITE_NAME}` };
  const title = `Who owns ${brand.name}? ${OWNERSHIP_TAG[brand.corporate_tier]}`;
  const description = `${ownership_sentence(brand)} ${brand.location_count} location${brand.location_count === 1 ? "" : "s"} on TrueOwn, with sources${
    brand.corporate_tier === 3 ? "" : " and independent alternatives nearby"
  }.`;
  const url = absolute_url(`/brands/${brand.slug}`);
  return {
    title: `${title} — ${SITE_NAME}`,
    description,
    alternates: { canonical: url },
    openGraph: { type: "website", url, title, description, siteName: SITE_NAME },
    twitter: { card: "summary_large_image", title, description },
  };
}

const CARD = "rounded-2xl bg-surface-card p-5 shadow-hairline";

export default async function BrandPageRoute({ params }: { params: { slug: string } }) {
  const brand = await load(params.slug);
  if (!brand) notFound();
  const is_independent = brand.corporate_tier === 3;
  const page_url = absolute_url(`/brands/${brand.slug}`);
  const sentence = ownership_sentence(brand);
  const parents = brand.owners.filter((owner) => owner.role === "parent");
  const backers = brand.owners.filter((owner) => owner.role === "backer");
  const first_location = brand.locations[0];

  const points = [
    ...brand.locations.map((location) => ({
      id: location.location_id,
      latitude: location.latitude,
      longitude: location.longitude,
      label: brand.name,
      detail: location.address,
      kind: is_independent ? ("independent" as const) : ("corporate" as const),
    })),
    ...brand.alternatives.map((alternative) => ({
      id: alternative.location_id,
      latitude: alternative.latitude,
      longitude: alternative.longitude,
      label: alternative.brand_name,
      detail: `Independent · ${alternative.address}`,
      href: `/brands/${alternative.brand_slug}`,
      kind: "independent" as const,
    })),
  ];

  const structured_data = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: brand.name,
    url: page_url,
    ...(parents[0] ? { parentOrganization: { "@type": "Organization", name: parents[0].name } } : {}),
    ...(backers.length > 0 ? { funder: backers.map((backer) => ({ "@type": "Organization", name: backer.name })) } : {}),
  };

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-6xl space-y-8 px-4 pb-16 pt-6 outline-none sm:px-6">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structured_data).replace(/</g, "\\u003c") }} />
      <nav aria-label="Breadcrumb" className="text-sm text-zinc-500">
        <Link href="/brands" className="inline-flex min-h-11 items-center hover:text-zinc-200">
          Brands
        </Link>
        <span aria-hidden="true" className="px-2">/</span>
        <span className="text-zinc-300">{brand.name}</span>
      </nav>

      <header className="space-y-4">
        <OwnershipBadge tier={brand.corporate_tier} size="lg" />
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50 sm:text-4xl">{brand.name}</h1>
        <p className="max-w-2xl text-lg text-zinc-300">{sentence}</p>
        {brand.unique_selling_proposition && <p className="max-w-2xl text-sm text-zinc-400">{brand.unique_selling_proposition}</p>}
        <div className="flex flex-wrap gap-2 pt-1">
          <Link
            href={`/?brand=${brand.id}`}
            className="inline-flex min-h-11 items-center rounded-full bg-zinc-50 px-5 text-sm font-semibold text-zinc-950 transition-colors hover:bg-white"
          >
            {is_independent ? "Find it on the map" : "See locations near me"}
          </Link>
          <ShareButton url={page_url} title={`Who owns ${brand.name}?`} text={sentence} />
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="space-y-6">
          <section aria-labelledby="ownership-heading" className={CARD}>
            <h2 id="ownership-heading" className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              Ownership
            </h2>
            {is_independent ? (
              <p className="mt-3 text-sm text-zinc-300">No private equity, venture capital or corporate parent is on record.</p>
            ) : (
              <dl className="mt-3 space-y-3 text-sm">
                {parents.length > 0 && (
                  <div>
                    <dt className="text-zinc-500">{brand.corporate_tier === 1 ? "Owner" : "Parent company"}</dt>
                    <dd>
                      <Link href={`/owners/${parents[0]!.slug}`} className="font-medium text-zinc-50 underline decoration-zinc-600 underline-offset-2 hover:decoration-zinc-300">
                        {parents[0]!.name}
                      </Link>
                    </dd>
                  </div>
                )}
                {backers.length > 0 && (
                  <div>
                    <dt className="text-zinc-500">Investors</dt>
                    <dd className="flex flex-wrap gap-x-3 gap-y-1">
                      {backers.map((backer) => (
                        <Link key={backer.slug} href={`/owners/${backer.slug}`} className="font-medium text-zinc-50 underline decoration-zinc-600 underline-offset-2 hover:decoration-zinc-300">
                          {backer.name}
                        </Link>
                      ))}
                    </dd>
                  </div>
                )}
              </dl>
            )}
          </section>

          <section aria-labelledby="evidence-heading" className={CARD}>
            <h2 id="evidence-heading" className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              Evidence
            </h2>
            {brand.source ? (
              <div className="mt-3 space-y-2 text-sm">
                <p className="text-zinc-300">
                  {source_type_label(brand.source.source_type)}, checked {format_verified_month(brand.source.verified_on)}.
                </p>
                <a href={brand.source.source_url} target="_blank" rel="noopener noreferrer nofollow" className="block break-all text-sky-300 underline underline-offset-2">
                  {brand.source.source_url}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </div>
            ) : (
              <p className="mt-3 text-sm text-zinc-400">No source is recorded yet. If you know one, submit a tip.</p>
            )}
            <p className="mt-4 text-xs text-zinc-500">
              <Link href="/how-we-classify" className="underline underline-offset-2 hover:text-zinc-300">
                How we classify businesses
              </Link>
            </p>
          </section>

          <div className="flex flex-wrap gap-x-4 text-sm">
            {first_location && (
              <ReportErrorButton
                listing={{ location_id: first_location.location_id, brand_name: brand.name, address: first_location.address }}
                className="inline-flex min-h-11 items-center text-zinc-400 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-100"
              />
            )}
            {is_independent && first_location && (
              <Link
                href={`/claim?location=${first_location.location_id}`}
                className="inline-flex min-h-11 items-center text-zinc-400 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-100"
              >
                Own this business? Claim it
              </Link>
            )}
          </div>
        </div>

        <section aria-labelledby="locations-heading" className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="locations-heading" className="text-lg font-semibold text-zinc-50">
              {brand.location_count} location{brand.location_count === 1 ? "" : "s"}
            </h2>
            <p className="text-sm text-zinc-500">{VERTICAL_LABELS[brand.industry_vertical]}</p>
          </div>
          <div role="region" aria-label={`Map of ${brand.name} locations`} className="overflow-hidden rounded-2xl shadow-hairline">
            <LocationsMapClient points={points} />
          </div>
          <ul className="grid gap-2 sm:grid-cols-2">
            {brand.locations.map((location) => (
              <li key={location.location_id} className="rounded-xl bg-surface-card px-4 py-3 text-sm shadow-hairline">
                <span className="block text-zinc-100">{location.address.split(",")[0]}</span>
                <span className="block text-xs text-zinc-500">{[location.neighborhood, location.city].filter(Boolean).join(" · ")}</span>
              </li>
            ))}
          </ul>
          {brand.location_count > brand.locations.length && (
            <p className="text-sm text-zinc-500">
              Showing {brand.locations.length} of {brand.location_count}.{" "}
              <Link href={`/?brand=${brand.id}`} className="underline underline-offset-2 hover:text-zinc-200">
                See the nearest ones on the map
              </Link>
            </p>
          )}
        </section>
      </div>

      {!is_independent && (
        <section aria-labelledby="alternatives-heading" className="space-y-4">
          <div>
            <h2 id="alternatives-heading" className="text-lg font-semibold text-zinc-50">
              Independent alternatives nearby
            </h2>
            <p className="text-sm text-zinc-400">Independently owned spots within a short walk of a {brand.name} location.</p>
          </div>
          {brand.alternatives.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-zinc-400">
              No independents are on record near these locations yet.
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {brand.alternatives.map((alternative) => (
                <li key={alternative.location_id}>
                  <Link
                    href={`/brands/${alternative.brand_slug}`}
                    className="flex h-full flex-col gap-1 rounded-2xl bg-surface-card p-4 shadow-hairline transition-colors hover:bg-surface-raised"
                  >
                    <span className="flex items-center gap-2 font-semibold text-zinc-50">
                      <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-independent" />
                      {alternative.brand_name}
                    </span>
                    <span className="text-xs text-zinc-400">{alternative.address.split(",")[0]}</span>
                    <span className="mt-auto pt-2 text-xs text-independent">
                      {format_distance(alternative.distance_meters)} from {alternative.near_address.split(",")[0]}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
