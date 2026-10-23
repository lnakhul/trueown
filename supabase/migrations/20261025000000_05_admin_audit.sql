-- =============================================================================
-- Admin vetting hardening: reviewer identity, mandatory provenance on approval,
-- and an append-only audit log.
--
--   * Submissions can no longer be updated directly by any API role. A status
--     change happens only through approve_submission() / reject_submission(),
--     which check is_admin() against the verified JWT claims of the request,
--     record who decided, and append to admin_audit_log in the same transaction.
--   * Approving a Tier 1/2 or Tier 3 brand requires an ownership source type
--     that fits the tier; the submission's evidence URL becomes the brand's
--     public audit URL (no ownership claim goes live without provenance).
--   * admin_audit_log is readable by admins only; nobody can write it directly.
--
-- Safe to re-run. The SECURITY DEFINER routines pin search_path to
-- public + extensions: on Supabase, PostGIS (geometry, ST_*) lives in the
-- `extensions` schema; on plain Postgres that schema is absent and ignored.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Reviewer identity on submissions
-- -----------------------------------------------------------------------------
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS reviewed_by UUID;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS review_note TEXT
  CHECK (review_note IS NULL OR (length(btrim(review_note)) > 0 AND length(review_note) <= 500));

-- -----------------------------------------------------------------------------
-- The acting user, from the request's JWT claims (null when absent/invalid).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_actor_id()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
           WHEN claims ->> 'sub' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN (claims ->> 'sub')::uuid
         END
    FROM (SELECT NULLIF(current_setting('request.jwt.claims', true), '')::jsonb AS claims) c;
$$;

GRANT EXECUTE ON FUNCTION public.current_actor_id() TO anon, authenticated;

-- -----------------------------------------------------------------------------
-- admin_audit_log: append-only record of every vetting decision
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id      UUID NOT NULL,
  actor_email   TEXT CHECK (actor_email IS NULL OR length(actor_email) <= 320),
  action        TEXT NOT NULL CHECK (action IN ('approve', 'reject')),
  submission_id UUID REFERENCES submissions (id) ON DELETE SET NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_audit_log_created_at_idx ON admin_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_log_submission_idx ON admin_audit_log (submission_id);

ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON admin_audit_log FROM PUBLIC;
REVOKE ALL ON admin_audit_log FROM anon, authenticated;
GRANT SELECT ON admin_audit_log TO authenticated;

DROP POLICY IF EXISTS admin_audit_log_select_admin ON admin_audit_log;
CREATE POLICY admin_audit_log_select_admin ON admin_audit_log
  FOR SELECT TO authenticated USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- Submissions: no direct status changes by API roles.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS submissions_update_admin ON public.submissions;
REVOKE UPDATE ON public.submissions FROM anon, authenticated;

-- -----------------------------------------------------------------------------
-- approve_submission (new signature; the old one is dropped)
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS approve_submission(UUID, INT, TEXT, industry_vertical, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT);

CREATE OR REPLACE FUNCTION approve_submission(
  p_submission_id              UUID,
  p_corporate_tier             INT,
  p_parent_entity              TEXT,
  p_industry_vertical          industry_vertical,
  p_unique_selling_proposition TEXT,
  p_ownership_source_type      TEXT,
  p_latitude                   DOUBLE PRECISION,
  p_longitude                  DOUBLE PRECISION
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor_id     UUID := public.current_actor_id();
  v_claims       JSONB := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  v_submission   submissions%ROWTYPE;
  v_point        GEOMETRY := ST_SetSRID(ST_MakePoint(p_longitude, p_latitude), 4326);
  v_market_id    UUID;
  v_home_market  UUID;
  v_brand_id     UUID;
  v_location_id  UUID;
  v_neighborhood TEXT;
BEGIN
  -- Fail closed: a verified admin JWT with a subject is required.
  IF NOT public.is_admin() OR v_actor_id IS NULL THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_corporate_tier NOT IN (1, 2, 3) THEN
    RAISE EXCEPTION 'invalid_tier';
  END IF;
  -- Keep in sync with lib/provenance.ts.
  IF p_ownership_source_type IS NULL
     OR (p_corporate_tier IN (1, 2) AND NOT p_ownership_source_type = ANY (ARRAY[
        'sec_edgar', 'investor_press_release', 'pitchbook', 'crunchbase', 'mergr', 'reputable_news']))
     OR (p_corporate_tier = 3 AND NOT p_ownership_source_type = ANY (ARRAY[
        'state_business_registry', 'local_press', 'community_consensus', 'nys_dos_corporations', 'eater_ny']))
  THEN
    RAISE EXCEPTION 'invalid_source_type';
  END IF;

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

  -- Never silently contradict a recorded tier (same scope: national, or this market).
  IF EXISTS (
    SELECT 1 FROM brands
     WHERE lower(btrim(name)) = lower(btrim(v_submission.business_name))
       AND industry_vertical = p_industry_vertical
       AND corporate_tier <> p_corporate_tier
       AND (home_market_id IS NULL OR home_market_id = v_market_id OR p_corporate_tier <> 3)
  ) THEN
    RAISE EXCEPTION 'brand_tier_conflict';
  END IF;

  -- Provenance: the vetted evidence link is the brand's public audit URL.
  INSERT INTO brands (name, corporate_tier, industry_vertical, parent_entity,
                      unique_selling_proposition, home_market_id,
                      ownership_source_type, ownership_source_url, ownership_verified_on)
  VALUES (btrim(v_submission.business_name), p_corporate_tier, p_industry_vertical,
          p_parent_entity, p_unique_selling_proposition, v_home_market,
          p_ownership_source_type, v_submission.evidence_url, current_date)
  ON CONFLICT (lower(btrim(name)), industry_vertical,
               COALESCE(home_market_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO NOTHING
  RETURNING id INTO v_brand_id;

  IF v_brand_id IS NULL THEN
    SELECT id INTO v_brand_id
      FROM brands
     WHERE lower(btrim(name)) = lower(btrim(v_submission.business_name))
       AND industry_vertical = p_industry_vertical
       AND home_market_id IS NOT DISTINCT FROM v_home_market;

    -- Existing brand without provenance: this approval supplies it.
    UPDATE brands
       SET ownership_source_type = p_ownership_source_type,
           ownership_source_url  = v_submission.evidence_url,
           ownership_verified_on = current_date
     WHERE id = v_brand_id AND ownership_source_url IS NULL;
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
     SET status = 'approved', reviewed_at = now(), reviewed_by = v_actor_id
   WHERE id = p_submission_id;

  INSERT INTO admin_audit_log (actor_id, actor_email, action, submission_id, payload)
  VALUES (v_actor_id, left(v_claims ->> 'email', 320), 'approve', p_submission_id,
          jsonb_build_object(
            'brand_id', v_brand_id,
            'location_id', v_location_id,
            'market_id', v_market_id,
            'corporate_tier', p_corporate_tier,
            'parent_entity', p_parent_entity,
            'industry_vertical', p_industry_vertical,
            'ownership_source_type', p_ownership_source_type,
            'evidence_url', v_submission.evidence_url));

  RETURN v_location_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- reject_submission
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reject_submission(
  p_submission_id UUID,
  p_review_note   TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor_id UUID := public.current_actor_id();
  v_claims   JSONB := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  v_note     TEXT := NULLIF(btrim(p_review_note), '');
BEGIN
  IF NOT public.is_admin() OR v_actor_id IS NULL THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE submissions
     SET status = 'rejected', reviewed_at = now(), reviewed_by = v_actor_id, review_note = v_note
   WHERE id = p_submission_id AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission_not_pending';
  END IF;

  INSERT INTO admin_audit_log (actor_id, actor_email, action, submission_id, payload)
  VALUES (v_actor_id, left(v_claims ->> 'email', 320), 'reject', p_submission_id,
          jsonb_build_object('review_note', v_note));
END;
$$;

-- -----------------------------------------------------------------------------
-- Execution rights: authenticated callers only (the functions check is_admin()).
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION approve_submission(UUID, INT, TEXT, industry_vertical, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION) FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_submission(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION approve_submission(UUID, INT, TEXT, industry_vertical, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION) FROM anon;
REVOKE ALL ON FUNCTION reject_submission(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION approve_submission(UUID, INT, TEXT, industry_vertical, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated;
GRANT EXECUTE ON FUNCTION reject_submission(UUID, TEXT) TO authenticated;
