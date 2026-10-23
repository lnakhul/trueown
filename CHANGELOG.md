# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Multi-market data pipeline (migration `20261024000000_04_market_scoped_data.sql`): `markets.slug` and canonical `markets.city_label`; `locations.city` and `neighborhood_boundaries.city` are now set from the market by the database, so labels can no longer drift.
- `brands.home_market_id`: Tier 3 independents are scoped to their market (same-named independents in different cities stay separate brands); Tier 1/2 brands stay national. The database refuses an independent storefront outside its home market.
- Generic provenance source types `state_business_registry` and `local_press` (NYC-only `nys_dos_corporations` and `eater_ny` still accepted).
- `data/markets/<slug>/market.json` configs for NYC (active), Austin and Chicago (coming soon, with their official open-data boundary sources and empty `venues.csv` files); `npm run db:import:markets` upserts them without silently changing a live market's status.
- `npm run db:import:boundaries -- --market <slug> [--download | --file]` loads any configured market's polygons through one generic, property-mapped importer.
- Venue CSVs accept an optional `market` column that is cross-checked against the coordinates; brand CSVs accept an optional trailing `market` column for Tier 3 rows.
- Tests for multi-market imports, market configs, boundary property mapping and source-type/constraint sync.
- Text search accepts full street addresses: neighborhood names resolve to NTA centroids first, anything else falls back to a Nominatim geocoder (1 req/s, 4s timeout) cached in Upstash Redis for 30 days (in-memory fallback). Results outside every active market return `outside_active_market`; provider failures return a 503 JSON error.
- `lib/telemetry.ts` non-blocking proximity-search events (`market_id`, `industry_vertical`, `search_type`; no coordinates or text), registered via `instrumentation.ts` with a Sentry metrics sink. Failures are swallowed and never delay responses. On serverless hosts delivery is best-effort because it is not awaited.
- Tests G (geocoding/centroid router) and H (telemetry isolation).
- `markets` table (migration `20261023000000_03_regional_markets.sql`) seeded with New York City (active), Austin and Chicago (coming soon); `locations.market_id` is assigned automatically from coordinates within 50 miles.
- `outside_active_market` API response naming the closest active market, with a matching notice in the UI.
- Venue importer validates each storefront against the markets table and warns when a market is not active.
- Tests for cross-market isolation (Austin/Chicago vs NYC) and category disambiguation (`bar_nightlife` vs coffee). error tracking with PII scrubbing (disabled without a DSN).
- City and business-type selectors; `GET /api/catalog`; `vertical` and `city` query parameters on the proximity and neighborhood APIs.
- `brands.financial_backers` column (migration `20261022000000`), importer support and a "Backed by" line in the alert banner.
- Accessibility pass: skip link, focus-visible styles, reduced-motion support, dialog focus trap, combobox neighborhood search, contrast and touch-target fixes.

### Changed
- The venue CSV `city` column is optional and legacy: if filled it must equal the market's city label. Seed data now uses `New York` (was `New York City`), so `/api/catalog` lists `New York`.
- `approve_submission` derives the city from the market; its `p_city` argument is ignored.
- **Breaking (API):** `vertical` is now required for `scope=nearest` and `neighborhood=` lookups (400 without it); the UI no longer offers "All types".
- Coordinate lookups resolve the nearest active market first and are isolated to it.
- Neighborhood search no longer defaults to `coffee_bakery`; it spans all verticals unless one is selected.
- Neighborhood label points use `ST_PointOnSurface` when the centroid falls outside the polygon.
- Geolocation cache key bumped to `v2`.

## [0.1.0] - 2026-10-21

### Added
- Ownership taxonomy (Tier 1 PE, Tier 2 VC/growth, Tier 3 independent) on a PostGIS-backed Supabase schema.
- Proximity API (`ST_DWithin` / `ST_Distance`, 1,500 m, nearest first) with neighborhood text fallback and lookahead.
- Discovery dashboard: browser geolocation with a 15-minute cache, neighborhood search, Leaflet map and independent-alternatives slider.
- Crowdsourced tip form with required evidence URL, Cloudflare Turnstile, honeypot and rate limiting (optional shared Upstash Redis store).
- Admin vetting queue with Supabase Auth; approve promotes a tip into live brands/locations transactionally.
- Row-level security policies on all tables.
- NYC NTA 2020 neighborhood boundary polygons and CSV importers for boundaries, brands and venues with ownership provenance.
- `GET /api/health` uptime endpoint, Docker development setup, CI workflow and Vercel configuration.
- Jest geospatial, RLS, importer and rate-limit test suites.
