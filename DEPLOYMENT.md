# Deployment checklist (Vercel + Supabase)

## 1. Supabase (already done for the current project)
- Migrations applied in filename order, including `20261021000000_reputable_news_source.sql` and `20261022000000_brand_financial_backers.sql`, and `20261023000000_03_regional_markets.sql` (apply it before deploying code that includes it; it backfills `locations.market_id`). **Apply the latter before deploying code that includes it**; the proximity queries select `brands.financial_backers`.
- `npm run db:import:boundaries -- --yes` run against the hosted database (262 NTA polygons).
- An admin user exists with `app_metadata.role = 'admin'`. Create the user in Supabase Auth, then run `npm run admin:grant -- --email you@example.com --yes` from a trusted machine with `SUPABASE_SERVICE_ROLE_KEY` set locally (`--revoke` removes it). Never deploy the service-role key.
- Use the **session pooler** connection string for `DATABASE_URL` (host `…pooler.supabase.com`, user `postgres.<project-ref>`). The direct `db.<ref>.supabase.co` address is IPv6-only, and Vercel and GitHub Actions cannot reach it.
- Before deploying the public website, apply migrations 11–13 in order: `…_11_brand_search.sql`, `…_12_ownership_alerts.sql` and `…_13_brand_slugs.sql`. Migration 13 gives every brand its web address, so brand pages, the Brands directory and the sitemap need it.

## 2. Upstash Redis (shared rate limiting, optional but recommended)
1. Create a free Redis database at https://upstash.com (pick a region near your Vercel region).
2. Copy the **REST** URL and token into `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.
3. Without them, limits are per serverless instance (weaker, but never unlimited). If Redis is down, the app falls back to that automatically.

## 3. Vercel
1. Import the GitHub repo as a new project (framework: Next.js; [vercel.json](vercel.json) pins region `iad1`, closest to Supabase `ca-central-1`).
2. Add these environment variables (Production and Preview as needed):

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Supabase session-pooler string. Server-only. |
| `NEXT_PUBLIC_SUPABASE_URL` | Public. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public; protected by RLS. |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Public. Must be set at **build** time. |
| `TURNSTILE_SECRET_KEY` | Server-only. Use the **rotated** secret. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Server-only, optional. |
| `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_DSN` | Optional error tracking. Unset = Sentry disabled. The public one must be set at **build** time. |
| `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` | Optional, build-time only. Upload source maps when the token is set. |
| `SENTRY_TRACES_SAMPLE_RATE`, `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | Optional, default `0.1`. |

   Sentry events are scrubbed of query strings (which carry coordinates), cookies, headers, request bodies and user data before sending.

   Do **not** set `ADMIN_PASSWORD` in production: it is ignored there, and `/admin` returns 503 unless Supabase Auth is configured. Never add the service-role key.
   The `DATABASE_URL` role must be allowed to `SET ROLE authenticated` (Supabase's `postgres` role is): admin reads and writes run as `authenticated` with the signed-in admin's claims, so RLS and `is_admin()` apply to them.
3. Deploy, then open the deployment URL and run the smoke test below.

## 4. Domain (Cloudflare DNS), Turnstile and Supabase Auth
1. Vercel > your project > **Settings > Domains**: add `gettrueown.com` and accept adding `www.gettrueown.com` as a redirect. Vercel then lists the DNS records it needs, usually an **A** record for the apex and a **CNAME** for `www`.
2. Cloudflare > `gettrueown.com` > **DNS > Records**: add exactly those records (Name `@` for the apex, `www` for the CNAME). Set the **Proxy status to "DNS only" (grey cloud)** on both: Vercel issues the HTTPS certificate itself, and Cloudflare's proxy gets in the way. Remove any older A, AAAA or CNAME records for `@` or `www`.
3. Wait until Vercel shows **Valid Configuration** for both domains (usually minutes).
4. Cloudflare > **Turnstile** > your widget > **Hostnames**: add `gettrueown.com` and `www.gettrueown.com`. Add the `*.vercel.app` preview host too if you want forms to work on previews.
5. Supabase > **Authentication > URL Configuration**: set the Site URL to `https://gettrueown.com` and add `https://gettrueown.com/**` to Redirect URLs.
6. Optional: Cloudflare > **Email Routing**: create `hello@gettrueown.com` and forward it to your inbox. The About, Privacy and Terms pages list it. Set `NEXT_PUBLIC_CONTACT_EMAIL` to use a different address.
7. `NEXT_PUBLIC_SITE_URL` defaults to `https://gettrueown.com`. It's used for canonical links, the sitemap and link previews. Set it only if the site moves.

## 5. Uptime monitoring
Point a monitor (UptimeRobot, Better Stack, etc.) at `https://gettrueown.com/api/health`. It returns `200 {"status":"ok"}` when the app and database are healthy and `503` otherwise. Alert on non-200.

## 6. Ownership-change watch (weekly)
1. Apply `20261101000000_12_ownership_alerts.sql` to Supabase.
2. In GitHub > Settings > Secrets and variables > Actions, add `WATCH_DATABASE_URL` (the session-pooler string) and `OWNERSHIP_WATCH_CONTACT` (a contact email; the SEC requires one in automated requests).
3. The **Ownership watch** workflow runs every Monday, or by hand from the Actions tab (optionally with a brand limit). It checks every brand on the map, about 6 seconds per brand, because GDELT allows one request every 5 seconds. Brands checked in the last 6 days are skipped, so a run that stops early picks up where it left off.
4. New finds appear on `/admin/alerts`. Without the secrets, the workflow does nothing.

The first run looks back 3 months of news and 12 months of filings; later runs only look at what's new since the last check. To try it locally first: `npm run db:watch:ownership -- --dry-run --limit 5`.

## 7. Smoke test after each deploy
- `GET /api/health` returns 200.
- Home page loads; searching "West Village" shows alternatives.
- Submit a tip (Turnstile widget appears and the tip lands as `pending`).
- `/admin` redirects to the login page; sign in, approve or reject a tip.
- Response headers include `X-Frame-Options: DENY` and `X-Content-Type-Options: nosniff`.

## Known gaps
- No error tracking yet (Sentry needs a project DSN).
- Rate limiting is per instance until Upstash is configured.
