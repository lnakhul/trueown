# Security Policy

## Supported versions

Only the latest release on the `main` branch receives security fixes.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private reporting: go to the repository's **Security** tab and choose **Report a vulnerability**. Include:

- what the issue is and where it occurs (file, endpoint or flow)
- steps to reproduce or a proof of concept
- the impact you expect

You can expect an acknowledgement within 5 business days and a status update within 14 days. We will credit reporters in the release notes unless you prefer to stay anonymous.

## Scope

In scope: the Next.js application, API routes, database migrations and RLS policies, import scripts and the Docker setup in this repository.

Out of scope: third-party services (Supabase, Vercel, Cloudflare, Upstash, OpenStreetMap), social engineering, denial-of-service by volume, and findings that need physical access or a compromised device.

## Security design notes

- Row-level security on every table; admin writes require `app_metadata.role = 'admin'` (not user-editable).
- Public tip submissions are inserted as the `anon` role, rate limited, protected by Cloudflare Turnstile and a honeypot, and stored as `pending` until an admin approves them.
- All SQL is parameterized; request bodies are size-limited and validated.
- Secrets live only in environment variables. The Supabase service-role key is never used by the client.

## If you find leaked credentials

If you see a secret committed to this repository, report it privately as above so it can be rotated.
