import type { Pool } from "pg";
import { get_database_pool } from "@/lib/db/pool";
import type { ApprovalInput } from "@/lib/approval";

export interface PendingSubmission {
  id: string;
  business_name: string;
  street_address: string;
  evidence_url: string;
  created_at: string;
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

/** Oldest first so the queue is worked in submission order. */
export async function fetch_pending_submissions(
  pool: Pool = get_database_pool(),
): Promise<PendingSubmission[]> {
  const result = await pool.query<{
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
  return result.rows.map((row) => ({
    id: row.id,
    business_name: row.business_name,
    street_address: row.street_address,
    evidence_url: row.evidence_url,
    created_at: row.created_at.toISOString(),
  }));
}

/**
 * Approves via the approve_submission() routine: a single atomic statement that
 * flips status and inserts the brand + location, or rolls back entirely.
 */
export async function approve_pending_submission(
  submission_id: string,
  approval: ApprovalInput,
  pool: Pool = get_database_pool(),
): Promise<string> {
  try {
    const result = await pool.query<{ location_id: string }>(
      `SELECT approve_submission($1, $2, $3, $4::industry_vertical, $5, $6, $7, $8) AS location_id`,
      [
        submission_id,
        approval.corporate_tier,
        approval.parent_entity,
        approval.industry_vertical,
        approval.unique_selling_proposition,
        approval.latitude,
        approval.longitude,
        approval.city,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("approve_submission returned no row.");
    return row.location_id;
  } catch (caught_error) {
    const message = caught_error instanceof Error ? caught_error.message : "";
    if (message.includes("submission_not_pending")) throw new SubmissionNotPendingError();
    if (message.includes("brand_tier_conflict")) throw new BrandTierConflictError();
    throw caught_error;
  }
}

/** Only pending rows can be rejected; decided rows are immutable here. */
export async function reject_pending_submission(
  submission_id: string,
  pool: Pool = get_database_pool(),
): Promise<void> {
  const result = await pool.query(
    `UPDATE submissions
        SET status = 'rejected', reviewed_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [submission_id],
  );
  if (result.rowCount === 0) throw new SubmissionNotPendingError();
}
