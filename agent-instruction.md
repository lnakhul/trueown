# The Independent Alternatives - AI Coding Agent Engineering Instructions

## Project Purpose
This project is a scalable, database-driven web application and registry that tracks corporate, private equity (PE), and Venture Capital (VC) backed consumer brands, businesses, and hospitality groups, actively redirecting consumers to nearby, verified independent family-owned alternatives. 

The initial launch scope focuses exclusively on **coffee shops and bakeries in New York City**, but the architecture, database schema, and domain modeling must be inherently scalable to support other cities (e.g., Chicago, Austin) and other industry verticals (e.g., restaurants, bars, retail boutiques, fitness studios).

## Core Principles
* **Consumer Transparency:** Provide clear, data-backed visibility into who actually owns and finances high-frequency neighborhood businesses.
* **Frictionless Alternatives:** Rather than just blacklisting corporate brands, the core user experience must always offer high-quality independent alternatives within a short walking radius.
* **Data Integrity:** To eliminate legal risks, no crowdsourced corporate transition can go live instantly without a verified public source link (SEC filing, press release, or business news coverage) and admin approval.

## Engineering Philosophy
Write and architect this project as if it were developed, optimized, and reviewed by principal full-stack engineers.

Prioritize:
1. Data Integrity and Verification Boundaries
2. Scalable Geolocation Query Performance
3. Clean Type Safety and Domain Modeling
4. Mobile-First Responsive User Experience
5. Explicit Fail-Closed Workflows
6. Maintainability and Modularity

Avoid premature feature optimization. Do not introduce microservices, messaging queues, or complex global state management libraries unless explicitly requested in a later phase.

## Tech Stack & Specifications
* **Framework:** Next.js 14/15 (App Router, TypeScript).
* **Database & Auth:** Supabase (PostgreSQL with PostGIS extension).
* **Styling:** Tailwind CSS.
* **Mapping:** Leaflet / OpenStreetMap (React-Leaflet) or Mapbox GL JS for cross-platform geospatial positioning.
* **Containerization:** Docker & Docker Compose (Containerized Next.js app and local PostGIS DB instance).

## Naming Conventions
Use descriptive, domain-specific names. Avoid vague identifiers like `data`, `obj`, `item`, `res`, `req`, `ctx`, `mgr`, or `tmp`.

Prefer names such as:
* `corporate_tier`
* `industry_vertical`
* `location_coordinates`
* `alternative_recommendation`
* `crowdsourced_submission`
* `verification_source_url`
* `proximity_search_handler`

Prefer:
    `fetch_nearby_independent_alternatives()`
over:
    `get_data()`

## Domain Terminology & Ownership Taxonomy
Maintain absolute consistency across database columns, API variables, and frontend props:
* **Tier 1 (Majority PE Buyout):** Majority-owned or controlled by a private equity fund (e.g., Magnolia Bakery).
* **Tier 2 (VC / Growth Equity):** Funded by institutional venture capital or growth equity to scale aggressively (e.g., Blank Street Coffee).
* **Tier 3 (True Independent):** Fully owned and operated by local individuals or family structures with no institutional backing.

Unified Schema Entities:
* `Brand` (The corporate identity and its corresponding Tier classification)
* `Location` (The physical storefront branch mapping to specific geospatial coordinates)
* `Submission` (The incoming crowdsourced corporate transition tip awaiting admin vetting)

## Database Structure & Scalability Rules
The database must be built for multi-city, multi-industry scalability from day one. Do not hardcode "NYC" or "Coffee" strings into the schema primitives. 

Implement an enum structure for verticals:
```sql
CREATE TYPE industry_vertical AS ENUM ('coffee_bakery', 'restaurant', 'bar_nightlife', 'retail_boutique', 'fitness_wellness');
```

Enforce spatial indexing on coordinates using PostGIS geometry mapping (`GEOMETRY(Point, 4326)`).

## The Proximity Recommendation Logic
The core algorithm must compute distances using native database-level spatial operations (`ST_DWithin` and `ST_Distance`). 
* When a user views a Tier 1 or Tier 2 brand location, the engine must extract its coordinate points.
* Query the database for Tier 3 locations belonging to the same `industry_vertical` situated within a 1500-meter radius, sorted strictly from closest to furthest.

## Crowdsourced Vetting & Security Boundaries
* **Fail-Closed Submissions:** All user-submitted business transitions are written to the database with a status of `'pending'`. They must never appear on the public frontend map until changed to `'approved'` by an admin.
* **Mandatory Evidence Constraints:** The backend validation pipeline must throw a hard exception and reject any form submission where the `evidence_url` field is null, empty, or does not resolve to a valid domain string. Anonymous rumors without URLs are blocked at the gateway.

## UI/UX Blueprint Rules
The frontend dashboard must be responsive, mobile-first, and clean. Follow these layout parameters:
* **The Alerts:** Corporate brands must display a highly professional, muted alert banner (e.g., Amber theme) stating their backing objectively. Do not use inflammatory, biased, or emotional language.
* **The Pivot Row:** The independent alternatives must be rendered directly beneath the corporate profile view as a clear, horizontal swipeable flex row optimized for mobile gestures.
* **Alternative Meta-Data:** Every independent alternative card must prominently showcase its precise proximity distance (e.g., "150m away") and its unique selling point (e.g., "Locally roasted beans").

## Containerization Constraints (Docker)
The application environment must boot cleanly using a single `docker-compose up` execution.
* The Next.js container must preserve volume mounting to allow real-time local file hot-reloading.
* The database container must pre-load the PostGIS extensions automatically during initial orchestration initialization.

## Testing Standards
Ensure security rules, form validation constraints, and geospatial range algorithms are tested aggressively:
* Validate that a `proximity` lookup parameter beyond 1500 meters does not bleed unrelated records into the client feed.
* Verify that a user cannot injection-attack or bypass the `evidence_url` constraint on the submit endpoint.

## Scope Control & Workflow Protocol
Before implementing any file updates or code generations:
1. Inspect the current directory layout and file structures.
2. Summarize the files you intend to create or modify.
3. Call out any security boundaries, performance bottlenecks, or database indexing trade-offs.
4. Execute only the discrete development phase requested. Do not speculatively code features outside the current task scope.

After completing a development task:
1. Validate that the Next.js server builds and the database migration functions smoothly inside the Docker containers.
2. Summarize exactly what changes were introduced.
3. Suggest an explicit, concise Git commit message.
