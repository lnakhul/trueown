import { redirect } from "next/navigation";
import AdminHeader from "@/components/AdminHeader";
import AdminStorefrontQueue from "@/components/AdminStorefrontQueue";
import { resolve_request_admin } from "@/lib/auth/admin-session";
import { fetch_storefront_queue, type StorefrontQueue, type StorefrontQueueView } from "@/lib/db/storefronts";
import { report_error } from "@/lib/monitoring";

export const dynamic = "force-dynamic";

const VIEWS: StorefrontQueueView[] = ["chains", "possible", "independents"];

export default async function AdminStorefrontsPage({ searchParams }: { searchParams: { view?: string; q?: string } }) {
  const authorization = await resolve_request_admin();
  if (!authorization.ok) {
    if (authorization.status === 401) redirect("/admin/login");
    if (authorization.status === 403) redirect("/admin/login?error=forbidden");
    return (
      <main className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
        <p role="alert" className="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {authorization.message}
        </p>
      </main>
    );
  }
  const admin = authorization.identity;
  const view: StorefrontQueueView = VIEWS.includes(searchParams.view as StorefrontQueueView)
    ? (searchParams.view as StorefrontQueueView)
    : "chains";
  const search = (searchParams.q ?? "").trim().slice(0, 100);

  let queue: StorefrontQueue | null = null;
  let load_error: string | null = null;
  try {
    queue = await fetch_storefront_queue(admin, "nyc", search || null);
  } catch (caught_error) {
    report_error("[admin/storefronts] failed to load", caught_error);
    load_error = "Unable to load the storefront queue. Has migration 08 been applied to this database?";
  }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <AdminHeader admin={admin} current="storefronts" />
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Storefronts</h1>
        <p className="mt-1 text-sm text-zinc-400">
          NYC coffee, bakery, donut and bagel shops from the city&apos;s restaurant inspection data, waiting for review.
          Nothing appears on the map until you approve it. Refresh the list with{" "}
          <code className="rounded bg-white/[0.06] px-1.5 py-0.5 text-xs">npm run db:import:storefronts</code>.
        </p>
      </header>
      {load_error || !queue ? (
        <p role="alert" className="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {load_error}
        </p>
      ) : (
        <AdminStorefrontQueue queue={queue} view={view} search={search} />
      )}
    </main>
  );
}
