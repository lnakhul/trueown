# Deployment checklist (Vercel + Supabase)

## 1. Supabase (already done for the current project)
- Migrations applied in filename order, including `20261021000000_reputable_news_source.sql`.
- `npm run db:import:boundaries -- --yes` run against the hosted database (262 NTA polygons).
- An admin user exists with `app_metadata.role = 'admin'`.
- Use the **session pooler** connection string for `DATABASE_URL` (IPv4-compatible).

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

   Do **not** set `ADMIN_PASSWORD` in production: with Supabase configured, `/admin` uses Supabase Auth. Never add the service-role key.
3. Deploy, then open the deployment URL and run the smoke test below.

## 4. Domain and Turnstile
- Add `gettrueown.com` (and `www`) under Vercel > Domains and set the DNS records it shows.
- In Cloudflare Turnstile, make sure `gettrueown.com` is in the widget's hostname list. Add the `*.vercel.app` preview host too if you want previews to work.
- In Supabase > Authentication > URL Configuration, set the Site URL to `https://gettrueown.com`.

## 5. Uptime monitoring
Point a monitor (UptimeRobot, Better Stack, etc.) at `https://gettrueown.com/api/health`. It returns `200 {"status":"ok"}` when the app and database are healthy and `503` otherwise. Alert on non-200.

## 6. Smoke test after each deploy
- `GET /api/health` returns 200.
- Home page loads; searching "West Village" shows alternatives.
- Submit a tip (Turnstile widget appears and the tip lands as `pending`).
- `/admin` redirects to the login page; sign in, approve or reject a tip.
- Response headers include `X-Frame-Options: DENY` and `X-Content-Type-Options: nosniff`.

## Known gaps
- No error tracking yet (Sentry needs a project DSN).
- Rate limiting is per instance until Upstash is configured.
