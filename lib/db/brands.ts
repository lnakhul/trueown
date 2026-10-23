import type { Pool } from "pg";
import type { CorrectionInput, ReverifyInput } from "@/lib/brand-review";
import type { AdminIdentity } from "@/lib/auth/admin-session";
import { with_admin_claims } from "@/lib/db/as-admin";
import { get_database_pool } from "@/lib/db/pool";
import { PROVENANCE_STALE_AFTER_DAYS, type OwnershipSource } from "@/lib/provenance";
import type { IndustryVertical } from "@/lib/types";

export interface BrandForReview {
  id: string;
  name: string;
  corporate_tier: 1 | 2 | 3;
  parent_entity: string | null;
  financial_backers: string[];
  industry_vertical: IndustryVertical;
  home_market: string | null;
  storefront_count: number;
  market_names: string[];
  source: OwnershipSource | null;
  /** Open "Report an error" requests about this brand. */
  open_reports: number;
  last_action: { action: string; actor_email: string | null; at: string } | null;
}

export type BrandReviewFilter = "needs_review" | "all";
export const MAX_BRANDS_PER_PAGE = 200;

/** Domain errors the admin API maps to HTTP statuses. */
export class BrandNotFoundError extends Error {
  constructor() {
    super("Brand not found.");
  }
}
export class BrandChangeRejectedError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 409 | 422,
  ) {
    super(message);
  }
}

function translate_brand_error(caught_error: unknown): never {
  const message = caught_error instanceof Error ? caught_error.message : "";
  if (message.includes("not_admin") || message.includes("permission denied")) {
    throw new BrandChangeRejectedError("Admin role required.", 403);
  }
  if (message.includes("brand_not_found")) throw new BrandNotFoundError();
  if (message.includes("invalid_source_type")) {
    throw new BrandChangeRejectedError("That source type does not fit this brand's tier.", 422);
  }
  if (message.includes("parent_required")) {
    throw new BrandChangeRejectedError("Tier 1 and Tier 2 brands need a parent entity.", 422);
  }
  if (message.includes("note_required")) throw new BrandChangeRejectedError("Say why the claim is changing.", 422);
  if (message.includes("independent_spans_markets")) {
    throw new BrandChangeRejectedError(
      "This brand has storefronts in more than one market, so it cannot become a local independent.",
      422,
    );
  }
  if (message.includes("brand_tier_conflict")) {
    throw new BrandChangeRejectedError("Another brand with this name already has a different tier.", 409);
  }
  if (message.includes("brand_name_conflict")) {
    throw new BrandChangeRejectedError("Another brand with this name already exists in that scope.", 409);
  }
  throw caught_error;
}

interface BrandRow {
  id: string;
  name: string;
  corporate_tier: number;
  parent_entity: string | null;
  financial_backers: string[] | null;
  industry_vertical: IndustryVertical;
  home_market: string | null;
  storefront_count: number;
  open_reports: number;
  market_names: string[] | null;
  ownership_source_type: string | null;
  ownership_source_url: string | null;
  ownership_verified_on: string | null;
  last_action: string | null;
  last_actor_email: string | null;
  last_action_at: Date | null;
}

/**
 * Live brands for the admin review page. "needs_review" = an open error report, no
 * recorded source, or verified more than PROVENANCE_STALE_AFTER_DAYS ago. Reported
 * brands first, then unsourced, then oldest.
 */
export async function fetch_brands_for_review(
  admin: AdminIdentity,
  options: { filter?: BrandReviewFilter; search?: string | null } = {},
  pool: Pool = get_database_pool(),
): Promise<BrandForReview[]> {
  const search = options.search?.trim() || null;
  return with_admin_claims(
    admin.claims,
    async (client) => {
      const result = await client.query<BrandRow>(
        `SELECT b.id, b.name, b.corporate_tier, b.parent_entity, b.financial_backers, b.industry_vertical,
                hm.slug AS home_market,
                (SELECT count(*)::int FROM locations l WHERE l.brand_id = b.id) AS storefront_count,
                (SELECT count(*)::int FROM correction_requests c WHERE c.brand_id = b.id AND c.status = 'open') AS open_reports,
                (SELECT array_agg(DISTINCT m.city_name ORDER BY m.city_name)
                   FROM locations l JOIN markets m ON m.id = l.market_id WHERE l.brand_id = b.id) AS market_names,
                b.ownership_source_type, b.ownership_source_url,
                to_char(b.ownership_verified_on, 'YYYY-MM-DD') AS ownership_verified_on,
                a.action AS last_action, a.actor_email AS last_actor_email, a.created_at AS last_action_at
           FROM brands b
           LEFT JOIN markets hm ON hm.id = b.home_market_id
           LEFT JOIN LATERAL (
             SELECT action, actor_email, created_at FROM admin_audit_log
              WHERE brand_id = b.id ORDER BY created_at DESC LIMIT 1
           ) a ON true
          WHERE ($1 = 'all'
                 OR b.ownership_source_url IS NULL
                 OR EXISTS (SELECT 1 FROM correction_requests c WHERE c.brand_id = b.id AND c.status = 'open')
                 OR b.ownership_verified_on < current_date - $2::int)
            AND ($3::text IS NULL OR strpos(lower(b.name), lower($3)) > 0)
          ORDER BY EXISTS (SELECT 1 FROM correction_requests c WHERE c.brand_id = b.id AND c.status = 'open') DESC,
                   (b.ownership_source_url IS NULL) DESC, b.ownership_verified_on ASC NULLS FIRST,
                   b.corporate_tier, b.name
          LIMIT $4`,
        [options.filter ?? "needs_review", PROVENANCE_STALE_AFTER_DAYS, search, MAX_BRANDS_PER_PAGE],
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        corporate_tier: row.corporate_tier as 1 | 2 | 3,
        parent_entity: row.parent_entity,
        financial_backers: row.financial_backers ?? [],
        industry_vertical: row.industry_vertical,
        home_market: row.home_market,
        storefront_count: row.storefront_count,
        open_reports: row.open_reports,
        market_names: row.market_names ?? [],
        source:
          row.ownership_source_type && row.ownership_source_url && row.ownership_verified_on
            ? {
                source_type: row.ownership_source_type,
                source_url: row.ownership_source_url,
                verified_on: row.ownership_verified_on,
              }
            : null,
        last_action:
          row.last_action && row.last_action_at
            ? { action: row.last_action, actor_email: row.last_actor_email, at: row.last_action_at.toISOString() }
            : null,
      }));
    },
    pool,
  );
}

/** Same claim, fresh evidence: audited by reverify_brand(). */
export async function reverify_brand_claim(
  admin: AdminIdentity,
  brand_id: string,
  input: ReverifyInput,
  pool: Pool = get_database_pool(),
): Promise<void> {
  try {
    await with_admin_claims(
      admin.claims,
      (client) =>
        client.query("SELECT reverify_brand($1, $2, $3)", [
          brand_id,
          input.ownership_source_type,
          input.ownership_source_url,
        ]),
      pool,
    );
  } catch (caught_error) {
    translate_brand_error(caught_error);
  }
}

/** Changes tier / parent / backers with new evidence and a reason: audited by correct_brand(). */
export async function correct_brand_claim(
  admin: AdminIdentity,
  brand_id: string,
  input: CorrectionInput,
  pool: Pool = get_database_pool(),
): Promise<void> {
  try {
    await with_admin_claims(
      admin.claims,
      (client) =>
        client.query("SELECT correct_brand($1, $2, $3, $4, $5, $6, $7)", [
          brand_id,
          input.corporate_tier,
          input.parent_entity,
          input.financial_backers,
          input.ownership_source_type,
          input.ownership_source_url,
          input.review_note,
        ]),
      pool,
    );
  } catch (caught_error) {
    translate_brand_error(caught_error);
  }
}
