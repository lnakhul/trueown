import type { MetadataRoute } from "next";
import { fetch_owners, fetch_public_brand_slugs } from "@/lib/db/directory";
import { report_error } from "@/lib/monitoring";
import { absolute_url } from "@/lib/site";

// Built per request (cached by the CDN), so new brands appear without a redeploy
// and builds never need the database.
export const dynamic = "force-dynamic";

const STATIC_PAGES = ["/", "/brands", "/owners", "/how-we-classify", "/about", "/claim", "/privacy", "/terms"];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries: MetadataRoute.Sitemap = STATIC_PAGES.map((path) => ({
    url: absolute_url(path),
    changeFrequency: path === "/" || path === "/brands" ? "daily" : "monthly",
    priority: path === "/" ? 1 : path === "/brands" ? 0.9 : 0.5,
  }));
  try {
    const [brands, owners] = await Promise.all([fetch_public_brand_slugs(), fetch_owners()]);
    for (const brand of brands) {
      entries.push({
        url: absolute_url(`/brands/${brand.slug}`),
        ...(brand.verified_on ? { lastModified: brand.verified_on } : {}),
        changeFrequency: "weekly",
        priority: 0.8,
      });
    }
    for (const owner of owners) {
      entries.push({ url: absolute_url(`/owners/${owner.slug}`), changeFrequency: "weekly", priority: 0.6 });
    }
  } catch (caught_error) {
    report_error("[sitemap] failed to list brands", caught_error);
  }
  return entries;
}
