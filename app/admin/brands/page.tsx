import { redirect } from "next/navigation";
import AdminBrandReview from "@/components/AdminBrandReview";
import AdminHeader from "@/components/AdminHeader";
import { resolve_request_admin } from "@/lib/auth/admin-session";
import { fetch_brands_for_review, type BrandForReview, type BrandReviewFilter } from "@/lib/db/brands";
import { report_error } from "@/lib/monitoring";
import { PROVENANCE_STALE_AFTER_DAYS } from "@/lib/provenance";

export const dynamic = "force-dynamic";

const MAX_SEARCH_LENGTH = 100;

export default async function AdminBrandsPage({
  searchParams,
}: {
  searchParams: { filter?: string; q?: string };
}) {
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
  const filter: BrandReviewFilter = searchParams.filter === "all" ? "all" : "needs_review";
  const search = (searchParams.q ?? "").trim().slice(0, MAX_SEARCH_LENGTH);

  let brands: BrandForReview[] = [];
  let load_error: string | null = null;
  try {
    brands = await fetch_brands_for_review(admin, { filter, search: search || null });
  } catch (caught_error) {
    report_error("[admin/brands] failed to load brands", caught_error);
    load_error = "Unable to load brands. Check the database connection.";
  }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <AdminHeader admin={admin} current="brands" />
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Brands</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Ownership changes over time. Re-verify claims with no source or one checked more than{" "}
          {Math.round(PROVENANCE_STALE_AFTER_DAYS / 30)} months ago, and correct any that have changed. Every change
          is logged under your account.
        </p>
      </header>
      {load_error ? (
        <p role="alert" className="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {load_error}
        </p>
      ) : (
        <AdminBrandReview brands={brands} filter={filter} search={search} />
      )}
    </main>
  );
}
