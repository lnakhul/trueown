import { redirect } from "next/navigation";
import { report_error } from "@/lib/monitoring";
import AdminHeader from "@/components/AdminHeader";
import AdminVettingQueue from "@/components/AdminVettingQueue";
import { resolve_request_admin } from "@/lib/auth/admin-session";
import {
  fetch_pending_submissions,
  fetch_recent_reviews,
  type PendingSubmission,
  type ReviewedSubmission,
} from "@/lib/db/submissions";

// Always read the live queue; never prerender at build time.
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  // Verified again here: the middleware is only the outer gate.
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

  let pending_submissions: PendingSubmission[] = [];
  let recent_reviews: ReviewedSubmission[] = [];
  let load_error: string | null = null;

  try {
    [pending_submissions, recent_reviews] = await Promise.all([
      fetch_pending_submissions(admin),
      fetch_recent_reviews(admin),
    ]);
  } catch (caught_error) {
    report_error("[admin] failed to load the vetting queue", caught_error);
    load_error = "Unable to load the vetting queue. Check the database connection.";
  }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <AdminHeader admin={admin} current="queue" />
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Vetting queue</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Verify each public source before approving. Approval publishes the brand and location, records the
          source as its provenance, and is logged under your account.
        </p>
      </header>

      {load_error ? (
        <p role="alert" className="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {load_error}
        </p>
      ) : (
        <AdminVettingQueue initial_submissions={pending_submissions} recent_reviews={recent_reviews} />
      )}
    </main>
  );
}
