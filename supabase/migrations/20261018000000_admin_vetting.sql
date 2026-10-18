-- =============================================================================
-- Admin vetting: atomic approval routine + brand uniqueness
-- =============================================================================

-- One brand per (normalized name, vertical); makes approval idempotent under races.
CREATE UNIQUE INDEX brands_name_vertical_uniq_idx
  ON brands (lower(btrim(name)), industry_vertical);

-- Promotes a pending submission into the live brands/locations tables.
-- Runs as a single transaction: any failure rolls back everything, and the
-- row lock prevents two admins from approving the same submission twice.
CREATE FUNCTION approve_submission(
  p_submission_id              UUID,
  p_corporate_tier             INT,
  p_parent_entity              TEXT,
  p_industry_vertical          industry_vertical,
  p_unique_selling_proposition TEXT,
  p_latitude                   DOUBLE PRECISION,
  p_longitude                  DOUBLE PRECISION,
  p_city                       TEXT DEFAULT 'New York'
) RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_submission    submissions%ROWTYPE;
  v_brand_id      UUID;
  v_existing_tier INT;
  v_location_id   UUID;
BEGIN
  SELECT * INTO v_submission
    FROM submissions
   WHERE id = p_submission_id AND status = 'pending'
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission_not_pending';
  END IF;

  INSERT INTO brands (name, corporate_tier, industry_vertical, parent_entity, unique_selling_proposition)
  VALUES (btrim(v_submission.business_name), p_corporate_tier, p_industry_vertical,
          p_parent_entity, p_unique_selling_proposition)
  ON CONFLICT (lower(btrim(name)), industry_vertical) DO NOTHING
  RETURNING id INTO v_brand_id;

  -- Brand already live: reuse it, but never silently contradict its recorded tier.
  IF v_brand_id IS NULL THEN
    SELECT id, corporate_tier INTO v_brand_id, v_existing_tier
      FROM brands
     WHERE lower(btrim(name)) = lower(btrim(v_submission.business_name))
       AND industry_vertical = p_industry_vertical;

    IF v_existing_tier IS DISTINCT FROM p_corporate_tier THEN
      RAISE EXCEPTION 'brand_tier_conflict';
    END IF;
  END IF;

  INSERT INTO locations (brand_id, address, city, coordinates)
  VALUES (v_brand_id, btrim(v_submission.street_address), p_city,
          ST_SetSRID(ST_MakePoint(p_longitude, p_latitude), 4326))
  RETURNING id INTO v_location_id;

  UPDATE submissions
     SET status = 'approved', reviewed_at = now()
   WHERE id = p_submission_id;

  RETURN v_location_id;
END;
$$;

-- Never callable through Supabase's public RPC surface; only the server DB role.
REVOKE ALL ON FUNCTION approve_submission(UUID, INT, TEXT, industry_vertical, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION approve_submission(UUID, INT, TEXT, industry_vertical, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION approve_submission(UUID, INT, TEXT, industry_vertical, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT) FROM authenticated';
  END IF;
END
$$;
