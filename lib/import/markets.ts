import type { Pool } from "pg";
import type { MarketConfig } from "@/lib/markets/config";
import type { MarketStatus } from "@/lib/types";

export interface MarketUpsertOutcome {
  slug: string;
  action: "created" | "updated" | "unchanged";
  /** Status the market has after the run. */
  status: MarketStatus;
  /** When the live status was kept instead of the file's, the file's value; otherwise null. */
  status_kept_from: MarketStatus | null;
}

interface ExistingMarketRow {
  city_name: string;
  city_label: string;
  status: MarketStatus;
  latitude: number;
  longitude: number;
}

const COORDINATE_EPSILON = 1e-7;

/**
 * Upserts markets by slug in one transaction. New markets take the file's
 * status; existing ones keep their live status unless apply_status is set.
 */
export async function upsert_markets(
  pool: Pool,
  configs: MarketConfig[],
  options: { dry_run?: boolean; apply_status?: boolean } = {},
): Promise<MarketUpsertOutcome[]> {
  const outcomes: MarketUpsertOutcome[] = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const config of configs) {
      const existing = await client.query<ExistingMarketRow>(
        `SELECT city_name, city_label, status,
                ST_Y(geographic_center) AS latitude, ST_X(geographic_center) AS longitude
           FROM markets WHERE slug = $1 FOR UPDATE`,
        [config.slug],
      );
      const current = existing.rows[0];

      if (!current) {
        await client.query(
          `INSERT INTO markets (slug, city_name, city_label, status, geographic_center)
           VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326))`,
          [config.slug, config.city_name, config.city_label, config.status, config.center.longitude, config.center.latitude],
        );
        outcomes.push({ slug: config.slug, action: "created", status: config.status, status_kept_from: null });
        continue;
      }

      const status = options.apply_status ? config.status : current.status;
      const changed =
        current.city_name !== config.city_name ||
        current.city_label !== config.city_label ||
        current.status !== status ||
        Math.abs(Number(current.latitude) - config.center.latitude) > COORDINATE_EPSILON ||
        Math.abs(Number(current.longitude) - config.center.longitude) > COORDINATE_EPSILON;

      if (changed) {
        await client.query(
          `UPDATE markets
              SET city_name = $2, city_label = $3, status = $4,
                  geographic_center = ST_SetSRID(ST_MakePoint($5, $6), 4326)
            WHERE slug = $1`,
          [config.slug, config.city_name, config.city_label, status, config.center.longitude, config.center.latitude],
        );
      }
      outcomes.push({
        slug: config.slug,
        action: changed ? "updated" : "unchanged",
        status,
        status_kept_from: status !== config.status ? config.status : null,
      });
    }
    await client.query(options.dry_run ? "ROLLBACK" : "COMMIT");
    return outcomes;
  } catch (caught_error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw caught_error;
  } finally {
    client.release();
  }
}
