import Link from "next/link";
import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main id="main-content" tabIndex={-1} className="mx-auto flex w-full max-w-xl flex-1 flex-col items-start justify-center gap-4 px-4 py-20 outline-none sm:px-6">
        <p className="text-sm font-medium text-zinc-500">404</p>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">We couldn&apos;t find that page</h1>
        <p className="text-zinc-400">The brand may have been renamed or removed, or the link may be mistyped.</p>
        <div className="flex flex-wrap gap-2 pt-2">
          <Link href="/" className="inline-flex min-h-11 items-center rounded-full bg-zinc-50 px-5 text-sm font-semibold text-zinc-950 hover:bg-white">
            Open the map
          </Link>
          <Link href="/brands" className="inline-flex min-h-11 items-center rounded-full border border-hairline px-5 text-sm font-semibold text-zinc-100 hover:border-zinc-500">
            Browse brands
          </Link>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
