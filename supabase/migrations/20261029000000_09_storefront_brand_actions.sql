-- =============================================================================
-- Storefront queue: add a PE/VC-backed brand straight from a group of shops, and
-- undo rejections.
--
--   * add_corporate_brand_from_candidates(): a Tier 1/2 brand (national, so no
--     home market) created with its ownership evidence, in one audited step. Every
--     pending shop with the same name then becomes a chain match for that brand,
--     ready for "Approve all". Nothing is published by this call itself.
--   * reopen_storefront_candidates(): puts rejected shops back in the queue
--     (re-matched against the current brands), with a reason.
--
-- Safe to re-run. SECURITY DEFINER routines pin search_path to public +
-- extensions (Supabase installs PostGIS in `extensions`).
-- =============================================================================

ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS admin_audit_log_action_check;
ALTER TABLE admin_audit_log ADD CONSTRAINT admin_audit_log_action_check
  CHECK (action IN ('approve', 'reject', 'reverify', 'correct', 'resolve_correction', 'dismiss_correction',
                    'approve_storefront', 'reject_storefront', 'add_independent',
                    'add_corporate_brand', 'reopen_storefront'));

-- -----------------------------------------------------------------------------
-- Pending shops whose name is exactly a brand's name become chain matches for it.
-- (The import's matcher is more thorough; this catches the common case at once.)
-- Internal helper: no grants.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rematch_pending_candidates_by_name(p_candidate_ids UUID[] DEFAULT NULL)
RETURNS INT
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_count INT;
BEGIN
  UPDATE storefront_candidates c
     SET matched_brand_id = b.id, match_kind = 'exact', industry_vertical = b.industry_vertical
    FROM brands b
   WHERE c.status = 'pending'
     AND c.match_kind <> 'exact'
     AND (p_candidate_ids IS NULL OR c.id = ANY (p_candidate_ids))
     AND lower(btrim(c.name)) = lower(btrim(b.name))
     AND (b.home_market_id IS NULL OR b.home_market_id = c.market_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.rematch_pending_candidates_by_name(UUID[]) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.rematch_pending_candidates_by_name(UUID[]) FROM anon, authenticated';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- add_corporate_brand_from_candidates
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION add_corporate_brand_from_candidates(
  p_candidate_id          UUID,
  p_brand_name            TEXT,
  p_corporate_tier        INT,
  p_parent_entity         TEXT,
  p_financial_backers     TEXT[],
  p_ownership_source_type TEXT,
  p_ownership_source_url  TEXT
) RETURNS TABLE (brand_id UUID, moved_to_chain_matches INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor_id  UUID := public.current_actor_id();
  v_claims    JSONB := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  v_candidate storefront_candidates%ROWTYPE;
  v_name      TEXT := btrim(p_brand_name);
  v_parent    TEXT := NULLIF(btrim(p_parent_entity), '');
  v_backers   TEXT[] := COALESCE(p_financial_backers, '{}');
  v_brand_id  UUID;
  v_moved     INT;
BEGIN
  IF NOT public.is_admin() OR v_actor_id IS NULL THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_corporate_tier NOT IN (1, 2) THEN
    RAISE EXCEPTION 'invalid_tier';
  END IF;
  IF v_name IS NULL OR length(v_name) = 0 OR length(v_name) > 200 THEN
    RAISE EXCEPTION 'invalid_name';
  END IF;
  IF v_parent IS NULL OR length(v_parent) > 200 THEN
    RAISE EXCEPTION 'parent_required';
  END IF;
  IF NOT public.source_type_fits_tier(p_corporate_tier, p_ownership_source_type) THEN
    RAISE EXCEPTION 'invalid_source_type';
  END IF;

  SELECT * INTO v_candidate FROM storefront_candidates WHERE id = p_candidate_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'candidate_not_found';
  END IF;
  IF v_candidate.status <> 'pending' THEN
    RAISE EXCEPTION 'candidate_not_pending';
  END IF;

  -- Any live brand with this name (national, or a local independent anywhere)
  -- must be resolved by hand rather than shadowed by a new national brand.
  IF EXISTS (
    SELECT 1 FROM brands
     WHERE lower(btrim(name)) = lower(v_name)
       AND industry_vertical = v_candidate.industry_vertical
  ) THEN
    RAISE EXCEPTION 'brand_exists';
  END IF;

  INSERT INTO brands (name, corporate_tier, industry_vertical, parent_entity, financial_backers,
                      ownership_source_type, ownership_source_url, ownership_verified_on)
  VALUES (v_name, p_corporate_tier, v_candidate.industry_vertical, v_parent, v_backers,
          p_ownership_source_type, btrim(p_ownership_source_url), current_date)
  RETURNING id INTO v_brand_id;

  -- The clicked group (by the shop's own name) plus anything listed under the brand name.
  UPDATE storefront_candidates
     SET matched_brand_id = v_brand_id, match_kind = 'exact', industry_vertical = v_candidate.industry_vertical
   WHERE status = 'pending'
     AND lower(btrim(name)) IN (lower(btrim(v_candidate.name)), lower(v_name));
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  INSERT INTO admin_audit_log (actor_id, actor_email, action, brand_id, payload)
  VALUES (v_actor_id, left(v_claims ->> 'email', 320), 'add_corporate_brand', v_brand_id,
          jsonb_build_object('storefront_candidate_id', p_candidate_id,
                             'corporate_tier', p_corporate_tier,
                             'parent_entity', v_parent,
                             'financial_backers', to_jsonb(v_backers),
                             'ownership_source_type', p_ownership_source_type,
                             'evidence_url', btrim(p_ownership_source_url),
                             'moved_to_chain_matches', v_moved));

  RETURN QUERY SELECT v_brand_id, v_moved;
END;
$$;

-- -----------------------------------------------------------------------------
-- reopen_storefront_candidates: undo a rejection
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reopen_storefront_candidates(
  p_candidate_ids UUID[],
  p_note          TEXT DEFAULT NULL
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
  IF p_candidate_ids IS NULL OR cardinality(p_candidate_ids) = 0 OR cardinality(p_candidate_ids) > 500 THEN
    RAISE EXCEPTION 'invalid_batch';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RAISE EXCEPTION 'note_too_long';
  END IF;

  -- Back to the queue as if newly found: the next import (or the name re-match
  -- below) decides which brand, if any, it belongs to.
  UPDATE storefront_candidates
     SET status = 'pending', matched_brand_id = NULL, match_kind = 'none',
         reviewed_by = NULL, reviewed_at = NULL, review_note = NULL
   WHERE id = ANY (p_candidate_ids) AND status = 'rejected';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> cardinality(p_candidate_ids) THEN
    RAISE EXCEPTION 'candidate_not_rejected';
  END IF;

  PERFORM public.rematch_pending_candidates_by_name(p_candidate_ids);

  INSERT INTO admin_audit_log (actor_id, actor_email, action, payload)
  VALUES (v_actor_id, left(v_claims ->> 'email', 320), 'reopen_storefront',
          jsonb_build_object('storefront_candidate_ids', to_jsonb(p_candidate_ids), 'note', v_note));
  RETURN v_count;
END;
$$;

DO $$
DECLARE
  v_signature TEXT;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'add_corporate_brand_from_candidates(uuid, text, int, text, text[], text, text)',
    'reopen_storefront_candidates(uuid[], text)'
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
