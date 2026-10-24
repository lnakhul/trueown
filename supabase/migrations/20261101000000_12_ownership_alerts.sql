-- =============================================================================
-- Ownership-change alerts.
--
--   * ownership_alerts: news articles (GDELT) and SEC filings that name a tracked
--     brand next to a deal signal (an acquisition, an investment, a public
--     offering). Written by the trusted CLI (`npm run db:watch:ownership`),
--     admin-only read. An alert is a lead for a person to check, never a change
--     to a listing by itself.
--   * ownership_watch_state: when the watcher last checked each brand, so runs can
--     resume and only look for news since then (CLI-only, no API access).
--   * resolve_ownership_alert(): closes an alert as dismissed (with a reason) or
--     applied (the listing was corrected or re-verified with it), audited. Called
--     in the same transaction as correct_brand() / reverify_brand() when applied.
--
-- Safe to re-run. SECURITY DEFINER routines pin search_path to public +
-- extensions (Supabase installs PostGIS in `extensions`).
-- =============================================================================

CREATE TABLE IF NOT EXISTS ownership_watch_state (
  brand_id    UUID PRIMARY KEY REFERENCES brands (id) ON DELETE CASCADE,
  checked_at  TIMESTAMPTZ NOT NULL
);
ALTER TABLE ownership_watch_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ownership_watch_state FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON ownership_watch_state FROM anon, authenticated';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS ownership_alerts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id         UUID NOT NULL REFERENCES brands (id) ON DELETE CASCADE,
  source           TEXT NOT NULL CHECK (source IN ('gdelt_news', 'sec_edgar')),
  url              TEXT NOT NULL CHECK (url ~* '^https://[^\s/]+\.[^\s/]{2,}(/\S*)?$' AND length(url) <= 2000),
  title            TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 500),
  publisher        TEXT CHECK (publisher IS NULL OR length(publisher) <= 200),
  published_at     TIMESTAMPTZ,
  signal           TEXT NOT NULL CHECK (signal IN ('acquisition', 'investment', 'public_offering')),
  matched_terms    TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(matched_terms) <= 20),
  score            INT NOT NULL CHECK (score BETWEEN 0 AND 100),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'applied')),
  found_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMPTZ,
  resolved_by      UUID,
  resolution_note  TEXT CHECK (resolution_note IS NULL OR length(resolution_note) <= 500),
  CONSTRAINT ownership_alerts_resolution_consistent CHECK ((status = 'open') = (resolved_at IS NULL)),
  CONSTRAINT ownership_alerts_brand_url_uniq UNIQUE (brand_id, url)
);

CREATE INDEX IF NOT EXISTS ownership_alerts_open_idx ON ownership_alerts (status, score DESC, published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS ownership_alerts_brand_idx ON ownership_alerts (brand_id, status);
-- One alert per story per brand, even when outlets syndicate it under different URLs.
CREATE UNIQUE INDEX IF NOT EXISTS ownership_alerts_brand_title_uniq ON ownership_alerts (brand_id, lower(btrim(title)));

ALTER TABLE ownership_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ownership_alerts FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON ownership_alerts FROM anon, authenticated';
    EXECUTE 'GRANT SELECT ON ownership_alerts TO authenticated';
  END IF;
END
$$;
DROP POLICY IF EXISTS ownership_alerts_select_admin ON ownership_alerts;
CREATE POLICY ownership_alerts_select_admin ON ownership_alerts
  FOR SELECT TO authenticated USING (public.is_admin());

ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS admin_audit_log_action_check;
ALTER TABLE admin_audit_log ADD CONSTRAINT admin_audit_log_action_check
  CHECK (action IN ('approve', 'reject', 'reverify', 'correct', 'resolve_correction', 'dismiss_correction',
                    'approve_storefront', 'reject_storefront', 'add_independent',
                    'add_corporate_brand', 'reopen_storefront',
                    'verify_claim', 'reject_claim',
                    'dismiss_alert', 'apply_alert'));

-- -----------------------------------------------------------------------------
-- resolve_ownership_alert: dismiss (reason required) or mark applied.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION resolve_ownership_alert(
  p_alert_id UUID,
  p_outcome  TEXT,
  p_note     TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor_id UUID := public.current_actor_id();
  v_claims   JSONB := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  v_note     TEXT := NULLIF(btrim(p_note), '');
  v_alert    ownership_alerts%ROWTYPE;
BEGIN
  IF NOT public.is_admin() OR v_actor_id IS NULL THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_outcome NOT IN ('dismissed', 'applied') THEN
    RAISE EXCEPTION 'invalid_outcome';
  END IF;
  IF p_outcome = 'dismissed' AND v_note IS NULL THEN
    RAISE EXCEPTION 'note_required';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RAISE EXCEPTION 'note_too_long';
  END IF;

  SELECT * INTO v_alert FROM ownership_alerts WHERE id = p_alert_id AND status = 'open' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'alert_not_open';
  END IF;

  UPDATE ownership_alerts
     SET status = p_outcome, resolved_at = now(), resolved_by = v_actor_id, resolution_note = v_note
   WHERE id = p_alert_id;

  INSERT INTO admin_audit_log (actor_id, actor_email, action, brand_id, payload)
  VALUES (v_actor_id, left(v_claims ->> 'email', 320),
          CASE WHEN p_outcome = 'dismissed' THEN 'dismiss_alert' ELSE 'apply_alert' END,
          v_alert.brand_id,
          jsonb_build_object('ownership_alert_id', p_alert_id, 'note', v_note, 'source', v_alert.source,
                             'url', v_alert.url, 'title', v_alert.title));
  RETURN v_alert.brand_id;
END;
$$;

REVOKE ALL ON FUNCTION resolve_ownership_alert(UUID, TEXT, TEXT) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION resolve_ownership_alert(UUID, TEXT, TEXT) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION resolve_ownership_alert(UUID, TEXT, TEXT) TO authenticated';
  END IF;
END
$$;
