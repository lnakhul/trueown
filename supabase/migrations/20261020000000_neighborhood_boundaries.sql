-- =============================================================================
-- Real-data foundation: neighborhood boundary polygons + ownership provenance
-- =============================================================================

-- -----------------------------------------------------------------------------
-- neighborhood_boundaries: one row per official boundary polygon.
-- Loaded by `npm run db:import:boundaries` (NYC 2020 Neighborhood Tabulation
-- Areas for launch). `source` + `source_code` make re-imports idempotent and let
-- other cities bring their own boundary sets later.
-- Centroids are never stored: they are computed on demand with ST_Centroid.
-- -----------------------------------------------------------------------------
CREATE TABLE neighborhood_boundaries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city        TEXT NOT NULL CHECK (length(btrim(city)) > 0),
  source      TEXT NOT NULL CHECK (length(btrim(source)) > 0),
  source_code TEXT NOT NULL CHECK (length(btrim(source_code)) > 0),
  name        TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  borough     TEXT,
  area_type   TEXT,
  geometry    GEOMETRY(MultiPolygon, 4326) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT neighborhood_boundaries_valid_geometry CHECK (ST_IsValid(geometry)),
  CONSTRAINT neighborhood_boundaries_source_code_uniq UNIQUE (source, source_code)
);

CREATE INDEX neighborhood_boundaries_geometry_gist_idx
  ON neighborhood_boundaries USING GIST (geometry);

-- Matches the ::geography casts used for meter-based tolerance lookups.
CREATE INDEX neighborhood_boundaries_geog_gist_idx
  ON neighborhood_boundaries USING GIST ((geometry::geography));

CREATE INDEX neighborhood_boundaries_name_idx
  ON neighborhood_boundaries (lower(name));

-- -----------------------------------------------------------------------------
-- resolve_neighborhood: the boundary containing (or within p_tolerance_meters of)
-- a point. The tolerance absorbs geocoder error on shoreline storefronts.
-- Returns no rows when nothing is close enough, which importers treat as a
-- coordinate error (typically swapped latitude/longitude).
-- -----------------------------------------------------------------------------
CREATE FUNCTION resolve_neighborhood(
  p_longitude        DOUBLE PRECISION,
  p_latitude         DOUBLE PRECISION,
  p_city             TEXT DEFAULT 'New York',
  p_tolerance_meters DOUBLE PRECISION DEFAULT 100
) RETURNS TABLE (
  boundary_id     UUID,
  name            TEXT,
  borough         TEXT,
  distance_meters DOUBLE PRECISION
)
LANGUAGE sql
STABLE
AS $$
  WITH point AS (
    SELECT ST_SetSRID(ST_MakePoint(p_longitude, p_latitude), 4326)::geography AS g
  )
  SELECT b.id, b.name, b.borough, ST_Distance(b.geometry::geography, point.g)
    FROM neighborhood_boundaries b, point
   WHERE b.city = p_city
     AND ST_DWithin(b.geometry::geography, point.g, p_tolerance_meters)
   ORDER BY ST_Distance(b.geometry::geography, point.g), b.name
   LIMIT 1;
$$;

-- -----------------------------------------------------------------------------
-- Ownership provenance on brands. Hand-curated launch data must cite where each
-- tier was verified; the bulk importer requires all three fields, while rows
-- created before this migration (or via crowdsourcing) may leave them empty.
-- -----------------------------------------------------------------------------
ALTER TABLE brands
  ADD COLUMN ownership_source_type TEXT
    CHECK (ownership_source_type IN (
      'sec_edgar', 'investor_press_release', 'pitchbook', 'crunchbase', 'mergr',
      'nys_dos_corporations', 'eater_ny', 'community_consensus'
    )),
  ADD COLUMN ownership_source_url TEXT
    CHECK (ownership_source_url ~* '^https?://[^\s/]+\.[^\s/]{2,}(/\S*)?$'),
  ADD COLUMN ownership_verified_on DATE,
  ADD CONSTRAINT brands_provenance_all_or_none CHECK (
    (ownership_source_type IS NULL) = (ownership_source_url IS NULL)
    AND (ownership_source_url IS NULL) = (ownership_verified_on IS NULL)
  );

-- One physical storefront per brand + street address; makes imports idempotent.
CREATE UNIQUE INDEX locations_brand_address_uniq_idx
  ON locations (brand_id, lower(btrim(address)));

-- -----------------------------------------------------------------------------
-- approve_submission: now derives the neighborhood from the boundary polygons
-- and tolerates an already-live storefront instead of duplicating it.
-- CREATE OR REPLACE keeps the privileges revoked in the vetting migration.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION approve_submission(
  p_submission_id              UUID,
  p_corporate_tier             INT,
  p_parent_entity              TEXT,
  p_industry_vertical          industry_vertical,
  p_unique_selling_proposition TEXT,
  p_latitude                   DOUBLE PRECISION,
  p_longitude                  DOUBLE PRECISION,
  p_city                       TEXT DEFAULT 'New York'
) RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_submission    submissions%ROWTYPE;
  v_brand_id      UUID;
  v_existing_tier INT;
  v_location_id   UUID;
  v_neighborhood  TEXT;
BEGIN
  SELECT * INTO v_submission
    FROM submissions
   WHERE id = p_submission_id AND status = 'pending'
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission_not_pending';
  END IF;

  INSERT INTO brands (name, corporate_tier, industry_vertical, parent_entity, unique_selling_proposition)
  VALUES (btrim(v_submission.business_name), p_corporate_tier, p_industry_vertical,
          p_parent_entity, p_unique_selling_proposition)
  ON CONFLICT (lower(btrim(name)), industry_vertical) DO NOTHING
  RETURNING id INTO v_brand_id;

  -- Brand already live: reuse it, but never silently contradict its recorded tier.
  IF v_brand_id IS NULL THEN
    SELECT id, corporate_tier INTO v_brand_id, v_existing_tier
      FROM brands
     WHERE lower(btrim(name)) = lower(btrim(v_submission.business_name))
       AND industry_vertical = p_industry_vertical;

    IF v_existing_tier IS DISTINCT FROM p_corporate_tier THEN
      RAISE EXCEPTION 'brand_tier_conflict';
    END IF;
  END IF;

  SELECT r.name INTO v_neighborhood
    FROM resolve_neighborhood(p_longitude, p_latitude, p_city) r;

  INSERT INTO locations (brand_id, address, neighborhood, city, coordinates)
  VALUES (v_brand_id, btrim(v_submission.street_address), v_neighborhood, p_city,
          ST_SetSRID(ST_MakePoint(p_longitude, p_latitude), 4326))
  ON CONFLICT (brand_id, lower(btrim(address))) DO NOTHING
  RETURNING id INTO v_location_id;

  IF v_location_id IS NULL THEN
    SELECT id INTO v_location_id
      FROM locations
     WHERE brand_id = v_brand_id
       AND lower(btrim(address)) = lower(btrim(v_submission.street_address));
  END IF;

  UPDATE submissions
     SET status = 'approved', reviewed_at = now()
   WHERE id = p_submission_id;

  RETURN v_location_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- RLS: boundaries are public reference data; only admins may change them.
-- -----------------------------------------------------------------------------
ALTER TABLE neighborhood_boundaries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON neighborhood_boundaries FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON neighborhood_boundaries FROM anon, authenticated';
    EXECUTE 'GRANT SELECT ON neighborhood_boundaries TO anon, authenticated';
    EXECUTE 'GRANT INSERT, UPDATE, DELETE ON neighborhood_boundaries TO authenticated';
    EXECUTE 'CREATE POLICY neighborhood_boundaries_select_public ON neighborhood_boundaries
               FOR SELECT TO anon, authenticated USING (true)';
    EXECUTE 'CREATE POLICY neighborhood_boundaries_insert_admin ON neighborhood_boundaries
               FOR INSERT TO authenticated WITH CHECK (public.is_admin())';
    EXECUTE 'CREATE POLICY neighborhood_boundaries_update_admin ON neighborhood_boundaries
               FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin())';
    EXECUTE 'CREATE POLICY neighborhood_boundaries_delete_admin ON neighborhood_boundaries
               FOR DELETE TO authenticated USING (public.is_admin())';
  END IF;
END
$$;
