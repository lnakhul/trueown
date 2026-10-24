import type { Pool } from "pg";
import type { AdminIdentity } from "@/lib/auth/admin-session";
import { with_admin_claims } from "@/lib/db/as-admin";
import { get_database_pool } from "@/lib/db/pool";
import type { AddCorporateBrandInput, AddIndependentInput } from "@/lib/storefront-review";

export type StorefrontQueueView = "chains" | "possible" | "independents" | "rejected";

export interface StorefrontCandidate {
  id: string;
  name: string;
  address: string;
  borough: string | null;
  category: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Possible legal owners from the state business registry (possible independents only), best first. */
  registry?: RegistrySuggestionView[];
}

export interface RegistrySuggestionView {
  entity_name: string;
  entity_type: string | null;
  jurisdiction: string | null;
  filed_on: string | null;
  entity_address: string | null;
  match_reason: "name_at_address" | "business_at_address" | "name_elsewhere";
  score: number;
  record_url: string;
}

export type IndependentSort = "size" | "registry";

export interface ChainGroup {
  brand_id: string;
  brand_name: string;
  corporate_tier: number;
  candidates: StorefrontCandidate[];
}

export interface PossibleMatch extends StorefrontCandidate {
  brand_id: string;
  brand_name: string;
  corporate_tier: number;
}

export interface IndependentGroup {
  name: string;
  location_count: number;
  candidates: StorefrontCandidate[];
}

export interface RejectedGroup {
  name: string;
  reason: string | null;
  reviewed_at: string | null;
  candidates: StorefrontCandidate[];
}

export interface StorefrontQueue {
  counts: Record<StorefrontQueueView, number>;
  chains: ChainGroup[];
  possible: PossibleMatch[];
  independents: IndependentGroup[];
  /** True when more independent groups exist than were returned. */
  independents_truncated: boolean;
  /** Rejected shops grouped by name and reason, most recently rejected first. */
  rejected: RejectedGroup[];
}

export const MAX_INDEPENDENT_GROUPS = 150;
const MAX_POSSIBLE = 300;

export class StorefrontChangeRejectedError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 404 | 409 | 422,
  ) {
    super(message);
  }
}

function translate_storefront_error(caught_error: unknown): never {
  const message = caught_error instanceof Error ? caught_error.message : "";
  const known: Array<[string, string, 403 | 404 | 409 | 422]> = [
    ["not_admin", "Admin role required.", 403],
    ["permission denied", "Admin role required.", 403],
    ["candidate_not_pending", "Some of these storefronts were already reviewed. Reload the page.", 409],
    ["candidate_not_found", "Some of these storefronts no longer exist. Reload the page.", 404],
    ["brand_not_found", "That brand no longer exists.", 404],
    ["needs_brand_confirmation", "Possible matches must be confirmed one brand at a time.", 422],
    ["missing_coordinates", "This storefront has no coordinates yet, so it cannot be placed on the map.", 422],
    ["brand_exists", "A brand with this name already exists: link the storefront to it instead.", 409],
    ["invalid_source_type", "Choose evidence that the business is independent.", 422],
    ["note_required", "Give a reason for rejecting.", 422],
    ["invalid_batch", "Choose between 1 and 500 storefronts.", 422],
    ["independent_market_mismatch", "That independent belongs to another market.", 422],
    ["candidate_not_rejected", "Some of these storefronts are no longer rejected. Reload the page.", 409],
    ["parent_required", "Enter the owner or lead investor.", 422],
    ["invalid_tier", "Choose Tier 1 or Tier 2.", 422],
  ];
  for (const [code, text, status] of known) {
    if (message.includes(code)) throw new StorefrontChangeRejectedError(text, status);
  }
  throw caught_error;
}

interface CandidateRow extends StorefrontCandidate {
  brand_id: string | null;
  brand_name: string | null;
  corporate_tier: number | null;
}

const CANDIDATE_COLUMNS = `c.id, c.name, c.address, c.borough, c.category, c.latitude, c.longitude,
  b.id AS brand_id, b.name AS brand_name, b.corporate_tier`;

function to_candidate(row: CandidateRow): StorefrontCandidate {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    borough: row.borough,
    category: row.category,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
  };
}

/** Everything pending for one market, shaped for the three review tabs. */
export async function fetch_storefront_queue(
  admin: AdminIdentity,
  market_slug: string,
  search: string | null = null,
  pool: Pool = get_database_pool(),
  options: { independent_sort?: IndependentSort } = {},
): Promise<StorefrontQueue> {
  // "registry": groups with the strongest registry match first (quickest to verify).
  const group_order =
    options.independent_sort === "registry"
      ? "best_score DESC NULLS LAST, group_size DESC, group_key"
      : "group_size DESC, group_key";
  const term = search?.trim().toLowerCase() || null;
  return with_admin_claims(
    admin.claims,
    async (client) => {
      const scope = `FROM storefront_candidates c
                     JOIN markets m ON m.id = c.market_id AND m.slug = $1
                     LEFT JOIN brands b ON b.id = c.matched_brand_id
                    WHERE c.status = 'pending'
                      AND ($2::text IS NULL OR strpos(lower(c.name), $2) > 0 OR strpos(lower(c.address), $2) > 0
                           OR strpos(lower(coalesce(b.name, '')), $2) > 0)`;

      const counts = await client.query<{ match_kind: string; total: number }>(
        `SELECT c.match_kind, count(*)::int AS total ${scope} GROUP BY c.match_kind`,
        [market_slug, term],
      );
      const count_of = (kind: string) => counts.rows.find((row) => row.match_kind === kind)?.total ?? 0;

      const chain_rows = await client.query<CandidateRow>(
        `SELECT ${CANDIDATE_COLUMNS} ${scope} AND c.match_kind = 'exact'
          ORDER BY b.name, c.borough, c.address`,
        [market_slug, term],
      );
      const chains = new Map<string, ChainGroup>();
      for (const row of chain_rows.rows) {
        if (!row.brand_id) continue;
        const group = chains.get(row.brand_id) ?? {
          brand_id: row.brand_id,
          brand_name: row.brand_name ?? "",
          corporate_tier: row.corporate_tier ?? 0,
          candidates: [],
        };
        group.candidates.push(to_candidate(row));
        chains.set(row.brand_id, group);
      }

      const possible_rows = await client.query<CandidateRow>(
        `SELECT ${CANDIDATE_COLUMNS} ${scope} AND c.match_kind = 'possible'
          ORDER BY b.name, c.name LIMIT ${MAX_POSSIBLE}`,
        [market_slug, term],
      );

      // Unmatched shops grouped by name, biggest groups first: a name with dozens of
      // locations is almost always a chain we don't track, so it surfaces at the top.
      const independent_rows = await client.query<CandidateRow & { group_name: string; group_size: number }>(
        `WITH unmatched AS (
           SELECT c.*, lower(btrim(c.name)) AS group_key
             FROM storefront_candidates c
             JOIN markets m ON m.id = c.market_id AND m.slug = $1
            WHERE c.status = 'pending'
              AND c.match_kind = 'none'
              AND ($2::text IS NULL OR strpos(lower(c.name), $2) > 0 OR strpos(lower(c.address), $2) > 0)
         ),
         groups AS (
           SELECT u.group_key, count(DISTINCT u.id)::int AS group_size, max(rs.score) AS best_score
             FROM unmatched u
             LEFT JOIN registry_suggestions rs ON rs.candidate_id = u.id
            GROUP BY u.group_key
            ORDER BY ${group_order}
            LIMIT ${MAX_INDEPENDENT_GROUPS + 1}
         )
         SELECT u.id, u.name, u.address, u.borough, u.category, u.latitude, u.longitude,
                NULL::uuid AS brand_id, NULL::text AS brand_name, NULL::int AS corporate_tier,
                g.group_key AS group_name, g.group_size
           FROM unmatched u
           JOIN groups g ON g.group_key = u.group_key
          ORDER BY ${options.independent_sort === "registry" ? "g.best_score DESC NULLS LAST, " : ""}g.group_size DESC, g.group_key, u.address`,
        [market_slug, term],
      );
      const independents = new Map<string, IndependentGroup>();
      for (const row of independent_rows.rows) {
        const group = independents.get(row.group_name) ?? { name: row.name, location_count: row.group_size, candidates: [] };
        group.candidates.push(to_candidate(row));
        independents.set(row.group_name, group);
      }
      const independent_groups = [...independents.values()];

      // Registry leads for the shops on screen, best first (at most three each).
      const shown_ids = independent_groups.slice(0, MAX_INDEPENDENT_GROUPS).flatMap((group) => group.candidates.map((candidate) => candidate.id));
      if (shown_ids.length > 0) {
        const suggestions = await client.query<RegistrySuggestionView & { candidate_id: string; filed_on: Date | string | null }>(
          `SELECT candidate_id, entity_name, entity_type, jurisdiction, to_char(filed_on, 'YYYY-MM-DD') AS filed_on,
                  entity_address, match_reason, score, record_url
             FROM registry_suggestions
            WHERE candidate_id = ANY ($1::uuid[])
            ORDER BY candidate_id, score DESC, filed_on DESC NULLS LAST`,
          [shown_ids],
        );
        const by_candidate = new Map<string, RegistrySuggestionView[]>();
        for (const { candidate_id, ...suggestion } of suggestions.rows) {
          const list = by_candidate.get(candidate_id) ?? [];
          list.push({ ...suggestion, filed_on: suggestion.filed_on === null ? null : String(suggestion.filed_on) });
          by_candidate.set(candidate_id, list);
        }
        for (const group of independent_groups) {
          for (const candidate of group.candidates) candidate.registry = by_candidate.get(candidate.id) ?? [];
        }
      }

      const rejected_count = await client.query<{ total: number }>(
        `SELECT count(*)::int AS total
           FROM storefront_candidates c JOIN markets m ON m.id = c.market_id AND m.slug = $1
          WHERE c.status = 'rejected'
            AND ($2::text IS NULL OR strpos(lower(c.name), $2) > 0 OR strpos(lower(c.address), $2) > 0)`,
        [market_slug, term],
      );
      const rejected_rows = await client.query<CandidateRow & { reason: string | null; reviewed_at: Date | null }>(
        `SELECT c.id, c.name, c.address, c.borough, c.category, c.latitude, c.longitude,
                NULL::uuid AS brand_id, NULL::text AS brand_name, NULL::int AS corporate_tier,
                c.review_note AS reason, c.reviewed_at
           FROM storefront_candidates c JOIN markets m ON m.id = c.market_id AND m.slug = $1
          WHERE c.status = 'rejected'
            AND ($2::text IS NULL OR strpos(lower(c.name), $2) > 0 OR strpos(lower(c.address), $2) > 0)
          ORDER BY c.reviewed_at DESC NULLS LAST, lower(btrim(c.name)), c.address
          LIMIT 2000`,
        [market_slug, term],
      );
      const rejected = new Map<string, RejectedGroup>();
      for (const row of rejected_rows.rows) {
        const key = `${row.name.trim().toLowerCase()}|${row.reason ?? ""}`;
        const group = rejected.get(key) ?? {
          name: row.name,
          reason: row.reason,
          reviewed_at: row.reviewed_at ? row.reviewed_at.toISOString() : null,
          candidates: [],
        };
        group.candidates.push(to_candidate(row));
        rejected.set(key, group);
      }

      return {
        counts: {
          chains: count_of("exact"),
          possible: count_of("possible"),
          independents: count_of("none"),
          rejected: rejected_count.rows[0]?.total ?? 0,
        },
        chains: [...chains.values()],
        possible: possible_rows.rows.map((row) => ({
          ...to_candidate(row),
          brand_id: row.brand_id ?? "",
          brand_name: row.brand_name ?? "",
          corporate_tier: row.corporate_tier ?? 0,
        })),
        independents: independent_groups.slice(0, MAX_INDEPENDENT_GROUPS),
        independents_truncated: independent_groups.length > MAX_INDEPENDENT_GROUPS,
        rejected: [...rejected.values()].slice(0, MAX_INDEPENDENT_GROUPS),
      };
    },
    pool,
  );
}

export async function approve_storefronts(
  admin: AdminIdentity,
  candidate_ids: string[],
  brand_id: string | null,
  pool: Pool = get_database_pool(),
): Promise<number> {
  try {
    return await with_admin_claims(
      admin.claims,
      async (client) => {
        const result = await client.query<{ approved: number }>(
          "SELECT approve_storefront_candidates($1::uuid[], $2::uuid) AS approved",
          [candidate_ids, brand_id],
        );
        return result.rows[0]?.approved ?? 0;
      },
      pool,
    );
  } catch (caught_error) {
    translate_storefront_error(caught_error);
  }
}

export async function reject_storefronts(
  admin: AdminIdentity,
  candidate_ids: string[],
  note: string,
  pool: Pool = get_database_pool(),
): Promise<number> {
  try {
    return await with_admin_claims(
      admin.claims,
      async (client) => {
        const result = await client.query<{ rejected: number }>(
          "SELECT reject_storefront_candidates($1::uuid[], $2) AS rejected",
          [candidate_ids, note],
        );
        return result.rows[0]?.rejected ?? 0;
      },
      pool,
    );
  } catch (caught_error) {
    translate_storefront_error(caught_error);
  }
}

export async function add_independent(
  admin: AdminIdentity,
  input: AddIndependentInput,
  pool: Pool = get_database_pool(),
): Promise<string> {
  try {
    return await with_admin_claims(
      admin.claims,
      async (client) => {
        const result = await client.query<{ location_id: string }>(
          "SELECT add_independent_from_candidate($1, $2, $3, $4) AS location_id",
          [input.candidate_id, input.brand_name, input.ownership_source_type, input.ownership_source_url],
        );
        return result.rows[0]?.location_id ?? "";
      },
      pool,
    );
  } catch (caught_error) {
    translate_storefront_error(caught_error);
  }
}

/** Creates a Tier 1/2 brand with its evidence; its same-named shops become chain matches. */
export async function add_corporate_brand(
  admin: AdminIdentity,
  input: AddCorporateBrandInput,
  pool: Pool = get_database_pool(),
): Promise<{ brand_id: string; moved_to_chain_matches: number }> {
  try {
    return await with_admin_claims(
      admin.claims,
      async (client) => {
        const result = await client.query<{ brand_id: string; moved_to_chain_matches: number }>(
          "SELECT * FROM add_corporate_brand_from_candidates($1, $2, $3, $4, $5, $6, $7)",
          [
            input.candidate_id,
            input.brand_name,
            input.corporate_tier,
            input.parent_entity,
            input.financial_backers,
            input.ownership_source_type,
            input.ownership_source_url,
          ],
        );
        const row = result.rows[0];
        if (!row) throw new Error("add_corporate_brand_from_candidates returned no row.");
        return row;
      },
      pool,
    );
  } catch (caught_error) {
    translate_storefront_error(caught_error);
  }
}

/** Undoes rejections: the shops go back to the queue and are re-matched against current brands. */
export async function reopen_storefronts(
  admin: AdminIdentity,
  candidate_ids: string[],
  note: string | null,
  pool: Pool = get_database_pool(),
): Promise<number> {
  try {
    return await with_admin_claims(
      admin.claims,
      async (client) => {
        const result = await client.query<{ reopened: number }>(
          "SELECT reopen_storefront_candidates($1::uuid[], $2) AS reopened",
          [candidate_ids, note],
        );
        return result.rows[0]?.reopened ?? 0;
      },
      pool,
    );
  } catch (caught_error) {
    translate_storefront_error(caught_error);
  }
}
