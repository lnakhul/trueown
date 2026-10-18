-- =============================================================================
-- TrueOwn core schema: brands, locations, submissions
-- Designed for multi-city / multi-vertical scale: no city or industry is
-- hardcoded into table primitives.
-- =============================================================================

-- PostGIS provides geometry types, spatial indexes, ST_DWithin / ST_Distance.
CREATE EXTENSION IF NOT EXISTS postgis;

-- -----------------------------------------------------------------------------
-- Enumerations
-- -----------------------------------------------------------------------------
CREATE TYPE industry_vertical AS ENUM (
  'coffee_bakery',
  'restaurant',
  'bar_nightlife',
  'retail_boutique',
  'fitness_wellness'
);

CREATE TYPE submission_status AS ENUM ('pending', 'approved', 'rejected');

-- -----------------------------------------------------------------------------
-- brands: corporate identity + ownership tier
--   Tier 1: Majority PE buyout / institutional control
--   Tier 2: VC / aggressive growth equity financed
--   Tier 3: True independent / family-owned
-- -----------------------------------------------------------------------------
CREATE TABLE brands (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                       TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  corporate_tier             INT  NOT NULL CHECK (corporate_tier BETWEEN 1 AND 3),
  industry_vertical          industry_vertical NOT NULL DEFAULT 'coffee_bakery',
  parent_entity              TEXT,
  unique_selling_proposition TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Independents have no institutional parent; institutional tiers must name one.
  CONSTRAINT brands_parent_matches_tier CHECK (
    (corporate_tier = 3 AND parent_entity IS NULL)
    OR (corporate_tier IN (1, 2) AND parent_entity IS NOT NULL)
  )
);

CREATE INDEX brands_tier_vertical_idx ON brands (corporate_tier, industry_vertical);

-- -----------------------------------------------------------------------------
-- locations: physical storefronts
-- -----------------------------------------------------------------------------
CREATE TABLE locations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id     UUID NOT NULL REFERENCES brands (id) ON DELETE CASCADE,
  address      TEXT NOT NULL,
  neighborhood TEXT,
  city         TEXT NOT NULL DEFAULT 'New York',
  coordinates  GEOMETRY(Point, 4326) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX locations_brand_id_idx ON locations (brand_id);

-- Spatial index on the raw geometry column.
CREATE INDEX locations_coordinates_gist_idx ON locations USING GIST (coordinates);

-- Radius searches cast to geography to measure in meters; a matching
-- expression index keeps ST_DWithin(coordinates::geography, ...) index-assisted.
CREATE INDEX locations_coordinates_geog_gist_idx
  ON locations USING GIST ((coordinates::geography));

-- -----------------------------------------------------------------------------
-- submissions: crowdsourced tips awaiting admin vetting (fail-closed)
-- -----------------------------------------------------------------------------
CREATE TABLE submissions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name  TEXT NOT NULL CHECK (length(btrim(business_name)) > 0),
  street_address TEXT NOT NULL CHECK (length(btrim(street_address)) > 0),
  -- Strictly required: no evidence, no submission. Must be an http(s) URL.
  evidence_url   TEXT NOT NULL CHECK (evidence_url ~* '^https?://[^\s/]+\.[^\s/]{2,}(/\S*)?$'),
  status         submission_status NOT NULL DEFAULT 'pending',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at    TIMESTAMPTZ
);

CREATE INDEX submissions_status_idx ON submissions (status, created_at DESC);

-- -----------------------------------------------------------------------------
-- Row Level Security (Supabase): public read of catalog; no direct anon writes.
-- Submissions are written only through the server API (service/db role).
-- -----------------------------------------------------------------------------
ALTER TABLE brands      ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- The 'anon' role exists on Supabase; skip policies on plain Postgres.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'CREATE POLICY brands_public_read ON brands FOR SELECT TO anon USING (true)';
    EXECUTE 'CREATE POLICY locations_public_read ON locations FOR SELECT TO anon USING (true)';
    EXECUTE 'CREATE POLICY submissions_public_read_approved ON submissions FOR SELECT TO anon USING (status = ''approved'')';
  END IF;
END
$$;
