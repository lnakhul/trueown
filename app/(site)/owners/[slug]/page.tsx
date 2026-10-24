import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import OwnershipBadge from "@/components/site/OwnershipBadge";
import ShareButton from "@/components/site/ShareButton";
import { fetch_owner_page, type OwnerSummary } from "@/lib/db/directory";
import { SITE_NAME, SLUG_PATTERN, absolute_url } from "@/lib/site";
import { summarize_names } from "@/lib/ui/ownership-labels";

export const revalidate = 600;

async function load(slug: string): Promise<OwnerSummary | null> {
  if (!SLUG_PATTERN.test(slug)) return null;
  return fetch_owner_page(slug);
}

function describe(owner: OwnerSummary): string {
  const names = summarize_names(owner.brands.map((brand) => brand.name), 3);
  return `${owner.name} owns or backs ${owner.brands.length === 1 ? names : `${owner.brands.length} brands on TrueOwn: ${names}`}, with ${owner.location_count} location${
    owner.location_count === 1 ? "" : "s"
  }.`;
}

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const owner = await load(params.slug);
  if (!owner) return { title: `Owner not found — ${SITE_NAME}` };
  const title = `What does ${owner.name} own?`;
  const description = describe(owner);
  const url = absolute_url(`/owners/${owner.slug}`);
  return {
    title: `${title} — ${SITE_NAME}`,
    description,
    alternates: { canonical: url },
    openGraph: { type: "website", url, title, description, siteName: SITE_NAME },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function OwnerPage({ params }: { params: { slug: string } }) {
  const owner = await load(params.slug);
  if (!owner) notFound();
  const url = absolute_url(`/owners/${owner.slug}`);

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-4xl space-y-8 px-4 pb-16 pt-6 outline-none sm:px-6">
      <nav aria-label="Breadcrumb" className="text-sm text-zinc-500">
        <Link href="/owners" className="inline-flex min-h-11 items-center hover:text-zinc-200">
          Owners &amp; backers
        </Link>
        <span aria-hidden="true" className="px-2">/</span>
        <span className="text-zinc-300">{owner.name}</span>
      </nav>
      <header className="space-y-4">
        <p className="text-sm font-medium text-corporate">Owner or investor</p>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50 sm:text-4xl">{owner.name}</h1>
        <p className="max-w-2xl text-lg text-zinc-300">{describe(owner)}</p>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/?owner=${encodeURIComponent(owner.name)}`}
            className="inline-flex min-h-11 items-center rounded-full bg-zinc-50 px-5 text-sm font-semibold text-zinc-950 transition-colors hover:bg-white"
          >
            See their locations near me
          </Link>
          <ShareButton url={url} title={`What does ${owner.name} own?`} text={describe(owner)} />
        </div>
      </header>
      <section aria-labelledby="brands-heading" className="space-y-3">
        <h2 id="brands-heading" className="text-lg font-semibold text-zinc-50">
          Brands
        </h2>
        <ul className="space-y-2">
          {owner.brands.map((brand) => (
            <li key={brand.slug}>
              <Link
                href={`/brands/${brand.slug}`}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-surface-card px-4 py-4 shadow-hairline transition-colors hover:bg-surface-raised"
              >
                <span className="space-y-1">
                  <span className="block font-semibold text-zinc-50">{brand.name}</span>
                  <span className="block text-xs text-zinc-500">
                    {brand.role === "parent" ? "Parent company" : "Investor"} · {brand.location_count} location{brand.location_count === 1 ? "" : "s"}
                  </span>
                </span>
                <OwnershipBadge tier={brand.corporate_tier} />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
