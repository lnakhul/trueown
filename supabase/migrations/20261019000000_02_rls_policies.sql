-- =============================================================================
-- Row Level Security policies for public staging
--
-- NOTE: named with a timestamp prefix so it sorts AFTER the migrations that
-- create the tables (Supabase applies migrations in filename order).
--
--   brands, locations : public SELECT; INSERT/UPDATE/DELETE admin only
--   submissions       : anonymous INSERT (pending only); SELECT/UPDATE admin only
--
-- "Admin" = an authenticated JWT whose app_metadata.role is 'admin'.
-- app_metadata can only be written server-side (service role / dashboard), so
-- users cannot grant it to themselves (unlike user_metadata).
-- The service_role key and the table owner bypass RLS by design; keep them
-- server-side only.
-- =============================================================================

-- Supabase already provides these roles; creating them on plain Postgres
-- (local Docker) lets the same policies be exercised in tests.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO anon, authenticated;

-- -----------------------------------------------------------------------------
-- Admin check. Reads the JWT claims that PostgREST/Supabase expose per request;
-- evaluates to false on plain Postgres or when no JWT is present (fail closed).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' ->> 'role') = 'admin',
    false
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated;

-- -----------------------------------------------------------------------------
-- Table privileges (defense in depth under the policies below).
-- Reset first: Supabase default privileges grant broad access to anon/authenticated.
-- -----------------------------------------------------------------------------
ALTER TABLE public.brands      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.locations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submissions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.brands, public.locations, public.submissions FROM anon, authenticated;

GRANT SELECT ON public.brands, public.locations TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.brands, public.locations TO authenticated;

-- Anonymous visitors may only create tips; reading/vetting needs an authenticated admin.
GRANT INSERT ON public.submissions TO anon, authenticated;
GRANT SELECT, UPDATE ON public.submissions TO authenticated;

-- -----------------------------------------------------------------------------
-- Remove the placeholder policies from the initial schema migration.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS brands_public_read ON public.brands;
DROP POLICY IF EXISTS locations_public_read ON public.locations;
DROP POLICY IF EXISTS submissions_public_read_approved ON public.submissions;

-- -----------------------------------------------------------------------------
-- brands
-- -----------------------------------------------------------------------------
CREATE POLICY brands_select_public ON public.brands
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY brands_insert_admin ON public.brands
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY brands_update_admin ON public.brands
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY brands_delete_admin ON public.brands
  FOR DELETE TO authenticated USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- locations
-- -----------------------------------------------------------------------------
CREATE POLICY locations_select_public ON public.locations
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY locations_insert_admin ON public.locations
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY locations_update_admin ON public.locations
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY locations_delete_admin ON public.locations
  FOR DELETE TO authenticated USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- submissions
-- Fail-closed: public inserts can only ever create untouched 'pending' rows.
-- The evidence_url CHECK constraint on the table still applies to every insert.
-- -----------------------------------------------------------------------------
CREATE POLICY submissions_insert_public ON public.submissions
  FOR INSERT TO anon, authenticated
  WITH CHECK (status = 'pending' AND reviewed_at IS NULL);

CREATE POLICY submissions_select_admin ON public.submissions
  FOR SELECT TO authenticated USING (public.is_admin());

CREATE POLICY submissions_update_admin ON public.submissions
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
