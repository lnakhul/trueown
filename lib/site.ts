/** Site-wide constants and helpers for the public pages. */

/** Canonical origin for links, sitemaps and link previews. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://gettrueown.com").replace(/\/+$/, "");
export const SITE_NAME = "TrueOwn";
export const SITE_TAGLINE = "See who really owns the shops around you, and keep it local.";
/** Public contact address (About, Privacy, Terms). */
export const CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL?.trim() || "hello@gettrueown.com";

export const SITE_NAV = [
  { href: "/", label: "Map" },
  { href: "/brands", label: "Brands" },
  { href: "/owners", label: "Owners" },
  { href: "/how-we-classify", label: "How we classify" },
  { href: "/about", label: "About" },
] as const;

/**
 * URL-safe words joined by hyphens: "Café Grumpy & Co." -> "cafe-grumpy-and-co".
 * Owner pages use it directly; brand slugs are stored (see migration 13).
 */
export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || "owner";
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function absolute_url(path: string): string {
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
