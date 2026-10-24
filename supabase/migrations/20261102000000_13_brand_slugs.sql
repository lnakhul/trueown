-- =============================================================================
-- Public brand pages: a stable, readable address for every brand
-- (gettrueown.com/brands/blank-street-coffee).
--
--   * brand_slug_base(name): lowercase ASCII words joined by hyphens.
--   * brands.slug: unique; set from the name on insert and when the name changes.
--     Two brands with the same name (independents in different cities) get a short
--     id suffix: "corner-bakery-3f9a1c".
--
-- Safe to re-run.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.brand_slug_base(p_name TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(NULLIF(
    left(trim(BOTH '-' FROM regexp_replace(
      lower(translate(replace(replace(p_name, '&', ' and '), '''', ''),
        'ÀÁÂÃÄÅàáâãäåÇçÈÉÊËèéêëÌÍÎÏìíîïÑñÒÓÔÕÖØòóôõöøÙÚÛÜùúûüÝýÿ’',
        'AAAAAAaaaaaaCcEEEEeeeeIIIIiiiiNnOOOOOOooooooUUUUuuuuYyy')),
      '[^a-z0-9]+', '-', 'g')), 80),
    ''), 'brand');
$$;

ALTER TABLE brands ADD COLUMN IF NOT EXISTS slug TEXT;

CREATE OR REPLACE FUNCTION public.assign_brand_slug()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_base TEXT := public.brand_slug_base(NEW.name);
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.name IS NOT DISTINCT FROM OLD.name AND NEW.slug IS NOT NULL THEN
    RETURN NEW;
  END IF;
  NEW.slug := v_base;
  IF EXISTS (SELECT 1 FROM brands WHERE slug = v_base AND id <> NEW.id) THEN
    NEW.slug := left(v_base, 73) || '-' || left(replace(NEW.id::text, '-', ''), 6);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS brands_assign_slug ON brands;
CREATE TRIGGER brands_assign_slug
  BEFORE INSERT OR UPDATE OF name, slug ON brands
  FOR EACH ROW EXECUTE FUNCTION public.assign_brand_slug();

-- Backfill: the oldest brand with a name keeps the plain slug.
DO $$
DECLARE
  v_brand RECORD;
BEGIN
  FOR v_brand IN SELECT id FROM brands WHERE slug IS NULL ORDER BY created_at, id LOOP
    UPDATE brands SET slug = NULL WHERE id = v_brand.id;
  END LOOP;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS brands_slug_uniq ON brands (slug);
ALTER TABLE brands ALTER COLUMN slug SET NOT NULL;
