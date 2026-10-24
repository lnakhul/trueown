import { redirect } from "next/navigation";
import AdminClaimsInbox from "@/components/AdminClaimsInbox";
import AdminHeader from "@/components/AdminHeader";
import { resolve_request_admin } from "@/lib/auth/admin-session";
import { fetch_business_claims, type BusinessClaimRecord, type ClaimListFilter } from "@/lib/db/claims";
import { report_error } from "@/lib/monitoring";

export const dynamic = "force-dynamic";

export default async function AdminClaimsPage({ searchParams }: { searchParams: { filter?: string } }) {
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
  const filter: ClaimListFilter = searchParams.filter === "closed" ? "closed" : "open";

  let claims: BusinessClaimRecord[] = [];
  let load_error: string | null = null;
  try {
    claims = await fetch_business_claims(admin, filter);
  } catch (caught_error) {
    report_error("[admin/claims] failed to load", caught_error);
    load_error = "Unable to load owner claims. Has migration 10 been applied to this database?";
  }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <AdminHeader admin={admin} current="claims" />
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Owner claims</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Owners confirming their business is independent. Check that the website and email belong to the business (for
          example, email from the business&apos;s own domain, or call the shop) before verifying. Contact details are
          personal data: use them only about this claim.
        </p>
      </header>
      {load_error ? (
        <p role="alert" className="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {load_error}
        </p>
      ) : (
        <AdminClaimsInbox claims={claims} filter={filter} />
      )}
    </main>
  );
}
