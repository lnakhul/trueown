# TrueOwn

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

**See who really owns your coffee shop, and find independent alternatives nearby.**

TrueOwn maps private-equity and venture-backed coffee shops and bakeries in New York City. For each one it shows the ownership tier and points you to verified, independently owned shops within a five-minute walk (1,500 m).

| Tier | Meaning | Example |
|---|---|---|
| 1 | Majority private-equity buyout or institutional control | Magnolia Bakery |
| 2 | Venture or growth-equity financed | Blank Street Coffee, Maman |
| 3 | True independent: local roaster or family-owned | Coffee Project NY |

The schema is built to extend beyond coffee into restaurants, bars and retail, and beyond NYC into new cities.

## Features

- Proximity search with PostGIS `ST_DWithin` / `ST_Distance`, sorted nearest first
- Browser geolocation (cached 15 minutes) with a neighborhood or street-address search fallback (Nominatim geocoding, cached 30 days in Upstash Redis)
- Official NYC Neighborhood Tabulation Area (NTA 2020) polygons; centroids computed with `ST_Centroid`
- Crowdsourced tip form with required evidence URL, Cloudflare Turnstile, honeypot and rate limiting
- Admin vetting queue (Supabase Auth) to approve or reject tips
- Admin brand review to re-verify stale claims and correct ownership changes, all audited
- Public "How we classify" page and a "Report an error" flow for business owners, with an admin inbox
- Storefront review queue fed by NYC Open Data: approve a chain's locations in one click, publish independents with evidence (NY State registry leads)
- "Claim your business" for independent owners, with an admin inbox
- Weekly ownership-change watch: news (GDELT) and SEC filings that name a tracked brand next to an acquisition, investment or IPO go to an admin Alerts queue; one click updates the listing with the article as evidence
- Row-level security on every table; provenance fields on brand ownership claims
- Bulk CSV importers for brands, venues and neighborhood boundaries

## Tech stack

Next.js 14 (App Router) · TypeScript · Tailwind CSS · Supabase (PostgreSQL + PostGIS) · Leaflet · Jest · Docker

## Quick start (Docker)

Requires Docker with Compose.

```bash
git clone https://github.com/lnakhul/trueown.git trueown && cd trueown
cp .env.example .env.local        # fill in values; see Configuration
docker compose up --build         # web on :3000, PostGIS on :5432
```

The first start creates the schema and seed data from `supabase/`. Then load boundaries and brands (run against the local database):

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/trueown
npm install
npm run db:import:boundaries
npm run db:import:brands -- your_brands.csv   # start from data/templates/brands_template.csv
```

Open http://localhost:3000. To reset the local database: `docker compose down -v`.

## Configuration

Copy [.env.example](.env.example) to `.env.local`. Never commit real values.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Server-only Postgres connection string (for hosted Supabase use the session pooler) |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public Supabase values, protected by RLS |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile; the secret is server-only |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Optional shared rate limiting; unset = per-instance in-memory |
| `ADMIN_PASSWORD` | HTTP Basic fallback for `/admin` when Supabase is not configured (local development only; ignored in production) |

Never put the Supabase service-role key in client code.

## Database

Migrations live in `supabase/migrations/` and run in filename order; `supabase/seed.sql` holds sample data. On hosted Supabase, paste each file's **contents** into the SQL Editor, in order. Create an admin user in Supabase Auth, then grant the role with `npm run admin:grant -- --email you@example.com --yes` (needs `SUPABASE_SERVICE_ROLE_KEY` in your local shell only). Every approval or rejection is checked against that user's JWT inside the database and written to `admin_audit_log`.

**Markets.** The `markets` table lists the cities TrueOwn serves (`active` or `coming_soon`, each with a geographic center). Every location is assigned to the market whose center is within 50 miles, and inserts outside every market are rejected, so add a market before importing a new city. `GET /api/proximity` resolves the nearest active market first; outside 50 miles of every active one it returns `{ "status": "outside_active_market", "closest_active_market": { ... } }`. Searches that start from a location (`scope=nearest`, `neighborhood=`) require `vertical=<industry_vertical>` and are isolated to that vertical and market.

## Importing data

All importers support `--dry-run` (validate and roll back) and require `--yes` for non-local databases. They are all-or-nothing.

```bash
npm run db:import:markets                          # markets from data/markets/*/market.json
npm run db:import:boundaries                       # NYC NTA 2020 polygons (--market <slug> --download for other cities)
npm run db:import:brands -- <brands.csv>           # brand-level rows
npm run db:import:storefronts                      # NYC coffee/bakery shops from NYC Open Data -> admin review queue
npm run db:match:registry                          # NY State registry leads for possible independents
npm run db:watch:ownership                         # news + SEC filings -> admin Alerts (needs OWNERSHIP_WATCH_CONTACT)
npm run db:geocode:venues -- <venues.csv>          # fill blank coordinates from addresses (review the output)
npm run db:import:venues -- <venues.csv>           # brands + storefronts with provenance
```

The venue template and field guide are in [data/templates/](data/templates). Each brand needs an ownership source type, public URL and verification date.

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for the Vercel + Supabase checklist. `GET /api/health` is the uptime-monitor endpoint.

## Testing

```bash
docker compose up -d db
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/trueown npm test
npm run typecheck
```

CI runs the same checks (see [.github/workflows/ci.yml](.github/workflows/ci.yml)).

## Project structure

```
app/            Routes, API handlers (proximity, submissions, admin), admin UI
components/     Discovery dashboard, submission panel, Turnstile widget
lib/            DB helpers, Supabase clients, rate limiting, importers
scripts/        Import CLIs
supabase/       Migrations and seed data
data/           NTA boundaries and CSV templates
__tests__/      Geospatial, RLS and importer tests
```

## Security

Security headers, RLS, server-side Turnstile verification, rate limiting and parameterized SQL are on by default. See [SECURITY.md](SECURITY.md) to report vulnerabilities privately.

## Data sources and accuracy

Ownership claims are hand-curated and cited: Tier 1/2 from SEC EDGAR, investor press releases and business-intelligence platforms; Tier 3 from NYS Division of Corporations, Eater NY and community consensus. Ownership changes: a weekly watch of news (GDELT) and SEC EDGAR filings flags possible changes for review, and if something is wrong you can submit a tip with evidence. Neighborhood boundaries come from NYC Open Data (Department of City Planning, NTA 2020).

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) first. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Release history is in [CHANGELOG.md](CHANGELOG.md).

## License

Copyright (C) 2026 TrueOwn Development Group.

Licensed under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a network service, you must offer its source code to that service's users.
