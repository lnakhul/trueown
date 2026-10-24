# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **The public website.** TrueOwn is now a complete site around the map:
  - **Brand pages** (`/brands/<name>`): the ownership answer in one sentence, the owner and named investors (each linking to their own page), the evidence and when it was checked, every location on a map, and, for corporate-backed brands, independent alternatives within a short walk. Each page has a Share button, plus "Report an error" and (for independents) "Claim it".
  - **Owner pages** (`/owners/<name>`) and an **Owners & backers** index: every brand a firm owns or funds.
  - A **Brands directory** (`/brands`): A–Z, filterable by private equity, venture capital or independent, and searchable by brand or owner.
  - **About, Privacy Policy and Terms of Use** pages. The policy describes what the app actually collects. *These are drafts: have them reviewed before launch.*
  - A **site header and footer** on every page. On the map, the logo opens the site menu.
  - **Link previews:** a card with the brand's name and ownership tag appears when a page is shared. Plus a **sitemap** and **robots.txt** for search engines, per-page titles, descriptions and canonical links, and a friendly 404 page.
- The map links to the new pages: the details sheet has "Full ownership profile", and independent alternatives, brand views and owner views link to their pages.
- Brand pages link to the map (`/?brand=<id>`, `/?owner=<name>`). The map opens that brand or owner, then sorts it by distance once the visitor shares their location.
- Migration `20261102000000_13_brand_slugs.sql`: every brand gets a unique, readable web address (`brands.slug`), kept up to date when the name changes. A duplicate name gets a short suffix.
- **Ownership-change alerts.**
  - `npm run db:watch:ownership` checks every brand on the map against:
    - worldwide news, via the GDELT open news index;
    - SEC EDGAR filings: a brand's own Form D fundraise, merger and tender-offer documents, IPO registrations.
  - It keeps only items that name the brand next to an acquisition, investment or public-offering signal. Each is rated Strong, Likely or Possible:
    - An independent being bought or funded rates highest.
    - New funding for a brand already listed as VC-funded rates lower.
    - So does a headline that names the listed owner.
  - News often drops a generic last word ("Blank Street" for Blank Street Coffee), and that still matches.
  - Nothing on a listing changes automatically.
- Admin **Alerts** page (`/admin/alerts`): possible changes grouped by brand, next to the current listing and its evidence. For each alert:
  - **Update listing** opens the correction form already filled in: an independent that was bought becomes Tier 1, one that took investment becomes Tier 2, and the article becomes the evidence. Saving updates the listing and closes the alert in one audited step.
  - **Use as fresh evidence** keeps the claim and makes the article its current source.
  - **Dismiss** records a reason. A dismissed story never comes back, even when other outlets republish it under a new link.
- Weekly **Ownership watch** GitHub Action (Mondays). It needs the `WATCH_DATABASE_URL` and `OWNERSHIP_WATCH_CONTACT` secrets and does nothing without them. Runs resume where they stopped, and later runs only look at what's new.
- Migration `20261101000000_12_ownership_alerts.sql`:
  - `ownership_alerts` (admin-only read);
  - `ownership_watch_state` (CLI only);
  - the audited, admin-only `resolve_ownership_alert()`.

### Changed
- In a brand or owner view on the map, "Sort by distance" now re-sorts that view instead of switching to everything near you.
- The Brands page's re-verify and correction forms are now shared with the Alerts page (`components/AdminBrandForms.tsx`). They behave the same as before.
- **Search-first home screen:** the long list of neighborhood chips is gone. The page now opens on a pinned search bar with a "use my location" button, and a full-width map below it. The map shows you (a blue dot), every corporate-backed spot nearby (amber) and every independent (green). Tapping a spot on the map or in the list opens its details. The app still asks for location on load. If location is off, the map rests on New York with a short note, "Try again", and a prompt to search.
- Search panel: "Use my current location", your last five searches (kept only in your browser, and clearable), and six popular neighborhoods. While typing, it shows matching neighborhoods plus a free-text search for any address.
- Business type and city filters are now compact pills under the search.
- Desktop: search, filters and results sit in a left column beside a tall map. Picking a spot zooms the map to it, and "Show all on map" returns to the overview.
- `GET /api/neighborhoods?popular=<1-12>` returns the neighborhoods with the most tracked storefronts.
- **Brand and owner search:** typing in the search bar now also finds published brands and the companies behind them.
  - Each brand row shows its ownership tag ("Venture capital funded", "Independent"…), its location count and the nearest distance.
  - An owner or backer (a parent company or a named investor) lists the brands it owns or funds.
  - Opening a brand shows its locations nearest you, each with its independent alternatives; an independent brand shows its own locations.
  - Opening an owner shows every location of every brand it stands behind.
  - Small typos still match ("blank stret").
  - Only brands with a location in an active market appear, so unapproved storefronts never show.
- Recent searches remember brands and owners as brands and owners. Older saved entries still read as places.
- Distances over a kilometre read as "1.2 km".
- `GET /api/proximity?suggest=` also returns `brands` and `owners`, and takes optional `lat`/`lng` to sort brands by distance. New `?brand=<id>` and `?owner=<name>` views (optional `lat`/`lng`, at most 10 locations).
- Migration `20261031000000_11_brand_search.sql` installs `pg_trgm` for typo matching. Search still works without it, matching exact fragments only.

### Fixed
- On phones the map drew over the report form: Leaflet's layers are now contained in the map (`isolation: isolate`), so they can never cover dialogs or the bottom sheet.
- The map showed "API KEY REQUIRED" tiles: CARTO's basemaps now require a key. The default is now keyless OpenStreetMap tiles darkened with a CSS filter (markers keep their colors), and any provider can be configured with `NEXT_PUBLIC_MAP_TILE_*`.
- Migration `20261025000000_05_admin_audit.sql` failed on Supabase with `type "geometry" does not exist`: the SECURITY DEFINER vetting routines pinned `search_path` to `public` while Supabase installs PostGIS in `extensions`. They now pin `public, extensions, pg_temp`, and the migration is safe to re-run. CI also applies every migration to a Supabase-layout database.

### Added
- **Registry leads for possible independents:** `npm run db:match:registry` looks each shop up in New York State's business registry (Department of State, Active Corporations, data.ny.gov) by address and by name, and keeps the top three possible legal owners. Rated *strong* (same name at the address), *likely* (a food business at the address) or *name only*; out-of-state registrations are flagged. In a 400-shop test, 22% had a strong lead and nearly half had a useful one. The Storefronts queue shows each shop's best lead with a link to the state record, a **one-click "Add as independent with this record"**, and a "Strongest registry matches first" sort. Resumable: shops checked in the last 30 days are skipped.
- **Claim your business** (`/claim`, linked from every independent's card and the How we classify page): owners give their role, a business email and website, and confirm the business has no private equity, venture capital or corporate parent. Same spam protection as the other public forms. Claims on corporate-backed listings are pointed to Report an error.
- Admin **Owner claims** tab: verify (optionally recording the owner's confirmation, linked to their website, as the listing's evidence) or reject with a reason.
- New Tier 3 evidence type **Owner confirmation** (`owner_attestation`).
- Migration `20261030000000_10_independent_verification.sql`: `registry_suggestions` (admin-only read), `business_claims` (public insert of open claims only, admin-only read), the audited, admin-only `resolve_business_claim()`, and the new evidence type.

- Storefronts queue: **Add as PE/VC-backed brand** on each Possible independents group creates a Tier 1/2 brand with its owner, named backers and ownership evidence in one audited step; all of its same-named shops move to Chain matches for "Approve all". Re-running the import then also catches spelling variants and shops filed under other categories.
- Storefronts queue: rejections are undoable. A new **Rejected** tab groups rejected shops by name and reason, and **Reopen** returns them to the queue, re-matched against current brands.
- Migration `20261029000000_09_storefront_brand_actions.sql`: audited, admin-only `add_corporate_brand_from_candidates()` and `reopen_storefront_candidates()`.

- **Storefront coverage from NYC Open Data:** `npm run db:import:storefronts` pulls every NYC coffee, bakery, donut and bagel establishment, plus every establishment named like a tracked brand in any category, from the city's restaurant inspection data (about 4,000 shops) into an admin review queue. Nothing is published by the import. Re-running refreshes the data and keeps every review decision; shops already on the map are detected by distance.
- Brand matching: an exact match only when the name is the brand or starts with it as whole words ("DUNKIN' / BASKIN ROBBINS" yes, "PETITE MAMAN" no); typos and glued names ("MAGNOLIA BAGERY", "DUNKIN99") become possible matches for a person to confirm.
- Admin **Storefronts** page (`/admin/storefronts`): chain matches grouped by brand with "Approve all", possible matches to confirm one by one, and possible independents grouped by name with the biggest groups (usually untracked chains) first. Publishing a new independent requires Tier 3 evidence; its other same-named shops then join it as chain matches. Rejections need a reason.
- Migration `20261028000000_08_storefront_candidates.sql`: `storefront_candidates` (admin-only read, no API writes) and the audited, admin-only `approve_storefront_candidates()`, `add_independent_from_candidate()` and `reject_storefront_candidates()`.

- Address-only imports: `npm run db:geocode:venues -- <file.csv>` fills blank coordinates from street addresses and writes a `.geocoded.csv` to review plus a per-row report. Only exact house-number matches inside the row's market are filled; street-level or out-of-market matches are left blank and flagged. Follows the Nominatim policy (1 request/second, identifying User-Agent) with a local cache. The importer now explains how to fill blank coordinates.
- Public **How we classify** page (`/how-we-classify`): tier definitions, accepted evidence per tier, how claims are added and kept current, and how to report an error. Linked from every corporate card and the page footer.
- **Report an error** on every corporate card: owners, staff or visitors pick what is wrong and how they know the business, describe it, and can add an evidence link and a contact email (admins only). Protected like tips (honeypot, Turnstile, 5 per hour per client).
- Admin **Error reports** inbox (`/admin/corrections`): open reports oldest first, with a link to the brand; close as resolved or dismissed (a dismissal needs a reason). Brands with open reports are listed first on the Brands page.
- Migration `20261027000000_07_correction_requests.sql`: `correction_requests` (public insert of open reports only, admin-only read) and the audited, admin-only `resolve_correction_request()`.

- Public ownership sources: every corporate card shows the evidence type, a link to it and the month it was verified; claims checked over a year ago say ownership may have changed, and unsourced claims say "Not yet recorded".
- Admin **Brands** page (`/admin/brands`): lists claims with no source or a source older than 12 months first, with search and an "All brands" view. **Re-verify** records fresh evidence for the same claim; **Correct claim** changes tier, parent or backers and requires new evidence and a reason.
- Migration `20261026000000_06_brand_reverification.sql`: audited, admin-only `reverify_brand()` / `correct_brand()` (before/after kept in `admin_audit_log`, which now has a `brand_id` column). Direct `INSERT/UPDATE/DELETE` on `brands` and `locations` is revoked for every API role, admins included: public claims change only through audited routines or the import CLIs.
- Admin console hardening (migration `20261025000000_05_admin_audit.sql`): `approve_submission` / `reject_submission` check `is_admin()` against the request's JWT claims, record `reviewed_by` (and an optional `review_note`), and append to the new admin-only `admin_audit_log` in the same transaction. Direct `UPDATE` on `submissions` is revoked for every API role.
- Approval now requires an `ownership_source_type` that fits the tier; the submission's evidence URL and today's date become the brand's provenance.
- `lib/auth/admin-session.ts`: every admin route handler and the admin page re-verify the Supabase user (`getUser`) instead of relying on middleware alone; admin database work runs as `authenticated` with the verified claims (`lib/db/as-admin.ts`).
- Vetting console: source-type selector, rejection notes and a "Recently reviewed" tab showing who decided and on what source.
- `npm run admin:grant -- --email <address> --yes` sets or revokes `app_metadata.role = 'admin'` via the service-role key (CLI only).
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
- HTTP Basic admin auth works only outside production; a production build without Supabase Auth returns 503 for `/admin`.
- **Breaking (API):** `POST /api/admin/submissions/:id/approve` requires `ownership_source_type` and no longer accepts `city`; `.../reject` accepts an optional `review_note`.
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
