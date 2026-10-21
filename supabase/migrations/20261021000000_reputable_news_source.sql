-- Adds 'reputable_news' as an accepted ownership-evidence type (e.g. a CNBC/Reuters report of a
-- funding round). Keep in sync with CORPORATE_SOURCE_TYPES in lib/import/venues.ts.
ALTER TABLE brands DROP CONSTRAINT brands_ownership_source_type_check;

ALTER TABLE brands
  ADD CONSTRAINT brands_ownership_source_type_check CHECK (ownership_source_type IN (
    'sec_edgar', 'investor_press_release', 'pitchbook', 'crunchbase', 'mergr', 'reputable_news',
    'nys_dos_corporations', 'eater_ny', 'community_consensus'
  ));
