-- =============================================================================
-- Market-scoped data: one canonical city label per market, market-scoped
-- independent brands, market-aware neighborhood boundaries and generic
-- (non-NY) provenance source types.
--
-- Why:
--   * locations.city was free text and drifted ('New York' vs 'New York City'),
--     so city filters and boundary lookups silently missed rows. The city is
--     now derived from the market and cannot drift.
--   * brands were unique on (name, vertical) nationally, so two unrelated
--     independents with the same name in different cities would merge. Tier 3
--     brands are now scoped to a home market; Tier 1/2 brands stay national.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- markets.slug + markets.city_label
-- -----------------------------------------------------------------------------
ALTER TABLE markets ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS city_label TEXT;

UPDATE markets SET slug = 'nyc',     city_label = 'New York' WHERE lower(city_name) = 'new york city' AND slug IS NULL;
UPDATE markets SET slug = 'austin',  city_label = 'Austin'   WHERE lower(city_name) = 'austin'        AND slug IS NULL;
UPDATE markets SET slug = 'chicago', city_label = 'Chicago'  WHERE lower(city_name) = 'chicago'       AND slug IS NULL;
-- Any other market added by hand: derive both from its name.
UPDATE markets
   SET slug = trim(both '-' from regexp_replace(lower(city_name), '[^a-z0-9]+', '-', 'g'))
 WHERE slug IS NULL;
UPDATE markets SET city_label = city_name WHERE city_label IS NULL;

ALTER TABLE markets ALTER COLUMN slug SET NOT NULL;
ALTER TABLE markets ALTER COLUMN city_label SET NOT NULL;
ALTER TABLE markets ADD CONSTRAINT markets_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 40);
ALTER TABLE markets ADD CONSTRAINT markets_city_label_bounds CHECK (length(btrim(city_label)) > 0 AND length(city_label) <= 100);
CREATE UNIQUE INDEX markets_slug_key ON markets (slug);

-- -----------------------------------------------------------------------------
-- locations.city follows the market's canonical label
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assign_location_market()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.coordinates IS DISTINCT FROM OLD.coordinates THEN
    NEW.market_id := public.resolve_market_id(NEW.coordinates);
  END IF;
  IF NEW.market_id IS NULL THEN
    RAISE EXCEPTION 'Location is not within 50 miles of any market; add the market first.'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT m.city_label INTO NEW.city FROM markets m WHERE m.id = NEW.market_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS locations_assign_market ON locations;
CREATE TRIGGER locations_assign_market
  BEFORE INSERT OR UPDATE OF coordinates, market_id, city ON locations
  FOR EACH ROW EXECUTE FUNCTION public.assign_location_market();

UPDATE locations l
   SET city = m.city_label
  FROM markets m
 WHERE m.id = l.market_id AND l.city IS DISTINCT FROM m.city_label;

-- A renamed label must flow to every storefront of that market.
CREATE OR REPLACE FUNCTION public.propagate_market_city_label()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE locations SET city = NEW.city_label WHERE market_id = NEW.id;
  UPDATE neighborhood_boundaries SET city = NEW.city_label WHERE market_id = NEW.id;
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- neighborhood_boundaries.market_id
-- -----------------------------------------------------------------------------
ALTER TABLE neighborhood_boundaries ADD COLUMN IF NOT EXISTS market_id UUID REFERENCES markets (id) ON DELETE RESTRICT;

UPDATE neighborhood_boundaries b
   SET market_id = m.id
  FROM markets m
 WHERE b.market_id IS NULL AND lower(b.city) = lower(m.city_label);

-- Boundaries imported before markets existed: fall back to the market covering the shape.
UPDATE neighborhood_boundaries b
   SET market_id = public.resolve_market_id(ST_PointOnSurface(b.geometry))
 WHERE b.market_id IS NULL;

DO $$
DECLARE
  v_orphans INT;
BEGIN
  SELECT count(*) INTO v_orphans FROM neighborhood_boundaries WHERE market_id IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION '% neighborhood boundary row(s) do not belong to any market.', v_orphans;
  END IF;
END
$$;

ALTER TABLE neighborhood_boundaries ALTER COLUMN market_id SET NOT NULL;
CREATE INDEX neighborhood_boundaries_market_id_idx ON neighborhood_boundaries (market_id);

-- The boundary's city label always matches its market.
CREATE OR REPLACE FUNCTION public.assign_boundary_city()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Callers that do not name a market get the one covering the shape.
  IF NEW.market_id IS NULL THEN
    NEW.market_id := public.resolve_market_id(ST_PointOnSurface(NEW.geometry));
  END IF;
  SELECT m.city_label INTO NEW.city FROM markets m WHERE m.id = NEW.market_id;
  IF NEW.city IS NULL THEN
    RAISE EXCEPTION 'Boundary is not within 50 miles of any market; add the market first.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER neighborhood_boundaries_assign_city
  BEFORE INSERT OR UPDATE OF market_id, city ON neighborhood_boundaries
  FOR EACH ROW EXECUTE FUNCTION public.assign_boundary_city();

UPDATE neighborhood_boundaries b
   SET city = m.city_label
  FROM markets m
 WHERE m.id = b.market_id AND b.city IS DISTINCT FROM m.city_label;

CREATE TRIGGER markets_propagate_city_label
  AFTER UPDATE OF city_label ON markets
  FOR EACH ROW WHEN (OLD.city_label IS DISTINCT FROM NEW.city_label)
  EXECUTE FUNCTION public.propagate_market_city_label();

-- Market-keyed neighborhood lookup; the city-keyed version is kept for callers
-- that still pass a label (labels are now canonical, so both agree).
CREATE FUNCTION resolve_neighborhood_in_market(
  p_longitude        DOUBLE PRECISION,
  p_latitude         DOUBLE PRECISION,
  p_market_id        UUID,
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
   WHERE b.market_id = p_market_id
     AND ST_DWithin(b.geometry::geography, point.g, p_tolerance_meters)
   ORDER BY ST_Distance(b.geometry::geography, point.g), b.name
   LIMIT 1;
$$;

-- -----------------------------------------------------------------------------
-- brands.home_market_id: Tier 3 independents are local; Tier 1/2 are national.
-- -----------------------------------------------------------------------------
ALTER TABLE brands ADD COLUMN IF NOT EXISTS home_market_id UUID REFERENCES markets (id) ON DELETE RESTRICT;

-- Backfill independents from the market of their storefronts.
UPDATE brands b
   SET home_market_id = sub.market_id
  FROM (
    SELECT l.brand_id, min(l.market_id::text)::uuid AS market_id, count(DISTINCT l.market_id) AS markets
      FROM locations l
     GROUP BY l.brand_id
  ) sub
 WHERE b.id = sub.brand_id AND b.corporate_tier = 3 AND b.home_market_id IS NULL AND sub.markets = 1;

DO $$
DECLARE
  v_spanning INT;
BEGIN
  SELECT count(*) INTO v_spanning
    FROM brands b
   WHERE b.corporate_tier = 3
     AND (SELECT count(DISTINCT l.market_id) FROM locations l WHERE l.brand_id = b.id) > 1;
  IF v_spanning > 0 THEN
    RAISE EXCEPTION '% Tier 3 brand(s) have storefronts in more than one market; split them first.', v_spanning;
  END IF;
END
$$;

ALTER TABLE brands ADD CONSTRAINT brands_home_market_independent_only CHECK (
  corporate_tier = 3 OR home_market_id IS NULL
);

DROP INDEX IF EXISTS brands_name_vertical_uniq_idx;
CREATE UNIQUE INDEX brands_name_vertical_market_uniq_idx
  ON brands (lower(btrim(name)), industry_vertical,
             COALESCE(home_market_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Safety net for direct inserts: an independent's first storefront fixes its
-- home market, and an independent can never open a storefront in another market.
CREATE OR REPLACE FUNCTION public.enforce_independent_home_market()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_tier        INT;
  v_home_market UUID;
BEGIN
  SELECT corporate_tier, home_market_id INTO v_tier, v_home_market FROM brands WHERE id = NEW.brand_id;
  IF v_tier <> 3 THEN
    RETURN NEW;
  END IF;
  IF v_home_market IS NULL THEN
    UPDATE brands SET home_market_id = NEW.market_id WHERE id = NEW.brand_id;
  ELSIF v_home_market <> NEW.market_id THEN
    RAISE EXCEPTION 'independent_market_mismatch: a Tier 3 brand cannot have storefronts outside its home market.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER locations_enforce_independent_home_market
  AFTER INSERT OR UPDATE OF market_id, brand_id ON locations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_independent_home_market();

-- -----------------------------------------------------------------------------
-- Generic provenance source types (usable in any market). Legacy NY-specific
-- values stay valid. Keep in sync with lib/import/venues.ts.
-- -----------------------------------------------------------------------------
ALTER TABLE brands DROP CONSTRAINT brands_ownership_source_type_check;
ALTER TABLE brands
  ADD CONSTRAINT brands_ownership_source_type_check CHECK (ownership_source_type IN (
    'sec_edgar', 'investor_press_release', 'pitchbook', 'crunchbase', 'mergr', 'reputable_news',
    'state_business_registry', 'local_press', 'community_consensus',
    'nys_dos_corporations', 'eater_ny'
  ));

-- -----------------------------------------------------------------------------
-- approve_submission: the old ON CONFLICT target (the dropped index) no longer
-- exists, so the routine is rebuilt around markets. p_city is kept for
-- signature compatibility but ignored: the city now comes from the market.
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
  p_city                       TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_submission   submissions%ROWTYPE;
  v_point        GEOMETRY := ST_SetSRID(ST_MakePoint(p_longitude, p_latitude), 4326);
  v_market_id    UUID;
  v_home_market  UUID;
  v_brand_id     UUID;
  v_location_id  UUID;
  v_neighborhood TEXT;
BEGIN
  SELECT * INTO v_submission
    FROM submissions
   WHERE id = p_submission_id AND status = 'pending'
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission_not_pending';
  END IF;

  v_market_id := public.resolve_market_id(v_point);
  IF v_market_id IS NULL THEN
    RAISE EXCEPTION 'location_outside_markets';
  END IF;
  v_home_market := CASE WHEN p_corporate_tier = 3 THEN v_market_id END;

  -- Never silently contradict a recorded tier: a same-named brand in the same
  -- scope (national, or this market for independents) with another tier blocks.
  IF EXISTS (
    SELECT 1 FROM brands
     WHERE lower(btrim(name)) = lower(btrim(v_submission.business_name))
       AND industry_vertical = p_industry_vertical
       AND corporate_tier <> p_corporate_tier
       AND (home_market_id IS NULL OR home_market_id = v_market_id OR p_corporate_tier <> 3)
  ) THEN
    RAISE EXCEPTION 'brand_tier_conflict';
  END IF;

  INSERT INTO brands (name, corporate_tier, industry_vertical, parent_entity,
                      unique_selling_proposition, home_market_id)
  VALUES (btrim(v_submission.business_name), p_corporate_tier, p_industry_vertical,
          p_parent_entity, p_unique_selling_proposition, v_home_market)
  ON CONFLICT (lower(btrim(name)), industry_vertical,
               COALESCE(home_market_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO NOTHING
  RETURNING id INTO v_brand_id;

  IF v_brand_id IS NULL THEN
    SELECT id INTO v_brand_id
      FROM brands
     WHERE lower(btrim(name)) = lower(btrim(v_submission.business_name))
       AND industry_vertical = p_industry_vertical
       AND home_market_id IS NOT DISTINCT FROM v_home_market;
  END IF;

  SELECT r.name INTO v_neighborhood
    FROM resolve_neighborhood_in_market(p_longitude, p_latitude, v_market_id) r;

  INSERT INTO locations (brand_id, address, neighborhood, coordinates)
  VALUES (v_brand_id, btrim(v_submission.street_address), v_neighborhood, v_point)
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
