-- =============================================================================
-- Correction requests: "Report an error" from business owners, staff or anyone
-- who knows a listing is wrong. Separate from submissions (tips): an owner may
-- not have a public link, and may leave a contact email for follow-up.
--
--   * Anyone may INSERT an open request (fail-closed: status forced to 'open').
--   * Only admins can read requests (they can contain a contact email).
--   * Requests are closed only through resolve_correction_request(), which checks
--     is_admin() against the request's JWT claims and writes admin_audit_log.
--
-- Safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS correction_requests (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id              UUID REFERENCES brands (id) ON DELETE SET NULL,
  location_id           UUID REFERENCES locations (id) ON DELETE SET NULL,
  -- Kept so the request still makes sense if the listing is later removed.
  brand_name_snapshot   TEXT NOT NULL CHECK (length(btrim(brand_name_snapshot)) BETWEEN 1 AND 200),
  address_snapshot      TEXT CHECK (address_snapshot IS NULL OR length(address_snapshot) <= 300),
  issue                 TEXT NOT NULL CHECK (issue IN ('not_affiliated', 'tier_wrong', 'ownership_changed', 'closed', 'other')),
  details               TEXT NOT NULL CHECK (length(btrim(details)) BETWEEN 10 AND 2000),
  reporter_relationship TEXT NOT NULL CHECK (reporter_relationship IN ('owner', 'employee', 'customer', 'other')),
  contact_email         TEXT CHECK (contact_email IS NULL OR (length(contact_email) <= 320 AND contact_email ~* '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$')),
  evidence_url          TEXT CHECK (evidence_url IS NULL OR evidence_url ~* '^https?://[^\s/]+\.[^\s/]{2,}(/\S*)?$'),
  status                TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at           TIMESTAMPTZ,
  resolved_by           UUID,
  resolution_note       TEXT CHECK (resolution_note IS NULL OR length(resolution_note) <= 500),
  CONSTRAINT correction_requests_resolution_consistent CHECK (
    (status = 'open') = (resolved_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS correction_requests_status_idx ON correction_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS correction_requests_brand_idx ON correction_requests (brand_id) WHERE status = 'open';

ALTER TABLE correction_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON correction_requests FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON correction_requests FROM anon, authenticated';
    EXECUTE 'GRANT INSERT ON correction_requests TO anon, authenticated';
    EXECUTE 'GRANT SELECT ON correction_requests TO authenticated';
  END IF;
END
$$;

DROP POLICY IF EXISTS correction_requests_insert_public ON correction_requests;
CREATE POLICY correction_requests_insert_public ON correction_requests
  FOR INSERT TO anon, authenticated
  WITH CHECK (status = 'open' AND resolved_at IS NULL AND resolved_by IS NULL AND resolution_note IS NULL);

DROP POLICY IF EXISTS correction_requests_select_admin ON correction_requests;
CREATE POLICY correction_requests_select_admin ON correction_requests
  FOR SELECT TO authenticated USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- Audit log: correction outcomes
-- -----------------------------------------------------------------------------
ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS admin_audit_log_action_check;
ALTER TABLE admin_audit_log ADD CONSTRAINT admin_audit_log_action_check
  CHECK (action IN ('approve', 'reject', 'reverify', 'correct', 'resolve_correction', 'dismiss_correction'));

-- -----------------------------------------------------------------------------
-- resolve_correction_request: close a request as resolved or dismissed
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION resolve_correction_request(
  p_request_id UUID,
  p_outcome    TEXT,
  p_note       TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor_id UUID := public.current_actor_id();
  v_claims   JSONB := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  v_note     TEXT := NULLIF(btrim(p_note), '');
  v_request  correction_requests%ROWTYPE;
BEGIN
  IF NOT public.is_admin() OR v_actor_id IS NULL THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_outcome NOT IN ('resolved', 'dismissed') THEN
    RAISE EXCEPTION 'invalid_outcome';
  END IF;
  -- A dismissal must say why (the reporter may be the business owner).
  IF p_outcome = 'dismissed' AND v_note IS NULL THEN
    RAISE EXCEPTION 'note_required';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RAISE EXCEPTION 'note_too_long';
  END IF;

  SELECT * INTO v_request FROM correction_requests WHERE id = p_request_id AND status = 'open' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_not_open';
  END IF;

  UPDATE correction_requests
     SET status = p_outcome, resolved_at = now(), resolved_by = v_actor_id, resolution_note = v_note
   WHERE id = p_request_id;

  INSERT INTO admin_audit_log (actor_id, actor_email, action, brand_id, payload)
  VALUES (v_actor_id, left(v_claims ->> 'email', 320),
          CASE WHEN p_outcome = 'resolved' THEN 'resolve_correction' ELSE 'dismiss_correction' END,
          v_request.brand_id,
          jsonb_build_object('correction_request_id', p_request_id, 'issue', v_request.issue, 'note', v_note));
END;
$$;

REVOKE ALL ON FUNCTION resolve_correction_request(UUID, TEXT, TEXT) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION resolve_correction_request(UUID, TEXT, TEXT) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION resolve_correction_request(UUID, TEXT, TEXT) TO authenticated';
  END IF;
END
$$;
