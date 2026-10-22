-- =============================================================================
-- brands.financial_backers: named investors behind a Tier 1/2 brand.
-- Existing table grants (and RLS policies) already cover new columns, so no
-- GRANT changes are needed. Tier 3 brands keep an empty array.
-- =============================================================================

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS financial_backers TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE brands
  DROP CONSTRAINT IF EXISTS brands_financial_backers_bounds;
ALTER TABLE brands
  ADD CONSTRAINT brands_financial_backers_bounds CHECK (
    cardinality(financial_backers) <= 20
    AND array_position(financial_backers, NULL) IS NULL
  );
