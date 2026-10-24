import { randomUUID } from "crypto";
import type { Pool } from "pg";
import type { AdminIdentity } from "@/lib/auth/admin-session";
import type { BusinessClaimInput, ClaimOutcome, ClaimantRole } from "@/lib/claims";
import { with_admin_claims } from "@/lib/db/as-admin";
import { get_database_pool } from "@/lib/db/pool";
import { create_anon_client } from "@/lib/supabase/server";

export class ClaimListingError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
  }
}
export class ClaimChangeRejectedError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 409 | 422,
  ) {
    super(message);
  }
}

export interface ClaimableListing {
  location_id: string;
  brand_id: string;
  brand_name: string;
  address: string;
  corporate_tier: 1 | 2 | 3;
}

/** The listing an owner is claiming, looked up server-side (public data). */
export async function fetch_claimable_listing(location_id: string, pool: Pool = get_database_pool()): Promise<ClaimableListing | null> {
  const result = await pool.query<ClaimableListing>(
    `SELECT l.id AS location_id, b.id AS brand_id, b.name AS brand_name, l.address, b.corporate_tier
       FROM locations l JOIN brands b ON b.id = l.brand_id WHERE l.id = $1`,
    [location_id],
  );
  return result.rows[0] ?? null;
}

/**
 * Stores an open claim. A listed business must be shown as independent: a corporate
 * listing that is wrong goes through "Report an error" instead.
 */
export async function create_business_claim(input: BusinessClaimInput, pool: Pool = get_database_pool()): Promise<string> {
  let listing: ClaimableListing | null = null;
  if (input.location_id) {
    listing = await fetch_claimable_listing(input.location_id, pool);
    if (!listing) throw new ClaimListingError("That listing no longer exists.", 404);
    if (listing.corporate_tier !== 3) {
      throw new ClaimListingError("This listing is shown as corporate-backed. If that is wrong, use Report an error on its card.", 409);
    }
  }
  const claim_id = randomUUID();
  const row = {
    id: claim_id,
    location_id: listing?.location_id ?? null,
    brand_id: listing?.brand_id ?? null,
    business_name: (listing?.brand_name ?? input.business_name).slice(0, 200),
    business_address: (listing?.address ?? input.business_address).slice(0, 300),
    claimant_name: input.claimant_name,
    claimant_role: input.claimant_role,
    contact_email: input.contact_email,
    contact_phone: input.contact_phone,
    website_url: input.website_url,
    attests_independent: true,
    details: input.details,
    status: "open",
  };

  const anon_client = create_anon_client();
  if (anon_client) {
    const { error } = await anon_client.from("business_claims").insert(row);
    if (error) throw new Error(`business claim insert rejected: ${error.code ?? ""} ${error.message}`);
    return claim_id;
  }
  await pool.query(
    `INSERT INTO business_claims (id, location_id, brand_id, business_name, business_address, claimant_name, claimant_role,
                                  contact_email, contact_phone, website_url, attests_independent, details, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11, 'open')`,
    [row.id, row.location_id, row.brand_id, row.business_name, row.business_address, row.claimant_name, row.claimant_role,
     row.contact_email, row.contact_phone, row.website_url, row.details],
  );
  return claim_id;
}

export interface BusinessClaimRecord {
  id: string;
  business_name: string;
  business_address: string;
  location_id: string | null;
  brand_id: string | null;
  listing_tier: number | null;
  listing_source_type: string | null;
  claimant_name: string;
  claimant_role: ClaimantRole;
  contact_email: string;
  contact_phone: string | null;
  website_url: string;
  details: string | null;
  status: "open" | "verified" | "rejected";
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
  resolver_email: string | null;
}

export type ClaimListFilter = "open" | "closed";

export async function fetch_business_claims(
  admin: AdminIdentity,
  filter: ClaimListFilter = "open",
  pool: Pool = get_database_pool(),
): Promise<BusinessClaimRecord[]> {
  return with_admin_claims(
    admin.claims,
    async (client) => {
      const result = await client.query<
        Omit<BusinessClaimRecord, "created_at" | "resolved_at"> & { created_at: Date; resolved_at: Date | null }
      >(
        `SELECT c.id, c.business_name, c.business_address, c.location_id, c.brand_id,
                b.corporate_tier AS listing_tier, b.ownership_source_type AS listing_source_type,
                c.claimant_name, c.claimant_role, c.contact_email, c.contact_phone, c.website_url, c.details,
                c.status, c.created_at, c.resolved_at, c.resolution_note, a.actor_email AS resolver_email
           FROM business_claims c
           LEFT JOIN brands b ON b.id = c.brand_id
           LEFT JOIN LATERAL (
             SELECT actor_email FROM admin_audit_log
              WHERE payload ->> 'business_claim_id' = c.id::text ORDER BY created_at DESC LIMIT 1
           ) a ON true
          WHERE ($1 = 'open') = (c.status = 'open')
          ORDER BY CASE WHEN $1 = 'open' THEN c.created_at END ASC, c.resolved_at DESC NULLS LAST
          LIMIT 100`,
        [filter],
      );
      return result.rows.map((row) => ({
        ...row,
        created_at: row.created_at.toISOString(),
        resolved_at: row.resolved_at ? row.resolved_at.toISOString() : null,
      }));
    },
    pool,
  );
}

export async function resolve_business_claim(
  admin: AdminIdentity,
  claim_id: string,
  outcome: ClaimOutcome,
  note: string | null,
  record_evidence: boolean,
  pool: Pool = get_database_pool(),
): Promise<void> {
  try {
    await with_admin_claims(
      admin.claims,
      (client) => client.query("SELECT resolve_business_claim($1, $2, $3, $4)", [claim_id, outcome, note, record_evidence]),
      pool,
    );
  } catch (caught_error) {
    const message = caught_error instanceof Error ? caught_error.message : "";
    if (message.includes("not_admin") || message.includes("permission denied")) throw new ClaimChangeRejectedError("Admin role required.", 403);
    if (message.includes("claim_not_open")) throw new ClaimChangeRejectedError("This claim was already closed.", 409);
    if (message.includes("note_required")) throw new ClaimChangeRejectedError("Say why the claim is rejected.", 422);
    if (message.includes("evidence_needs_independent_listing")) {
      throw new ClaimChangeRejectedError("Only an independent listing can use the owner's confirmation as its evidence.", 422);
    }
    throw caught_error;
  }
}
