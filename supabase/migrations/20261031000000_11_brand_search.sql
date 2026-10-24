-- =============================================================================
-- Brand and owner search.
--
-- pg_trgm lets the public search match brand and owner names with small typos
-- ("blank stret" -> "Blank Street Coffee"). The app checks for strict_word_similarity()
-- at run time and falls back to exact fragments without it, so deploying the
-- code before this migration is safe.
--
-- On Supabase, extensions live in the `extensions` schema (already on the
-- search_path); elsewhere the default schema is used. Safe to re-run.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions';
  ELSE
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_trgm';
  END IF;
END
$$;
