import { redirect } from "next/navigation";
import AdminCorrectionsInbox from "@/components/AdminCorrectionsInbox";
import AdminHeader from "@/components/AdminHeader";
import { resolve_request_admin } from "@/lib/auth/admin-session";
import { fetch_correction_requests, type CorrectionListFilter, type CorrectionRequestRecord } from "@/lib/db/corrections";
import { report_error } from "@/lib/monitoring";

export const dynamic = "force-dynamic";

export default async function AdminCorrectionsPage({ searchParams }: { searchParams: { filter?: string } }) {
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
  const filter: CorrectionListFilter = searchParams.filter === "closed" ? "closed" : "open";

  let requests: CorrectionRequestRecord[] = [];
  let load_error: string | null = null;
  try {
    requests = await fetch_correction_requests(admin, filter);
  } catch (caught_error) {
    report_error("[admin/corrections] failed to load", caught_error);
    load_error = "Unable to load error reports. Check the database connection.";
  }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <AdminHeader admin={admin} current="corrections" />
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Error reports</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Reports from owners, staff and visitors who say a listing is wrong. Check the claim, fix the brand on the Brands
          page if needed, then close the report. Dismissing a report needs a reason. Contact emails are personal data: use
          them only to follow up on the report.
        </p>
      </header>
      {load_error ? (
        <p role="alert" className="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {load_error}
        </p>
      ) : (
        <AdminCorrectionsInbox requests={requests} filter={filter} />
      )}
    </main>
  );
}
