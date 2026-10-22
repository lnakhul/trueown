# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Optional Sentry error tracking with PII scrubbing (disabled without a DSN).
- City and business-type selectors; `GET /api/catalog`; `vertical` and `city` query parameters on the proximity and neighborhood APIs.
- `brands.financial_backers` column (migration `20261022000000`), importer support and a "Backed by" line in the alert banner.
- Accessibility pass: skip link, focus-visible styles, reduced-motion support, dialog focus trap, combobox neighborhood search, contrast and touch-target fixes.

### Changed
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
