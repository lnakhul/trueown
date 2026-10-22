-- =============================================================================
-- Regional markets: the cities TrueOwn serves (or will serve).
--
-- NOTE: timestamp-prefixed (like the other migrations) so it sorts after the
-- tables it extends; Supabase applies migrations in filename order.
--
-- A market is a city plus a geographic center. A point belongs to a market when
-- it lies within 50 miles (80,467 m) of that center. Every location carries a
-- market_id, assigned automatically from its coordinates, so discovery queries
-- can be isolated per market and a coordinate outside every active market can
-- be answered with the closest available one.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- markets
-- -----------------------------------------------------------------------------
CREATE TABLE markets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city_name         TEXT NOT NULL CHECK (length(btrim(city_name)) > 0 AND length(city_name) <= 100),
  status            TEXT NOT NULL DEFAULT 'coming_soon' CHECK (status IN ('active', 'coming_soon')),
  geographic_center GEOMETRY(Point, 4326) NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX markets_city_name_key ON markets (lower(btrim(city_name)));
CREATE INDEX markets_status_idx ON markets (status);
CREATE INDEX markets_center_geog_gist_idx ON markets USING GIST ((geographic_center::geography));

-- Seed: NYC is live; Austin and Chicago are announced but not yet served.
INSERT INTO markets (city_name, status, geographic_center) VALUES
  ('New York City', 'active',      ST_SetSRID(ST_MakePoint(-73.9855, 40.7580), 4326)),
  ('Austin',        'coming_soon', ST_SetSRID(ST_MakePoint(-97.7431, 30.2672), 4326)),
  ('Chicago',       'coming_soon', ST_SetSRID(ST_MakePoint(-87.6298, 41.8781), 4326))
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- Point -> market resolution (50-mile radius, nearest center wins).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_market_id(p_point GEOMETRY)
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT m.id
    FROM markets m
   WHERE ST_DWithin(m.geographic_center::geography, p_point::geography, 80467.2)
   ORDER BY ST_Distance(m.geographic_center::geography, p_point::geography)
   LIMIT 1;
$$;

-- -----------------------------------------------------------------------------
-- locations.market_id
-- -----------------------------------------------------------------------------
ALTER TABLE locations ADD COLUMN IF NOT EXISTS market_id UUID;

UPDATE locations SET market_id = public.resolve_market_id(coordinates) WHERE market_id IS NULL;

-- Fail loudly (instead of hiding rows) if an existing storefront is outside every market.
DO $$
DECLARE
  v_orphans INT;
BEGIN
  SELECT count(*) INTO v_orphans FROM locations WHERE market_id IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION '% location(s) are not within 50 miles of any market; add a market first.', v_orphans;
  END IF;
END
$$;

ALTER TABLE locations ALTER COLUMN market_id SET NOT NULL;
ALTER TABLE locations
  ADD CONSTRAINT locations_market_id_fkey
  FOREIGN KEY (market_id) REFERENCES markets (id) ON DELETE RESTRICT;
CREATE INDEX locations_market_id_idx ON locations (market_id);

-- Assign the market on insert (or when the point moves). Unresolvable points are rejected.
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
  RETURN NEW;
END;
$$;

CREATE TRIGGER locations_assign_market
  BEFORE INSERT OR UPDATE OF coordinates, market_id ON locations
  FOR EACH ROW EXECUTE FUNCTION public.assign_location_market();

-- -----------------------------------------------------------------------------
-- Row level security and explicit grants (required for new public tables).
-- Public SELECT; writes admin only (same model as brands and locations).
-- -----------------------------------------------------------------------------
ALTER TABLE markets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.markets FROM anon, authenticated;
GRANT SELECT ON public.markets TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.markets TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.markets TO service_role;
  END IF;
END
$$;

CREATE POLICY markets_select_public ON public.markets
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY markets_insert_admin ON public.markets
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY markets_update_admin ON public.markets
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY markets_delete_admin ON public.markets
  FOR DELETE TO authenticated USING (public.is_admin());
