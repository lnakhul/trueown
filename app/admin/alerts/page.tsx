import { redirect } from "next/navigation";
import AdminAlertsInbox from "@/components/AdminAlertsInbox";
import AdminHeader from "@/components/AdminHeader";
import { resolve_request_admin } from "@/lib/auth/admin-session";
import { fetch_ownership_alerts, type AlertListFilter, type BrandAlertGroup } from "@/lib/db/alerts";
import { report_error } from "@/lib/monitoring";

export const dynamic = "force-dynamic";

export default async function AdminAlertsPage({ searchParams }: { searchParams: { filter?: string } }) {
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
  const filter: AlertListFilter = searchParams.filter === "closed" ? "closed" : "open";

  let groups: BrandAlertGroup[] = [];
  let load_error: string | null = null;
  try {
    groups = await fetch_ownership_alerts(admin, filter);
  } catch (caught_error) {
    report_error("[admin/alerts] failed to load", caught_error);
    load_error = "Unable to load ownership alerts. Has migration 12 been applied to this database?";
  }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <AdminHeader admin={admin} current="alerts" />
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Ownership alerts</h1>
        <p className="mt-1 text-sm text-zinc-400">
          News and SEC filings that name a brand on the map next to an acquisition, investment or IPO. An alert is a lead,
          not evidence: open the source, then update the listing, keep it with this source as fresh evidence, or dismiss it.
        </p>
      </header>
      {load_error ? (
        <p role="alert" className="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {load_error}
        </p>
      ) : (
        <AdminAlertsInbox groups={groups} filter={filter} />
      )}
    </main>
  );
}
