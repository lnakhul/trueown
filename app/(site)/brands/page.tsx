import type { Metadata } from "next";
import Link from "next/link";
import OwnershipBadge from "@/components/site/OwnershipBadge";
import { DIRECTORY_PAGE_SIZE, fetch_brand_directory, type DirectoryPage, type OwnershipFilter } from "@/lib/db/directory";
import { report_error } from "@/lib/monitoring";
import { SITE_NAME, absolute_url } from "@/lib/site";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Brands: who owns them — ${SITE_NAME}`,
  description: "Every coffee shop and bakery brand on TrueOwn, marked private equity owned, venture capital funded or independent, with sources.",
  alternates: { canonical: absolute_url("/brands") },
};

const FILTERS: { id: OwnershipFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "pe", label: "Private equity" },
  { id: "vc", label: "Venture capital" },
  { id: "independent", label: "Independent" },
];

function parse_filter(value: string | undefined): OwnershipFilter {
  return FILTERS.some((filter) => filter.id === value) ? (value as OwnershipFilter) : "all";
}

function href(filter: OwnershipFilter, search: string, page = 1): string {
  const params = new URLSearchParams();
  if (filter !== "all") params.set("ownership", filter);
  if (search) params.set("q", search);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return `/brands${query ? `?${query}` : ""}`;
}

export default async function BrandsDirectory({ searchParams }: { searchParams: { ownership?: string; q?: string; page?: string } }) {
  const filter = parse_filter(searchParams.ownership);
  const search = (searchParams.q ?? "").slice(0, 100).trim();
  const page = Math.max(1, Math.min(1000, Number.parseInt(searchParams.page ?? "1", 10) || 1));

  let directory: DirectoryPage | null = null;
  try {
    directory = await fetch_brand_directory({ ownership: filter, search, page });
  } catch (caught_error) {
    report_error("[brands] directory failed", caught_error);
  }
  const pages = directory ? Math.max(1, Math.ceil(directory.total / DIRECTORY_PAGE_SIZE)) : 1;

  // Group the current page by first letter.
  const groups = new Map<string, DirectoryPage["brands"]>();
  for (const brand of directory?.brands ?? []) {
    const first = brand.name.trim().charAt(0).toUpperCase();
    const letter = /[A-Z]/.test(first) ? first : "#";
    groups.set(letter, [...(groups.get(letter) ?? []), brand]);
  }

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-6xl space-y-8 px-4 pb-16 pt-8 outline-none sm:px-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">Brands</h1>
        <p className="max-w-2xl text-zinc-400">
          Who owns the coffee shops and bakeries on TrueOwn. Every listing links to the public source behind it.
        </p>
      </header>

      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <nav aria-label="Filter by ownership" className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
          {FILTERS.map((option) => (
            <Link
              key={option.id}
              href={href(option.id, search)}
              aria-current={option.id === filter ? "page" : undefined}
              className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors ${
                option.id === filter ? "border-zinc-100 bg-zinc-100 text-zinc-950" : "border-hairline bg-surface-card text-zinc-300 hover:border-zinc-500"
              }`}
            >
              {option.label}
              {directory && <span className={option.id === filter ? "text-zinc-600" : "text-zinc-500"}>{directory.counts[option.id]}</span>}
            </Link>
          ))}
        </nav>
        <form action="/brands" method="get" role="search" className="flex gap-2">
          {filter !== "all" && <input type="hidden" name="ownership" value={filter} />}
          <input
            name="q"
            defaultValue={search}
            maxLength={100}
            aria-label="Search brands or owners"
            placeholder="Search brands or owners"
            className="min-h-11 w-full rounded-full border border-hairline bg-surface-card px-4 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-zinc-500 md:w-72"
          />
          <button type="submit" className="min-h-11 shrink-0 rounded-full border border-hairline px-4 text-sm font-semibold text-zinc-200 hover:border-zinc-500">
            Search
          </button>
        </form>
      </div>

      {!directory ? (
        <p role="alert" className="rounded-2xl bg-red-500/10 px-4 py-3 text-sm text-red-300">
          The brand list is unavailable right now. Please try again shortly.
        </p>
      ) : directory.brands.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-white/10 px-4 py-10 text-center text-sm text-zinc-400">
          {search ? `No brands match “${search}”.` : "No brands here yet."}
        </p>
      ) : (
        <div className="space-y-8">
          {[...groups.entries()].map(([letter, brands]) => (
            <section key={letter} aria-labelledby={`letter-${letter}`}>
              <h2 id={`letter-${letter}`} className="mb-3 text-sm font-semibold text-zinc-500">
                {letter}
              </h2>
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {brands.map((brand) => (
                  <li key={brand.slug}>
                    <Link
                      href={`/brands/${brand.slug}`}
                      className="flex h-full flex-col gap-2 rounded-2xl bg-surface-card px-4 py-3.5 shadow-hairline transition-colors hover:bg-surface-raised"
                    >
                      <span className="font-semibold text-zinc-50">{brand.name}</span>
                      <span className="flex flex-wrap items-center gap-2">
                        <OwnershipBadge tier={brand.corporate_tier} />
                        <span className="text-xs text-zinc-500">
                          {brand.location_count} location{brand.location_count === 1 ? "" : "s"}
                          {brand.parent_entity ? ` · ${brand.parent_entity}` : ""}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {directory && pages > 1 && (
        <nav aria-label="Pages" className="flex items-center justify-between border-t border-hairline pt-6 text-sm">
          {page > 1 ? (
            <Link href={href(filter, search, page - 1)} className="inline-flex min-h-11 items-center font-semibold text-zinc-200 hover:text-zinc-50">
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-zinc-500">
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <Link href={href(filter, search, page + 1)} className="inline-flex min-h-11 items-center font-semibold text-zinc-200 hover:text-zinc-50">
              Next →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </main>
  );
}
