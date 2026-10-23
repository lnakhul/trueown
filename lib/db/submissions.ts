import type { Pool } from "pg";
import type { ApprovalInput } from "@/lib/approval";
import type { AdminIdentity } from "@/lib/auth/admin-session";
import { with_admin_claims } from "@/lib/db/as-admin";
import { get_database_pool } from "@/lib/db/pool";

export interface PendingSubmission {
  id: string;
  business_name: string;
  street_address: string;
  evidence_url: string;
  created_at: string;
}

export interface ReviewedSubmission {
  id: string;
  business_name: string;
  street_address: string;
  evidence_url: string;
  status: "approved" | "rejected";
  reviewed_at: string;
  reviewer_email: string | null;
  review_note: string | null;
  ownership_source_type: string | null;
  corporate_tier: number | null;
}

/** Domain errors the API layer maps to specific HTTP statuses. */
export class SubmissionNotPendingError extends Error {
  constructor() {
    super("Submission is not pending (already reviewed or missing).");
  }
}
export class BrandTierConflictError extends Error {
  constructor() {
    super("A brand with this name already exists with a different corporate tier.");
  }
}
export class AdminPrivilegeError extends Error {
  constructor() {
    super("Admin role required.");
  }
}
export class ApprovalRejectedError extends Error {}

export const MAX_RECENT_REVIEWS = 25;

/** Maps the routines' RAISE codes to domain errors. */
function translate_database_error(caught_error: unknown): never {
  const message = caught_error instanceof Error ? caught_error.message : "";
  if (message.includes("not_admin") || message.includes("permission denied")) throw new AdminPrivilegeError();
  if (message.includes("submission_not_pending")) throw new SubmissionNotPendingError();
  if (message.includes("brand_tier_conflict")) throw new BrandTierConflictError();
  if (message.includes("invalid_source_type")) {
    throw new ApprovalRejectedError("ownership_source_type does not fit the corporate tier.");
  }
  if (message.includes("location_outside_markets")) {
    throw new ApprovalRejectedError("The coordinates are not within 50 miles of any market.");
  }
  if (message.includes("independent_market_mismatch")) {
    throw new ApprovalRejectedError("This independent already trades in another market.");
  }
  throw caught_error;
}

/** Oldest first so the queue is worked in submission order. Read under the admin's RLS scope. */
export async function fetch_pending_submissions(
  admin: AdminIdentity,
  pool: Pool = get_database_pool(),
): Promise<PendingSubmission[]> {
  return with_admin_claims(
    admin.claims,
    async (client) => {
      const result = await client.query<{
        id: string;
        business_name: string;
        street_address: string;
        evidence_url: string;
        created_at: Date;
      }>(
        `SELECT id, business_name, street_address, evidence_url, created_at
           FROM submissions
          WHERE status = 'pending'
          ORDER BY created_at ASC`,
      );
      return result.rows.map((row) => ({ ...row, created_at: row.created_at.toISOString() }));
    },
    pool,
  );
}

/** The most recent decisions with who made them, newest first. */
export async function fetch_recent_reviews(
  admin: AdminIdentity,
  pool: Pool = get_database_pool(),
  limit: number = MAX_RECENT_REVIEWS,
): Promise<ReviewedSubmission[]> {
  return with_admin_claims(
    admin.claims,
    async (client) => {
      const result = await client.query<Omit<ReviewedSubmission, "reviewed_at"> & { reviewed_at: Date }>(
        `SELECT s.id, s.business_name, s.street_address, s.evidence_url, s.status,
                s.reviewed_at, s.review_note,
                a.actor_email AS reviewer_email,
                a.payload ->> 'ownership_source_type' AS ownership_source_type,
                (a.payload ->> 'corporate_tier')::int AS corporate_tier
           FROM submissions s
           LEFT JOIN LATERAL (
             SELECT actor_email, payload FROM admin_audit_log
              WHERE submission_id = s.id ORDER BY created_at DESC LIMIT 1
           ) a ON true
          WHERE s.status <> 'pending' AND s.reviewed_at IS NOT NULL
          ORDER BY s.reviewed_at DESC
          LIMIT $1`,
        [limit],
      );
      return result.rows.map((row) => ({ ...row, reviewed_at: row.reviewed_at.toISOString() }));
    },
    pool,
  );
}

/**
 * Approves via approve_submission(): one atomic statement that checks the admin
 * claims, flips status, records provenance, inserts the brand + location and
 * appends to the audit log, or rolls back entirely.
 */
export async function approve_pending_submission(
  admin: AdminIdentity,
  submission_id: string,
  approval: ApprovalInput,
  pool: Pool = get_database_pool(),
): Promise<string> {
  try {
    return await with_admin_claims(
      admin.claims,
      async (client) => {
        const result = await client.query<{ location_id: string }>(
          `SELECT approve_submission($1, $2, $3, $4::industry_vertical, $5, $6, $7, $8) AS location_id`,
          [
            submission_id,
            approval.corporate_tier,
            approval.parent_entity,
            approval.industry_vertical,
            approval.unique_selling_proposition,
            approval.ownership_source_type,
            approval.latitude,
            approval.longitude,
          ],
        );
        const row = result.rows[0];
        if (!row) throw new Error("approve_submission returned no row.");
        return row.location_id;
      },
      pool,
    );
  } catch (caught_error) {
    translate_database_error(caught_error);
  }
}

/** Only pending rows can be rejected; decided rows are immutable. */
export async function reject_pending_submission(
  admin: AdminIdentity,
  submission_id: string,
  review_note: string | null,
  pool: Pool = get_database_pool(),
): Promise<void> {
  try {
    await with_admin_claims(
      admin.claims,
      (client) => client.query("SELECT reject_submission($1, $2)", [submission_id, review_note]),
      pool,
    );
  } catch (caught_error) {
    translate_database_error(caught_error);
  }
}
