import AdminVettingQueue from "@/components/AdminVettingQueue";
import { fetch_pending_submissions, type PendingSubmission } from "@/lib/db/submissions";

// Always read the live queue; never prerender at build time.
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  let pending_submissions: PendingSubmission[] = [];
  let load_error: string | null = null;

  try {
    pending_submissions = await fetch_pending_submissions();
  } catch (caught_error) {
    console.error("[admin] failed to load pending submissions:", caught_error);
    load_error = "Unable to load the vetting queue. Check the database connection.";
  }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <header>
        <h1 className="text-2xl font-extrabold text-zinc-900">Vetting queue</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Verify each public source before approving. Approval publishes the brand and location.
        </p>
      </header>

      {load_error ? (
        <p role="alert" className="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-700">
          {load_error}
        </p>
      ) : (
        <AdminVettingQueue initial_submissions={pending_submissions} />
      )}
    </main>
  );
}
