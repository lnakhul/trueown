import type { Pool } from "pg";
import type { AdminIdentity } from "@/lib/auth/admin-session";
import { with_admin_claims } from "@/lib/db/as-admin";
import { BrandChangeRejectedError, translate_brand_error } from "@/lib/db/brands";
import { get_database_pool } from "@/lib/db/pool";
import type { AlertSignal, AlertSource } from "@/lib/import/ownership-watch";
import type { AlertResolution } from "@/lib/ownership-alerts";
import type { OwnershipSource } from "@/lib/provenance";

export type AlertListFilter = "open" | "closed";
export const MAX_ALERTS_PER_PAGE = 300;

export class AlertNotOpenError extends Error {
  constructor() {
    super("This alert was already handled.");
  }
}

export interface OwnershipAlertRecord {
  id: string;
  source: AlertSource;
  url: string;
  title: string;
  publisher: string | null;
  published_at: string | null;
  signal: AlertSignal;
  matched_terms: string[];
  score: number;
  status: "open" | "dismissed" | "applied";
  found_at: string;
  resolved_at: string | null;
  resolver_email: string | null;
  resolution_note: string | null;
}

/** One brand's current listing and its alerts, strongest first. */
export interface BrandAlertGroup {
  brand_id: string;
  brand_name: string;
  corporate_tier: 1 | 2 | 3;
  parent_entity: string | null;
  financial_backers: string[];
  source: OwnershipSource | null;
  storefront_count: number;
  alerts: OwnershipAlertRecord[];
}

interface AlertRow {
  id: string;
  brand_id: string;
  brand_name: string;
  corporate_tier: number;
  parent_entity: string | null;
  financial_backers: string[] | null;
  ownership_source_type: string | null;
  ownership_source_url: string | null;
  ownership_verified_on: string | null;
  storefront_count: number;
  source: AlertSource;
  url: string;
  title: string;
  publisher: string | null;
  published_at: Date | null;
  signal: AlertSignal;
  matched_terms: string[];
  score: number;
  status: "open" | "dismissed" | "applied";
  found_at: Date;
  resolved_at: Date | null;
  resolver_email: string | null;
  resolution_note: string | null;
}

/**
 * Alerts grouped by brand, read as the admin (RLS: admins only). Open alerts:
 * brands with the strongest alert first. Closed: most recently handled first.
 */
export async function fetch_ownership_alerts(
  admin: AdminIdentity,
  filter: AlertListFilter,
  pool: Pool = get_database_pool(),
): Promise<BrandAlertGroup[]> {
  const rows = await with_admin_claims(
    admin.claims,
    async (client) =>
      (
        await client.query<AlertRow>(
          `SELECT a.id, a.brand_id, b.name AS brand_name, b.corporate_tier, b.parent_entity, b.financial_backers,
                  b.ownership_source_type, b.ownership_source_url,
                  to_char(b.ownership_verified_on, 'YYYY-MM-DD') AS ownership_verified_on,
                  (SELECT count(*)::int FROM locations l WHERE l.brand_id = b.id) AS storefront_count,
                  a.source, a.url, a.title, a.publisher, a.published_at, a.signal, a.matched_terms, a.score,
                  a.status, a.found_at, a.resolved_at, a.resolution_note,
                  (SELECT log.actor_email FROM admin_audit_log log
                    WHERE log.action IN ('dismiss_alert', 'apply_alert')
                      AND log.payload ->> 'ownership_alert_id' = a.id::text
                    ORDER BY log.created_at DESC LIMIT 1) AS resolver_email
             FROM ownership_alerts a
             JOIN brands b ON b.id = a.brand_id
            WHERE ($1 = 'open') = (a.status = 'open')
            ORDER BY ${filter === "open" ? "a.score DESC, a.published_at DESC NULLS LAST" : "a.resolved_at DESC"}
            LIMIT $2`,
          [filter, MAX_ALERTS_PER_PAGE],
        )
      ).rows,
    pool,
  );

  const groups = new Map<string, BrandAlertGroup>();
  for (const row of rows) {
    let group = groups.get(row.brand_id);
    if (!group) {
      group = {
        brand_id: row.brand_id,
        brand_name: row.brand_name,
        corporate_tier: row.corporate_tier as 1 | 2 | 3,
        parent_entity: row.parent_entity,
        financial_backers: row.financial_backers ?? [],
        source:
          row.ownership_source_type && row.ownership_source_url && row.ownership_verified_on
            ? { source_type: row.ownership_source_type, source_url: row.ownership_source_url, verified_on: row.ownership_verified_on }
            : null,
        storefront_count: Number(row.storefront_count),
        alerts: [],
      };
      groups.set(row.brand_id, group);
    }
    group.alerts.push({
      id: row.id,
      source: row.source,
      url: row.url,
      title: row.title,
      publisher: row.publisher,
      published_at: row.published_at?.toISOString() ?? null,
      signal: row.signal,
      matched_terms: row.matched_terms,
      score: row.score,
      status: row.status,
      found_at: row.found_at.toISOString(),
      resolved_at: row.resolved_at?.toISOString() ?? null,
      resolver_email: row.resolver_email,
      resolution_note: row.resolution_note,
    });
  }
  // Rows arrive in rank order, so Map insertion order already ranks the brands.
  return [...groups.values()];
}


/**
 * Closes an alert. Re-verifying or correcting the listing happens in the same
 * transaction, so the listing never changes without the alert being closed (and
 * both are in the audit log).
 */
export async function resolve_ownership_alert(
  admin: AdminIdentity,
  alert_id: string,
  resolution: AlertResolution,
  pool: Pool = get_database_pool(),
): Promise<void> {
  try {
    await with_admin_claims(
      admin.claims,
      async (client) => {
        const alert = await client.query<{ brand_id: string }>(
          `SELECT brand_id FROM ownership_alerts WHERE id = $1 AND status = 'open'`,
          [alert_id],
        );
        const brand_id = alert.rows[0]?.brand_id;
        if (!brand_id) throw new AlertNotOpenError();

        if (resolution.action === "dismiss") {
          await client.query(`SELECT resolve_ownership_alert($1, 'dismissed', $2)`, [alert_id, resolution.note]);
          return;
        }
        if (resolution.action === "reverify") {
          await client.query("SELECT reverify_brand($1, $2, $3)", [
            brand_id,
            resolution.input.ownership_source_type,
            resolution.input.ownership_source_url,
          ]);
          await client.query(`SELECT resolve_ownership_alert($1, 'applied', $2)`, [alert_id, "Used as fresh evidence; listing unchanged."]);
          return;
        }
        const input = resolution.input;
        await client.query("SELECT correct_brand($1, $2, $3, $4, $5, $6, $7)", [
          brand_id,
          input.corporate_tier,
          input.parent_entity,
          input.financial_backers,
          input.ownership_source_type,
          input.ownership_source_url,
          input.review_note,
        ]);
        await client.query(`SELECT resolve_ownership_alert($1, 'applied', $2)`, [alert_id, input.review_note]);
      },
      pool,
    );
  } catch (caught_error) {
    if (caught_error instanceof AlertNotOpenError) throw caught_error;
    const message = caught_error instanceof Error ? caught_error.message : "";
    if (message.includes("alert_not_open")) throw new AlertNotOpenError();
    if (message.includes("note_required")) throw new BrandChangeRejectedError("Say why the alert is dismissed.", 422);
    translate_brand_error(caught_error);
  }
}
