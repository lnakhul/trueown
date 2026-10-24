import Link from "next/link";
import { SITE_NAV } from "@/lib/site";
import BrandMark from "./BrandMark";
import SiteMenu from "./SiteMenu";

function MenuIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

/** Header for every page except the map, which has its own search header. */
export default function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-hairline bg-surface-page/85 backdrop-blur-xl">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="flex min-h-11 items-center gap-2.5 rounded-xl" aria-label="TrueOwn home">
          <BrandMark />
          <span className="text-lg font-semibold tracking-tight text-zinc-50">TrueOwn</span>
        </Link>
        <nav aria-label="Main" className="ml-auto hidden items-center gap-1 md:flex">
          {SITE_NAV.filter((item) => item.href !== "/").map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-50"
            >
              {item.label}
            </Link>
          ))}
          <Link
            href="/"
            className="ml-2 inline-flex min-h-11 items-center rounded-full bg-zinc-50 px-5 text-sm font-semibold text-zinc-950 transition-colors hover:bg-white"
          >
            Open the map
          </Link>
        </nav>
        <SiteMenu className="ml-auto text-zinc-200 md:hidden" label="Open menu">
          <MenuIcon />
        </SiteMenu>
      </div>
    </header>
  );
}
