import { randomUUID } from "crypto";
import type { Pool } from "pg";
import type { AdminIdentity } from "@/lib/auth/admin-session";
import type { CorrectionIssue, CorrectionOutcome, CorrectionRequestInput, ReporterRelationship } from "@/lib/corrections";
import { with_admin_claims } from "@/lib/db/as-admin";
import { get_database_pool } from "@/lib/db/pool";
import { create_anon_client } from "@/lib/supabase/server";

export class ListingNotFoundError extends Error {
  constructor() {
    super("That listing no longer exists.");
  }
}
export class CorrectionChangeRejectedError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 404 | 409 | 422,
  ) {
    super(message);
  }
}

/** The listing being reported, looked up server-side (never trusted from the client). */
async function fetch_listing(location_id: string, pool: Pool): Promise<{ brand_id: string; brand_name: string; address: string }> {
  const result = await pool.query<{ brand_id: string; brand_name: string; address: string }>(
    `SELECT b.id AS brand_id, b.name AS brand_name, l.address
       FROM locations l JOIN brands b ON b.id = l.brand_id
      WHERE l.id = $1`,
    [location_id],
  );
  const listing = result.rows[0];
  if (!listing) throw new ListingNotFoundError();
  return listing;
}

/**
 * Stores an open correction request. With Supabase configured the insert runs as
 * the `anon` role so RLS applies (status is forced to 'open' by policy); locally it
 * falls back to the owner connection.
 */
export async function create_correction_request(
  input: CorrectionRequestInput,
  pool: Pool = get_database_pool(),
): Promise<string> {
  const listing = await fetch_listing(input.location_id, pool);
  const request_id = randomUUID();
  const row = {
    id: request_id,
    brand_id: listing.brand_id,
    location_id: input.location_id,
    brand_name_snapshot: listing.brand_name.slice(0, 200),
    address_snapshot: listing.address.slice(0, 300),
    issue: input.issue,
    details: input.details,
    reporter_relationship: input.reporter_relationship,
    contact_email: input.contact_email,
    evidence_url: input.evidence_url,
    status: "open",
  };

  const anon_client = create_anon_client();
  if (anon_client) {
    const { error } = await anon_client.from("correction_requests").insert(row);
    if (error) throw new Error(`correction request insert rejected: ${error.code ?? ""} ${error.message}`);
    return request_id;
  }

  await pool.query(
    `INSERT INTO correction_requests (id, brand_id, location_id, brand_name_snapshot, address_snapshot, issue, details,
                                      reporter_relationship, contact_email, evidence_url, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'open')`,
    [
      row.id,
      row.brand_id,
      row.location_id,
      row.brand_name_snapshot,
      row.address_snapshot,
      row.issue,
      row.details,
      row.reporter_relationship,
      row.contact_email,
      row.evidence_url,
    ],
  );
  return request_id;
}

export interface CorrectionRequestRecord {
  id: string;
  brand_id: string | null;
  brand_name: string;
  address: string | null;
  issue: CorrectionIssue;
  details: string;
  reporter_relationship: ReporterRelationship;
  contact_email: string | null;
  evidence_url: string | null;
  status: "open" | "resolved" | "dismissed";
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
  resolver_email: string | null;
}

export type CorrectionListFilter = "open" | "closed";
export const MAX_CORRECTIONS_PER_PAGE = 100;

/** Open requests oldest first (work them in order); closed ones newest first. */
export async function fetch_correction_requests(
  admin: AdminIdentity,
  filter: CorrectionListFilter = "open",
  pool: Pool = get_database_pool(),
): Promise<CorrectionRequestRecord[]> {
  return with_admin_claims(
    admin.claims,
    async (client) => {
      const result = await client.query<
        Omit<CorrectionRequestRecord, "created_at" | "resolved_at"> & { created_at: Date; resolved_at: Date | null }
      >(
        `SELECT c.id, c.brand_id, COALESCE(b.name, c.brand_name_snapshot) AS brand_name, c.address_snapshot AS address,
                c.issue, c.details, c.reporter_relationship, c.contact_email, c.evidence_url, c.status,
                c.created_at, c.resolved_at, c.resolution_note, a.actor_email AS resolver_email
           FROM correction_requests c
           LEFT JOIN brands b ON b.id = c.brand_id
           LEFT JOIN LATERAL (
             SELECT actor_email FROM admin_audit_log
              WHERE payload ->> 'correction_request_id' = c.id::text
              ORDER BY created_at DESC LIMIT 1
           ) a ON true
          WHERE ($1 = 'open') = (c.status = 'open')
          ORDER BY CASE WHEN $1 = 'open' THEN c.created_at END ASC,
                   c.resolved_at DESC NULLS LAST
          LIMIT $2`,
        [filter, MAX_CORRECTIONS_PER_PAGE],
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

export async function resolve_correction_request(
  admin: AdminIdentity,
  request_id: string,
  outcome: CorrectionOutcome,
  note: string | null,
  pool: Pool = get_database_pool(),
): Promise<void> {
  try {
    await with_admin_claims(
      admin.claims,
      (client) => client.query("SELECT resolve_correction_request($1, $2, $3)", [request_id, outcome, note]),
      pool,
    );
  } catch (caught_error) {
    const message = caught_error instanceof Error ? caught_error.message : "";
    if (message.includes("not_admin") || message.includes("permission denied")) {
      throw new CorrectionChangeRejectedError("Admin role required.", 403);
    }
    if (message.includes("request_not_open")) {
      throw new CorrectionChangeRejectedError("This report was already closed.", 409);
    }
    if (message.includes("note_required")) throw new CorrectionChangeRejectedError("Say why the report is being dismissed.", 422);
    throw caught_error;
  }
}
