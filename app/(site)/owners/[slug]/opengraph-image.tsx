import { fetch_owner_page } from "@/lib/db/directory";
import { OG_SIZE, og_card } from "@/lib/og-card";
import { SLUG_PATTERN } from "@/lib/site";
import { summarize_names } from "@/lib/ui/ownership-labels";

export const runtime = "nodejs";
export const revalidate = 600;
export const alt = "What this owner or investor owns, on TrueOwn";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function Image({ params }: { params: { slug: string } }) {
  const owner = SLUG_PATTERN.test(params.slug) ? await fetch_owner_page(params.slug).catch(() => null) : null;
  if (!owner) return og_card({ title: "Who really owns the shops around you?" });
  return og_card({
    eyebrow: "What do they own?",
    title: owner.name,
    tag: `${owner.brands.length} brand${owner.brands.length === 1 ? "" : "s"} · ${owner.location_count} location${owner.location_count === 1 ? "" : "s"}`,
    tone: "corporate",
    body: summarize_names(owner.brands.map((brand) => brand.name), 4),
  });
}
