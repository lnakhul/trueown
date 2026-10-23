-- =============================================================================
-- Storefront review queue: establishments pulled from public datasets (NYC
-- restaurant inspections first) waiting for an admin to publish or reject them.
--
--   * Imports run from the trusted CLI (owner role); API roles cannot write here.
--   * Nothing is public until an admin approves it through an audited routine:
--       - approve_storefront_candidates(): add matched storefronts to their brand
--         (the brand's ownership claim and source are already on record);
--       - add_independent_from_candidate(): publish a new Tier 3 brand, which
--         needs its own evidence like any other ownership claim;
--       - reject_storefront_candidates(): keep it off the map.
--
-- Safe to re-run. SECURITY DEFINER routines pin search_path to public +
-- extensions (Supabase installs PostGIS in `extensions`).
-- =============================================================================

CREATE TABLE IF NOT EXISTS storefront_candidates (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source             TEXT NOT NULL CHECK (source ~ '^[a-z0-9_]+$'),
  source_record_id   TEXT NOT NULL CHECK (length(btrim(source_record_id)) BETWEEN 1 AND 64),
  market_id          UUID NOT NULL REFERENCES markets (id) ON DELETE CASCADE,
  name               TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  address            TEXT NOT NULL CHECK (length(btrim(address)) BETWEEN 1 AND 300),
  borough            TEXT,
  category           TEXT,
  industry_vertical  industry_vertical NOT NULL DEFAULT 'coffee_bakery',
  latitude           DOUBLE PRECISION CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude          DOUBLE PRECISION CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  matched_brand_id   UUID REFERENCES brands (id) ON DELETE SET NULL,
  match_kind         TEXT NOT NULL DEFAULT 'none' CHECK (match_kind IN ('exact', 'possible', 'none')),
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'approved', 'rejected', 'already_listed')),
  location_id        UUID REFERENCES locations (id) ON DELETE SET NULL,
  source_updated_on  DATE,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by        UUID,
  reviewed_at        TIMESTAMPTZ,
  review_note        TEXT CHECK (review_note IS NULL OR length(review_note) <= 500),
  CONSTRAINT storefront_candidates_source_record_key UNIQUE (source, source_record_id),
  CONSTRAINT storefront_candidates_coordinates_pair CHECK ((latitude IS NULL) = (longitude IS NULL))
);

CREATE INDEX IF NOT EXISTS storefront_candidates_queue_idx
  ON storefront_candidates (market_id, status, match_kind, matched_brand_id);

ALTER TABLE storefront_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON storefront_candidates FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON storefront_candidates FROM anon, authenticated';
    EXECUTE 'GRANT SELECT ON storefront_candidates TO authenticated';
  END IF;
END
$$;

DROP POLICY IF EXISTS storefront_candidates_select_admin ON storefront_candidates;
CREATE POLICY storefront_candidates_select_admin ON storefront_candidates
  FOR SELECT TO authenticated USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- Audit log: storefront actions
-- -----------------------------------------------------------------------------
ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS admin_audit_log_action_check;
ALTER TABLE admin_audit_log ADD CONSTRAINT admin_audit_log_action_check
  CHECK (action IN ('approve', 'reject', 'reverify', 'correct', 'resolve_correction', 'dismiss_correction',
                    'approve_storefront', 'reject_storefront', 'add_independent'));

-- -----------------------------------------------------------------------------
-- Shared: publish one candidate as a storefront of a brand.
-- Internal helper (no grants): callers are the admin-gated routines below.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.publish_storefront_candidate(p_candidate storefront_candidates, p_brand_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_point        GEOMETRY;
  v_neighborhood TEXT;
  v_location_id  UUID;
BEGIN
  IF p_candidate.latitude IS NULL THEN
    RAISE EXCEPTION 'missing_coordinates';
  END IF;
  v_point := ST_SetSRID(ST_MakePoint(p_candidate.longitude, p_candidate.latitude), 4326);

  SELECT r.name INTO v_neighborhood
    FROM resolve_neighborhood_in_market(p_candidate.longitude, p_candidate.latitude, p_candidate.market_id) r;

  INSERT INTO locations (brand_id, address, neighborhood, coordinates)
  VALUES (p_brand_id, p_candidate.address, v_neighborhood, v_point)
  ON CONFLICT (brand_id, lower(btrim(address))) DO NOTHING
  RETURNING id INTO v_location_id;

  IF v_location_id IS NULL THEN
    SELECT id INTO v_location_id FROM locations
     WHERE brand_id = p_brand_id AND lower(btrim(address)) = lower(btrim(p_candidate.address));
  END IF;
  RETURN v_location_id;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_storefront_candidate(storefront_candidates, UUID) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.publish_storefront_candidate(storefront_candidates, UUID) FROM anon, authenticated';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- approve_storefront_candidates: add storefronts to a brand that is already live.
-- p_brand_id NULL = use each candidate's matched brand (exact matches only);
-- otherwise every candidate is attached to p_brand_id (confirming a possible match
-- or linking one by hand).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION approve_storefront_candidates(
  p_candidate_ids UUID[],
  p_brand_id      UUID DEFAULT NULL
) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor_id  UUID := public.current_actor_id();
  v_claims    JSONB := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  v_candidate storefront_candidates%ROWTYPE;
  v_brand_id  UUID;
  v_location  UUID;
  v_count     INT := 0;
BEGIN
  IF NOT public.is_admin() OR v_actor_id IS NULL THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_candidate_ids IS NULL OR cardinality(p_candidate_ids) = 0 OR cardinality(p_candidate_ids) > 500 THEN
    RAISE EXCEPTION 'invalid_batch';
  END IF;
  IF p_brand_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM brands WHERE id = p_brand_id) THEN
    RAISE EXCEPTION 'brand_not_found';
  END IF;

  FOR v_candidate IN
    SELECT * FROM storefront_candidates WHERE id = ANY (p_candidate_ids) ORDER BY id FOR UPDATE
  LOOP
    IF v_candidate.status <> 'pending' THEN
      RAISE EXCEPTION 'candidate_not_pending';
    END IF;
    IF p_brand_id IS NULL THEN
      IF v_candidate.match_kind <> 'exact' OR v_candidate.matched_brand_id IS NULL THEN
        RAISE EXCEPTION 'needs_brand_confirmation';
      END IF;
      v_brand_id := v_candidate.matched_brand_id;
    ELSE
      v_brand_id := p_brand_id;
    END IF;

    v_location := public.publish_storefront_candidate(v_candidate, v_brand_id);

    UPDATE storefront_candidates
       SET status = 'approved', location_id = v_location, matched_brand_id = v_brand_id,
           reviewed_by = v_actor_id, reviewed_at = now()
     WHERE id = v_candidate.id;

    INSERT INTO admin_audit_log (actor_id, actor_email, action, brand_id, payload)
    VALUES (v_actor_id, left(v_claims ->> 'email', 320), 'approve_storefront', v_brand_id,
            jsonb_build_object('storefront_candidate_id', v_candidate.id, 'location_id', v_location,
                               'source', v_candidate.source, 'source_record_id', v_candidate.source_record_id,
                               'address', v_candidate.address));
    v_count := v_count + 1;
  END LOOP;

  IF v_count <> cardinality(p_candidate_ids) THEN
    RAISE EXCEPTION 'candidate_not_found';
  END IF;
  RETURN v_count;
END;
$$;

-- -----------------------------------------------------------------------------
-- add_independent_from_candidate: a new Tier 3 brand needs its own evidence.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION add_independent_from_candidate(
  p_candidate_id          UUID,
  p_brand_name            TEXT,
  p_ownership_source_type TEXT,
  p_ownership_source_url  TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor_id  UUID := public.current_actor_id();
  v_claims    JSONB := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  v_candidate storefront_candidates%ROWTYPE;
  v_name      TEXT := btrim(p_brand_name);
  v_brand_id  UUID;
  v_location  UUID;
BEGIN
  IF NOT public.is_admin() OR v_actor_id IS NULL THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_name IS NULL OR length(v_name) = 0 OR length(v_name) > 200 THEN
    RAISE EXCEPTION 'invalid_name';
  END IF;
  IF NOT public.source_type_fits_tier(3, p_ownership_source_type) THEN
    RAISE EXCEPTION 'invalid_source_type';
  END IF;

  SELECT * INTO v_candidate FROM storefront_candidates WHERE id = p_candidate_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'candidate_not_found';
  END IF;
  IF v_candidate.status <> 'pending' THEN
    RAISE EXCEPTION 'candidate_not_pending';
  END IF;

  -- A chain or an existing independent with this name must be linked, not duplicated.
  IF EXISTS (
    SELECT 1 FROM brands
     WHERE lower(btrim(name)) = lower(v_name)
       AND industry_vertical = v_candidate.industry_vertical
       AND (home_market_id IS NULL OR home_market_id = v_candidate.market_id)
  ) THEN
    RAISE EXCEPTION 'brand_exists';
  END IF;

  INSERT INTO brands (name, corporate_tier, industry_vertical, home_market_id,
                      ownership_source_type, ownership_source_url, ownership_verified_on)
  VALUES (v_name, 3, v_candidate.industry_vertical, v_candidate.market_id,
          p_ownership_source_type, btrim(p_ownership_source_url), current_date)
  RETURNING id INTO v_brand_id;

  v_location := public.publish_storefront_candidate(v_candidate, v_brand_id);

  UPDATE storefront_candidates
     SET status = 'approved', location_id = v_location, matched_brand_id = v_brand_id,
         reviewed_by = v_actor_id, reviewed_at = now()
   WHERE id = p_candidate_id;

  -- Other pending shops with the same name in this market now match the new brand,
  -- so its remaining locations can be approved as a batch.
  UPDATE storefront_candidates
     SET matched_brand_id = v_brand_id, match_kind = 'exact', industry_vertical = v_candidate.industry_vertical
   WHERE status = 'pending'
     AND market_id = v_candidate.market_id
     AND id <> p_candidate_id
     AND lower(btrim(name)) IN (lower(btrim(v_candidate.name)), lower(v_name));

  INSERT INTO admin_audit_log (actor_id, actor_email, action, brand_id, payload)
  VALUES (v_actor_id, left(v_claims ->> 'email', 320), 'add_independent', v_brand_id,
          jsonb_build_object('storefront_candidate_id', p_candidate_id, 'location_id', v_location,
                             'corporate_tier', 3, 'ownership_source_type', p_ownership_source_type,
                             'evidence_url', btrim(p_ownership_source_url)));
  RETURN v_location;
END;
$$;

-- -----------------------------------------------------------------------------
-- reject_storefront_candidates: keep establishments off the map (with a reason).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reject_storefront_candidates(
  p_candidate_ids UUID[],
  p_note          TEXT
) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor_id UUID := public.current_actor_id();
  v_claims   JSONB := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  v_note     TEXT := NULLIF(btrim(p_note), '');
  v_count    INT;
BEGIN
  IF NOT public.is_admin() OR v_actor_id IS NULL THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_note IS NULL OR length(v_note) > 500 THEN
    RAISE EXCEPTION 'note_required';
  END IF;
  IF p_candidate_ids IS NULL OR cardinality(p_candidate_ids) = 0 OR cardinality(p_candidate_ids) > 500 THEN
    RAISE EXCEPTION 'invalid_batch';
  END IF;

  UPDATE storefront_candidates
     SET status = 'rejected', review_note = v_note, reviewed_by = v_actor_id, reviewed_at = now()
   WHERE id = ANY (p_candidate_ids) AND status = 'pending';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> cardinality(p_candidate_ids) THEN
    RAISE EXCEPTION 'candidate_not_pending';
  END IF;

  INSERT INTO admin_audit_log (actor_id, actor_email, action, payload)
  VALUES (v_actor_id, left(v_claims ->> 'email', 320), 'reject_storefront',
          jsonb_build_object('storefront_candidate_ids', to_jsonb(p_candidate_ids), 'note', v_note));
  RETURN v_count;
END;
$$;

DO $$
DECLARE
  v_signature TEXT;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'approve_storefront_candidates(uuid[], uuid)',
    'add_independent_from_candidate(uuid, text, text, text)',
    'reject_storefront_candidates(uuid[], text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_signature);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_signature);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_signature);
    END IF;
  END LOOP;
END
$$;
