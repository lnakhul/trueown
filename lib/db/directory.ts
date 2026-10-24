import type { Pool as PgPool } from "pg";
import { get_database_pool } from "@/lib/db/pool";
import type { OwnershipSource } from "@/lib/provenance";
import { slugify } from "@/lib/site";
import type { CorporateTier, IndustryVertical } from "@/lib/types";

/**
 * Public brand directory, brand pages and owner pages. Only brands with a
 * location in an active market are public, the same rule the map uses.
 */

type Pool = Pick<PgPool, "query">;

const VISIBLE = `EXISTS (SELECT 1 FROM locations vl JOIN markets vm ON vm.id = vl.market_id AND vm.status = 'active'
                          WHERE vl.brand_id = b.id)`;
const VISIBLE_LOCATION_JOIN = `JOIN markets m ON m.id = l.market_id AND m.status = 'active'`;

export type OwnershipFilter = "all" | "pe" | "vc" | "independent";
export const OWNERSHIP_FILTER_TIERS: Record<OwnershipFilter, CorporateTier[]> = {
  all: [1, 2, 3],
  pe: [1],
  vc: [2],
  independent: [3],
};
export const DIRECTORY_PAGE_SIZE = 60;
/** Independents near a corporate-backed brand's locations shown on its page. */
export const MAX_PAGE_ALTERNATIVES = 8;
/** Locations listed on a brand page (the map deep link shows the rest). */
export const MAX_PAGE_LOCATIONS = 100;

function to_source(row: { ownership_source_type: string | null; ownership_source_url: string | null; ownership_verified_on: string | null }): OwnershipSource | null {
  return row.ownership_source_type && row.ownership_source_url && row.ownership_verified_on
    ? { source_type: row.ownership_source_type, source_url: row.ownership_source_url, verified_on: row.ownership_verified_on }
    : null;
}

/* -------------------------------------------------------------------------- */
/* Directory                                                                   */
/* -------------------------------------------------------------------------- */

export interface DirectoryBrand {
  slug: string;
  name: string;
  corporate_tier: CorporateTier;
  parent_entity: string | null;
  location_count: number;
}

export interface DirectoryPage {
  brands: DirectoryBrand[];
  total: number;
  counts: Record<OwnershipFilter, number>;
}

export async function fetch_brand_directory(
  options: { ownership: OwnershipFilter; search: string; page: number },
  pool: Pool = get_database_pool(),
): Promise<DirectoryPage> {
  const term = options.search.replace(/\s+/g, " ").trim().toLowerCase();
  const tiers = OWNERSHIP_FILTER_TIERS[options.ownership];
  const [rows, counts] = await Promise.all([
    pool.query<DirectoryBrand & { total: number }>(
      `SELECT b.slug, b.name, b.corporate_tier, b.parent_entity,
              (SELECT count(*)::int FROM locations l ${VISIBLE_LOCATION_JOIN} WHERE l.brand_id = b.id) AS location_count,
              count(*) OVER ()::int AS total
         FROM brands b
        WHERE ${VISIBLE}
          AND b.corporate_tier = ANY($1::int[])
          AND ($2 = '' OR strpos(lower(b.name), $2) > 0 OR strpos(lower(coalesce(b.parent_entity, '')), $2) > 0)
        ORDER BY lower(b.name), b.slug
        LIMIT $3 OFFSET $4`,
      [tiers, term, DIRECTORY_PAGE_SIZE, Math.max(0, options.page - 1) * DIRECTORY_PAGE_SIZE],
    ),
    pool.query<{ corporate_tier: number; n: number }>(
      `SELECT b.corporate_tier, count(*)::int AS n FROM brands b
        WHERE ${VISIBLE} AND ($1 = '' OR strpos(lower(b.name), $1) > 0 OR strpos(lower(coalesce(b.parent_entity, '')), $1) > 0)
        GROUP BY b.corporate_tier`,
      [term],
    ),
  ]);
  const by_tier = new Map(counts.rows.map((row) => [row.corporate_tier, Number(row.n)]));
  const tier_count = (list: CorporateTier[]) => list.reduce((sum, tier) => sum + (by_tier.get(tier) ?? 0), 0);
  return {
    brands: rows.rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      corporate_tier: row.corporate_tier as CorporateTier,
      parent_entity: row.parent_entity,
      location_count: Number(row.location_count),
    })),
    total: Number(rows.rows[0]?.total ?? 0),
    counts: {
      all: tier_count([1, 2, 3]),
      pe: tier_count([1]),
      vc: tier_count([2]),
      independent: tier_count([3]),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Brand page                                                                  */
/* -------------------------------------------------------------------------- */

export interface PageLocation {
  location_id: string;
  address: string;
  neighborhood: string | null;
  city: string;
  latitude: number;
  longitude: number;
}

export interface PageAlternative {
  location_id: string;
  brand_name: string;
  brand_slug: string;
  address: string;
  neighborhood: string | null;
  latitude: number;
  longitude: number;
  distance_meters: number;
  /** The brand's own location this independent is nearest to. */
  near_address: string;
}

export interface OwnerLink {
  name: string;
  slug: string;
  role: "parent" | "backer";
}

export interface BrandPage {
  id: string;
  slug: string;
  name: string;
  corporate_tier: CorporateTier;
  industry_vertical: IndustryVertical;
  parent_entity: string | null;
  financial_backers: string[];
  owners: OwnerLink[];
  unique_selling_proposition: string | null;
  source: OwnershipSource | null;
  location_count: number;
  locations: PageLocation[];
  alternatives: PageAlternative[];
}

export async function fetch_brand_page(slug: string, pool: Pool = get_database_pool()): Promise<BrandPage | null> {
  const brand = await pool.query<{
    id: string;
    slug: string;
    name: string;
    corporate_tier: number;
    industry_vertical: IndustryVertical;
    parent_entity: string | null;
    financial_backers: string[] | null;
    unique_selling_proposition: string | null;
    ownership_source_type: string | null;
    ownership_source_url: string | null;
    ownership_verified_on: string | null;
  }>(
    `SELECT b.id, b.slug, b.name, b.corporate_tier, b.industry_vertical, b.parent_entity, b.financial_backers,
            b.unique_selling_proposition, b.ownership_source_type, b.ownership_source_url,
            to_char(b.ownership_verified_on, 'YYYY-MM-DD') AS ownership_verified_on
       FROM brands b
      WHERE b.slug = $1 AND ${VISIBLE}`,
    [slug],
  );
  const row = brand.rows[0];
  if (!row) return null;

  const [locations, count, alternatives] = await Promise.all([
    pool.query<PageLocation>(
      `SELECT l.id AS location_id, l.address, l.neighborhood, l.city,
              ST_Y(l.coordinates) AS latitude, ST_X(l.coordinates) AS longitude
         FROM locations l ${VISIBLE_LOCATION_JOIN}
        WHERE l.brand_id = $1
        ORDER BY l.city, l.neighborhood NULLS LAST, l.address
        LIMIT $2`,
      [row.id, MAX_PAGE_LOCATIONS],
    ),
    pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM locations l ${VISIBLE_LOCATION_JOIN} WHERE l.brand_id = $1`, [row.id]),
    row.corporate_tier === 3
      ? Promise.resolve({ rows: [] as PageAlternative[] })
      : pool.query<PageAlternative>(
          `WITH own AS (
             SELECT l.coordinates, l.market_id, l.address FROM locations l ${VISIBLE_LOCATION_JOIN}
              WHERE l.brand_id = $1 LIMIT 200
           ),
           nearest AS (
             SELECT DISTINCT ON (i.id)
                    i.id AS location_id, ib.name AS brand_name, ib.slug AS brand_slug, i.address, i.neighborhood,
                    ST_Y(i.coordinates) AS latitude, ST_X(i.coordinates) AS longitude,
                    ST_Distance(i.coordinates::geography, own.coordinates::geography) AS distance_meters,
                    own.address AS near_address
               FROM own
               JOIN locations i ON i.market_id = own.market_id
                               AND ST_DWithin(i.coordinates::geography, own.coordinates::geography, 1500)
               JOIN brands ib ON ib.id = i.brand_id AND ib.corporate_tier = 3 AND ib.industry_vertical = $2::industry_vertical
              ORDER BY i.id, distance_meters
           )
           SELECT * FROM nearest ORDER BY distance_meters, brand_name LIMIT $3`,
          [row.id, row.industry_vertical, MAX_PAGE_ALTERNATIVES],
        ),
  ]);

  const owners: OwnerLink[] = [];
  if (row.corporate_tier !== 3 && row.parent_entity) owners.push({ name: row.parent_entity, slug: slugify(row.parent_entity), role: "parent" });
  for (const backer of row.financial_backers ?? []) {
    if (!owners.some((owner) => owner.slug === slugify(backer))) owners.push({ name: backer, slug: slugify(backer), role: "backer" });
  }

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    corporate_tier: row.corporate_tier as CorporateTier,
    industry_vertical: row.industry_vertical,
    parent_entity: row.parent_entity,
    financial_backers: row.financial_backers ?? [],
    owners,
    unique_selling_proposition: row.unique_selling_proposition,
    source: to_source(row),
    location_count: Number(count.rows[0]?.n ?? 0),
    locations: locations.rows.map((location) => ({ ...location, latitude: Number(location.latitude), longitude: Number(location.longitude) })),
    alternatives: alternatives.rows.map((alternative) => ({
      ...alternative,
      latitude: Number(alternative.latitude),
      longitude: Number(alternative.longitude),
      distance_meters: Math.round(Number(alternative.distance_meters)),
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Owners                                                                      */
/* -------------------------------------------------------------------------- */

export interface OwnerBrand {
  slug: string;
  name: string;
  corporate_tier: CorporateTier;
  role: "parent" | "backer";
  location_count: number;
}

export interface OwnerSummary {
  name: string;
  slug: string;
  brands: OwnerBrand[];
  location_count: number;
}

interface OwnerRow {
  owner: string;
  role: "parent" | "backer";
  slug: string;
  name: string;
  corporate_tier: number;
  location_count: number;
}

/** Every parent company and named backer of a public corporate-backed brand, grouped by slug. */
export async function fetch_owners(pool: Pool = get_database_pool()): Promise<OwnerSummary[]> {
  const result = await pool.query<OwnerRow>(
    `SELECT btrim(o.owner) AS owner, o.role, b.slug, b.name, b.corporate_tier,
            (SELECT count(*)::int FROM locations l ${VISIBLE_LOCATION_JOIN} WHERE l.brand_id = b.id) AS location_count
       FROM brands b
      CROSS JOIN LATERAL (
        SELECT b.parent_entity AS owner, 'parent'::text AS role
        UNION ALL
        SELECT backer, 'backer' FROM unnest(b.financial_backers) AS backer
      ) o
      WHERE b.corporate_tier IN (1, 2) AND o.owner IS NOT NULL AND btrim(o.owner) <> '' AND ${VISIBLE}
      ORDER BY lower(btrim(o.owner)), lower(b.name)`,
  );
  const owners = new Map<string, OwnerSummary>();
  for (const row of result.rows) {
    const slug = slugify(row.owner);
    let owner = owners.get(slug);
    if (!owner) {
      owner = { name: row.owner, slug, brands: [], location_count: 0 };
      owners.set(slug, owner);
    }
    const existing = owner.brands.find((brand) => brand.slug === row.slug);
    if (existing) {
      // Listed as both parent and backer: "parent" says more.
      if (row.role === "parent") existing.role = "parent";
      continue;
    }
    owner.brands.push({
      slug: row.slug,
      name: row.name,
      corporate_tier: row.corporate_tier as CorporateTier,
      role: row.role,
      location_count: Number(row.location_count),
    });
    owner.location_count += Number(row.location_count);
  }
  return [...owners.values()];
}

export async function fetch_owner_page(slug: string, pool: Pool = get_database_pool()): Promise<OwnerSummary | null> {
  return (await fetch_owners(pool)).find((owner) => owner.slug === slug) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Sitemap                                                                     */
/* -------------------------------------------------------------------------- */

export async function fetch_public_brand_slugs(pool: Pool = get_database_pool()): Promise<{ slug: string; verified_on: string | null }[]> {
  const result = await pool.query<{ slug: string; verified_on: string | null }>(
    `SELECT b.slug, to_char(b.ownership_verified_on, 'YYYY-MM-DD') AS verified_on
       FROM brands b WHERE ${VISIBLE} ORDER BY b.slug`,
  );
  return result.rows;
}
