-- =============================================================================
-- Independent verification at scale.
--
--   * registry_suggestions: New York State business-registry entities that may be
--     the legal owner of a possible independent in the storefront queue (written
--     by the trusted CLI, admin-only read). A suggestion is never evidence by
--     itself: an admin picks it, and it becomes the listing's source.
--   * 'owner_attestation': a new Tier 3 evidence type. The owner confirmed the
--     business is independently owned; the public link is the business's website.
--   * business_claims: "Claim your business" requests from owners (public insert of
--     open claims only, admin-only read because they hold contact details), closed
--     through the audited, admin-only resolve_business_claim().
--
-- Safe to re-run. SECURITY DEFINER routines pin search_path to public +
-- extensions (Supabase installs PostGIS in `extensions`).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Owner attestation as Tier 3 evidence (keep in sync with lib/provenance.ts)
-- -----------------------------------------------------------------------------
ALTER TABLE brands DROP CONSTRAINT IF EXISTS brands_ownership_source_type_check;
ALTER TABLE brands
  ADD CONSTRAINT brands_ownership_source_type_check CHECK (ownership_source_type IN (
    'sec_edgar', 'investor_press_release', 'pitchbook', 'crunchbase', 'mergr', 'reputable_news',
    'state_business_registry', 'local_press', 'community_consensus', 'owner_attestation',
    'nys_dos_corporations', 'eater_ny'
  ));

CREATE OR REPLACE FUNCTION public.source_type_fits_tier(p_corporate_tier INT, p_source_type TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
           WHEN p_corporate_tier IN (1, 2) THEN p_source_type = ANY (ARRAY[
             'sec_edgar', 'investor_press_release', 'pitchbook', 'crunchbase', 'mergr', 'reputable_news'])
           WHEN p_corporate_tier = 3 THEN p_source_type = ANY (ARRAY[
             'state_business_registry', 'local_press', 'community_consensus', 'owner_attestation',
             'nys_dos_corporations', 'eater_ny'])
           ELSE false
         END
         AND p_source_type IS NOT NULL;
$$;

-- -----------------------------------------------------------------------------
-- Registry suggestions for storefront candidates
-- -----------------------------------------------------------------------------
ALTER TABLE storefront_candidates ADD COLUMN IF NOT EXISTS registry_checked_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS registry_suggestions (
  candidate_id      UUID NOT NULL REFERENCES storefront_candidates (id) ON DELETE CASCADE,
  registry          TEXT NOT NULL CHECK (registry ~ '^[a-z0-9_]+$'),
  entity_id         TEXT NOT NULL CHECK (length(btrim(entity_id)) BETWEEN 1 AND 64),
  entity_name       TEXT NOT NULL CHECK (length(btrim(entity_name)) BETWEEN 1 AND 300),
  entity_type       TEXT,
  jurisdiction      TEXT,
  filed_on          DATE,
  entity_address    TEXT,
  match_reason      TEXT NOT NULL CHECK (match_reason IN ('name_at_address', 'business_at_address', 'name_elsewhere')),
  score             INT NOT NULL CHECK (score BETWEEN 0 AND 100),
  record_url        TEXT NOT NULL CHECK (record_url ~* '^https://[^\s/]+\.[^\s/]{2,}(/\S*)?$'),
  found_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (candidate_id, registry, entity_id)
);

CREATE INDEX IF NOT EXISTS registry_suggestions_score_idx ON registry_suggestions (candidate_id, score DESC);

ALTER TABLE registry_suggestions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON registry_suggestions FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON registry_suggestions FROM anon, authenticated';
    EXECUTE 'GRANT SELECT ON registry_suggestions TO authenticated';
  END IF;
END
$$;
DROP POLICY IF EXISTS registry_suggestions_select_admin ON registry_suggestions;
CREATE POLICY registry_suggestions_select_admin ON registry_suggestions
  FOR SELECT TO authenticated USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- Claim your business
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_claims (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id           UUID REFERENCES locations (id) ON DELETE SET NULL,
  brand_id              UUID REFERENCES brands (id) ON DELETE SET NULL,
  business_name         TEXT NOT NULL CHECK (length(btrim(business_name)) BETWEEN 1 AND 200),
  business_address      TEXT NOT NULL CHECK (length(btrim(business_address)) BETWEEN 1 AND 300),
  claimant_name         TEXT NOT NULL CHECK (length(btrim(claimant_name)) BETWEEN 1 AND 120),
  claimant_role         TEXT NOT NULL CHECK (claimant_role IN ('owner', 'co_owner', 'manager')),
  contact_email         TEXT NOT NULL CHECK (length(contact_email) <= 320 AND contact_email ~* '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$'),
  contact_phone         TEXT CHECK (contact_phone IS NULL OR length(contact_phone) <= 40),
  website_url           TEXT NOT NULL CHECK (website_url ~* '^https?://[^\s/]+\.[^\s/]{2,}(/\S*)?$'),
  attests_independent   BOOLEAN NOT NULL CHECK (attests_independent),
  details               TEXT CHECK (details IS NULL OR length(details) <= 2000),
  status                TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'verified', 'rejected')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at           TIMESTAMPTZ,
  resolved_by           UUID,
  resolution_note       TEXT CHECK (resolution_note IS NULL OR length(resolution_note) <= 500),
  CONSTRAINT business_claims_resolution_consistent CHECK ((status = 'open') = (resolved_at IS NULL))
);

CREATE INDEX IF NOT EXISTS business_claims_status_idx ON business_claims (status, created_at DESC);

ALTER TABLE business_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON business_claims FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON business_claims FROM anon, authenticated';
    EXECUTE 'GRANT INSERT ON business_claims TO anon, authenticated';
    EXECUTE 'GRANT SELECT ON business_claims TO authenticated';
  END IF;
END
$$;
DROP POLICY IF EXISTS business_claims_insert_public ON business_claims;
CREATE POLICY business_claims_insert_public ON business_claims
  FOR INSERT TO anon, authenticated
  WITH CHECK (status = 'open' AND resolved_at IS NULL AND resolved_by IS NULL AND resolution_note IS NULL);
DROP POLICY IF EXISTS business_claims_select_admin ON business_claims;
CREATE POLICY business_claims_select_admin ON business_claims
  FOR SELECT TO authenticated USING (public.is_admin());

ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS admin_audit_log_action_check;
ALTER TABLE admin_audit_log ADD CONSTRAINT admin_audit_log_action_check
  CHECK (action IN ('approve', 'reject', 'reverify', 'correct', 'resolve_correction', 'dismiss_correction',
                    'approve_storefront', 'reject_storefront', 'add_independent',
                    'add_corporate_brand', 'reopen_storefront',
                    'verify_claim', 'reject_claim'));

-- -----------------------------------------------------------------------------
-- resolve_business_claim: verify (optionally recording the owner's confirmation
-- as the listing's evidence) or reject (with a reason).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION resolve_business_claim(
  p_claim_id        UUID,
  p_outcome         TEXT,
  p_note            TEXT DEFAULT NULL,
  p_record_evidence BOOLEAN DEFAULT false
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor_id UUID := public.current_actor_id();
  v_claims   JSONB := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  v_note     TEXT := NULLIF(btrim(p_note), '');
  v_claim    business_claims%ROWTYPE;
  v_tier     INT;
  v_recorded BOOLEAN := false;
BEGIN
  IF NOT public.is_admin() OR v_actor_id IS NULL THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_outcome NOT IN ('verified', 'rejected') THEN
    RAISE EXCEPTION 'invalid_outcome';
  END IF;
  IF p_outcome = 'rejected' AND v_note IS NULL THEN
    RAISE EXCEPTION 'note_required';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RAISE EXCEPTION 'note_too_long';
  END IF;

  SELECT * INTO v_claim FROM business_claims WHERE id = p_claim_id AND status = 'open' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'claim_not_open';
  END IF;

  IF p_outcome = 'verified' AND p_record_evidence THEN
    SELECT corporate_tier INTO v_tier FROM brands WHERE id = v_claim.brand_id;
    -- Only an independent listing can carry the owner's word as its evidence.
    IF v_tier IS DISTINCT FROM 3 THEN
      RAISE EXCEPTION 'evidence_needs_independent_listing';
    END IF;
    UPDATE brands
       SET ownership_source_type = 'owner_attestation',
           ownership_source_url  = v_claim.website_url,
           ownership_verified_on = current_date
     WHERE id = v_claim.brand_id;
    v_recorded := true;
  END IF;

  UPDATE business_claims
     SET status = p_outcome, resolved_at = now(), resolved_by = v_actor_id, resolution_note = v_note
   WHERE id = p_claim_id;

  INSERT INTO admin_audit_log (actor_id, actor_email, action, brand_id, payload)
  VALUES (v_actor_id, left(v_claims ->> 'email', 320),
          CASE WHEN p_outcome = 'verified' THEN 'verify_claim' ELSE 'reject_claim' END,
          v_claim.brand_id,
          jsonb_build_object('business_claim_id', p_claim_id, 'note', v_note,
                             'recorded_as_evidence', v_recorded, 'evidence_url', CASE WHEN v_recorded THEN v_claim.website_url END));
END;
$$;

REVOKE ALL ON FUNCTION resolve_business_claim(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION resolve_business_claim(UUID, TEXT, TEXT, BOOLEAN) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION resolve_business_claim(UUID, TEXT, TEXT, BOOLEAN) TO authenticated';
  END IF;
END
$$;
