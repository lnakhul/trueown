-- =============================================================================
-- Brand re-verification and corrections.
--
-- Ownership changes (PE firms exit after 3-7 years), so live claims need upkeep:
--   * reverify_brand(): records a fresh (or re-checked) source for a brand's
--     current claim and resets its verified date.
--   * correct_brand(): changes a brand's tier / parent / backers. A correction
--     always needs a new source and a reason.
-- Both check is_admin() against the request's verified JWT claims and append to
-- admin_audit_log in the same transaction. Admins can no longer write brands or
-- locations directly: every change to a public claim is audited.
--
-- Safe to re-run. SECURITY DEFINER routines pin search_path to public +
-- extensions (Supabase installs PostGIS in `extensions`).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Audit log: brand actions + a brand reference
-- -----------------------------------------------------------------------------
ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES brands (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS admin_audit_log_brand_idx ON admin_audit_log (brand_id, created_at DESC);

ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS admin_audit_log_action_check;
ALTER TABLE admin_audit_log ADD CONSTRAINT admin_audit_log_action_check
  CHECK (action IN ('approve', 'reject', 'reverify', 'correct'));

-- Approvals record the brand in their payload; mirror it into the column.
CREATE OR REPLACE FUNCTION public.audit_log_fill_brand_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.brand_id IS NULL AND NEW.payload ->> 'brand_id' ~* '^[0-9a-f-]{36}$' THEN
    NEW.brand_id := (NEW.payload ->> 'brand_id')::uuid;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS admin_audit_log_fill_brand_id ON admin_audit_log;
CREATE TRIGGER admin_audit_log_fill_brand_id
  BEFORE INSERT ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_fill_brand_id();

UPDATE admin_audit_log a
   SET brand_id = (a.payload ->> 'brand_id')::uuid
 WHERE a.brand_id IS NULL
   AND a.payload ->> 'brand_id' ~* '^[0-9a-f-]{36}$'
   AND EXISTS (SELECT 1 FROM brands b WHERE b.id = (a.payload ->> 'brand_id')::uuid);

-- -----------------------------------------------------------------------------
-- Which evidence types may back which tier. Keep in sync with lib/provenance.ts.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.source_type_fits_tier(p_corporate_tier INT, p_source_type TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
           WHEN p_corporate_tier IN (1, 2) THEN p_source_type = ANY (ARRAY[
             'sec_edgar', 'investor_press_release', 'pitchbook', 'crunchbase', 'mergr', 'reputable_news'])
           WHEN p_corporate_tier = 3 THEN p_source_type = ANY (ARRAY[
             'state_business_registry', 'local_press', 'community_consensus', 'nys_dos_corporations', 'eater_ny'])
           ELSE false
         END
         AND p_source_type IS NOT NULL;
$$;

-- -----------------------------------------------------------------------------
-- reverify_brand: same claim, fresh evidence
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reverify_brand(
  p_brand_id              UUID,
  p_ownership_source_type TEXT,
  p_ownership_source_url  TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor_id UUID := public.current_actor_id();
  v_claims   JSONB := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  v_brand    brands%ROWTYPE;
BEGIN
  IF NOT public.is_admin() OR v_actor_id IS NULL THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_brand FROM brands WHERE id = p_brand_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'brand_not_found';
  END IF;
  IF NOT public.source_type_fits_tier(v_brand.corporate_tier, p_ownership_source_type) THEN
    RAISE EXCEPTION 'invalid_source_type';
  END IF;

  UPDATE brands
     SET ownership_source_type = p_ownership_source_type,
         ownership_source_url  = btrim(p_ownership_source_url),
         ownership_verified_on = current_date
   WHERE id = p_brand_id;

  INSERT INTO admin_audit_log (actor_id, actor_email, action, brand_id, payload)
  VALUES (v_actor_id, left(v_claims ->> 'email', 320), 'reverify', p_brand_id,
          jsonb_build_object(
            'corporate_tier', v_brand.corporate_tier,
            'previous_source_type', v_brand.ownership_source_type,
            'previous_source_url', v_brand.ownership_source_url,
            'previous_verified_on', v_brand.ownership_verified_on,
            'ownership_source_type', p_ownership_source_type,
            'evidence_url', btrim(p_ownership_source_url)));
END;
$$;

-- -----------------------------------------------------------------------------
-- correct_brand: change the claim itself (always with new evidence and a reason)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION correct_brand(
  p_brand_id              UUID,
  p_corporate_tier        INT,
  p_parent_entity         TEXT,
  p_financial_backers     TEXT[],
  p_ownership_source_type TEXT,
  p_ownership_source_url  TEXT,
  p_review_note           TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor_id    UUID := public.current_actor_id();
  v_claims      JSONB := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  v_brand       brands%ROWTYPE;
  v_parent      TEXT := NULLIF(btrim(p_parent_entity), '');
  v_backers     TEXT[] := COALESCE(p_financial_backers, '{}');
  v_note        TEXT := NULLIF(btrim(p_review_note), '');
  v_home_market UUID;
  v_markets     INT;
BEGIN
  IF NOT public.is_admin() OR v_actor_id IS NULL THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_corporate_tier NOT IN (1, 2, 3) THEN
    RAISE EXCEPTION 'invalid_tier';
  END IF;
  IF v_note IS NULL OR length(v_note) > 500 THEN
    RAISE EXCEPTION 'note_required';
  END IF;
  IF NOT public.source_type_fits_tier(p_corporate_tier, p_ownership_source_type) THEN
    RAISE EXCEPTION 'invalid_source_type';
  END IF;

  SELECT * INTO v_brand FROM brands WHERE id = p_brand_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'brand_not_found';
  END IF;

  IF p_corporate_tier = 3 THEN
    -- Independents have no institutional parent or backers, and belong to one market.
    v_parent := NULL;
    v_backers := '{}';
    IF v_brand.corporate_tier = 3 THEN
      v_home_market := v_brand.home_market_id;
    ELSE
      SELECT count(DISTINCT market_id), min(market_id::text)::uuid INTO v_markets, v_home_market
        FROM locations WHERE brand_id = p_brand_id;
      IF v_markets > 1 THEN
        RAISE EXCEPTION 'independent_spans_markets';
      END IF;
    END IF;
  ELSE
    IF v_parent IS NULL THEN
      RAISE EXCEPTION 'parent_required';
    END IF;
    v_home_market := NULL;
  END IF;

  -- Another brand with this name in the new scope and a different tier would
  -- make the registry contradict itself.
  IF EXISTS (
    SELECT 1 FROM brands
     WHERE id <> p_brand_id
       AND lower(btrim(name)) = lower(btrim(v_brand.name))
       AND industry_vertical = v_brand.industry_vertical
       AND corporate_tier <> p_corporate_tier
       AND (home_market_id IS NULL OR v_home_market IS NULL OR home_market_id = v_home_market)
  ) THEN
    RAISE EXCEPTION 'brand_tier_conflict';
  END IF;

  BEGIN
    UPDATE brands
       SET corporate_tier        = p_corporate_tier,
           parent_entity         = v_parent,
           financial_backers     = v_backers,
           home_market_id        = v_home_market,
           ownership_source_type = p_ownership_source_type,
           ownership_source_url  = btrim(p_ownership_source_url),
           ownership_verified_on = current_date
     WHERE id = p_brand_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'brand_name_conflict';
  END;

  INSERT INTO admin_audit_log (actor_id, actor_email, action, brand_id, payload)
  VALUES (v_actor_id, left(v_claims ->> 'email', 320), 'correct', p_brand_id,
          jsonb_build_object(
            'review_note', v_note,
            'before', jsonb_build_object(
              'corporate_tier', v_brand.corporate_tier,
              'parent_entity', v_brand.parent_entity,
              'financial_backers', to_jsonb(v_brand.financial_backers),
              'ownership_source_type', v_brand.ownership_source_type,
              'ownership_source_url', v_brand.ownership_source_url,
              'ownership_verified_on', v_brand.ownership_verified_on),
            'after', jsonb_build_object(
              'corporate_tier', p_corporate_tier,
              'parent_entity', v_parent,
              'financial_backers', to_jsonb(v_backers),
              'ownership_source_type', p_ownership_source_type,
              'ownership_source_url', btrim(p_ownership_source_url)),
            'corporate_tier', p_corporate_tier,
            'ownership_source_type', p_ownership_source_type,
            'evidence_url', btrim(p_ownership_source_url)));
END;
$$;

REVOKE ALL ON FUNCTION reverify_brand(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION correct_brand(UUID, INT, TEXT, TEXT[], TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION reverify_brand(UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION correct_brand(UUID, INT, TEXT, TEXT[], TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION reverify_brand(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION correct_brand(UUID, INT, TEXT, TEXT[], TEXT, TEXT, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------
-- No direct writes to public claims by API roles: brands and storefronts change
-- only through the audited routines (approve/correct/reverify) or the trusted
-- import CLIs. Public reads are unchanged.
-- -----------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE ON public.brands, public.locations FROM anon, authenticated;
DROP POLICY IF EXISTS brands_insert_admin ON public.brands;
DROP POLICY IF EXISTS brands_update_admin ON public.brands;
DROP POLICY IF EXISTS brands_delete_admin ON public.brands;
DROP POLICY IF EXISTS locations_insert_admin ON public.locations;
DROP POLICY IF EXISTS locations_update_admin ON public.locations;
DROP POLICY IF EXISTS locations_delete_admin ON public.locations;
