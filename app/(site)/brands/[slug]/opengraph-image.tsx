import { fetch_brand_page } from "@/lib/db/directory";
import { OG_SIZE, og_card } from "@/lib/og-card";
import { SLUG_PATTERN } from "@/lib/site";
import { OWNERSHIP_TAG, ownership_sentence } from "@/lib/ui/ownership-labels";

export const runtime = "nodejs";
export const revalidate = 600;
export const alt = "Who owns this brand, on TrueOwn";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function Image({ params }: { params: { slug: string } }) {
  const brand = SLUG_PATTERN.test(params.slug) ? await fetch_brand_page(params.slug).catch(() => null) : null;
  if (!brand) return og_card({ title: "Who really owns the shops around you?" });
  return og_card({
    eyebrow: "Who owns it?",
    title: brand.name,
    tag: OWNERSHIP_TAG[brand.corporate_tier],
    tone: brand.corporate_tier === 3 ? "independent" : "corporate",
    body: brand.corporate_tier === 3 ? "Independently owned. Find it on TrueOwn." : ownership_sentence(brand).replace(`${brand.name} is `, "").replace(/^\w/, (c) => c.toUpperCase()),
  });
}
