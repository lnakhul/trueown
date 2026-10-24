import Link from "next/link";
import { CONTACT_EMAIL, SITE_TAGLINE } from "@/lib/site";
import BrandMark from "./BrandMark";
import TipButton from "./TipButton";

const LINK =
  "inline-flex min-h-9 items-center text-sm text-zinc-400 transition-colors hover:text-zinc-100";

const COLUMNS = [
  {
    title: "Explore",
    links: [
      { href: "/", label: "Map" },
      { href: "/brands", label: "Brands" },
      { href: "/owners", label: "Owners & backers" },
    ],
  },
  {
    title: "TrueOwn",
    links: [
      { href: "/about", label: "About" },
      { href: "/how-we-classify", label: "How we classify" },
      { href: "/claim", label: "Claim your business" },
    ],
  },
  {
    title: "Legal",
    links: [
      { href: "/privacy", label: "Privacy" },
      { href: "/terms", label: "Terms" },
    ],
  },
] as const;

export default function SiteFooter() {
  return (
    <footer className="border-t border-hairline">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_3fr]">
        <div className="space-y-4">
          <Link
            href="/"
            className="inline-flex items-center gap-2.5"
            aria-label="TrueOwn home"
          >
            <BrandMark className="h-8 w-8" />
            <span className="font-semibold text-zinc-50">TrueOwn</span>
          </Link>
          <p className="max-w-xs text-sm text-zinc-400">{SITE_TAGLINE}</p>
          <TipButton className="inline-flex min-h-11 items-center rounded-xl bg-white/[0.04] px-4 text-sm font-semibold text-zinc-100 shadow-hairline transition-colors hover:bg-white/[0.08]">
            Know of an ownership change? Submit a tip
          </TipButton>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3">
          {COLUMNS.map((column) => (
            <div key={column.title}>
              <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-500">
                {column.title}
              </h2>
              <ul className="mt-3 space-y-1">
                {column.links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} className={LINK}>
                      {link.label}
                    </Link>
                  </li>
                ))}
                {column.title === "Legal" && (
                  <li>
                    <a
                      href={`mailto:${CONTACT_EMAIL}`}
                      className={`${LINK} break-all`}
                    >
                      {CONTACT_EMAIL}
                    </a>
                  </li>
                )}
              </ul>
            </div>
          ))}
        </div>
      </div>
      <div className="border-t border-hairline">
        <p className="mx-auto w-full max-w-6xl px-4 py-6 text-xs leading-relaxed text-zinc-500 sm:px-6">
          © {new Date().getFullYear()} TrueOwn. Ownership information is
          compiled from public sources and may change; every listing links to
          its evidence. Map data © OpenStreetMap contributors. Storefront data
          from NYC Open Data.
        </p>
      </div>
    </footer>
  );
}
