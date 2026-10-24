import type { Metadata } from "next";
import Link from "next/link";
import Prose from "@/components/site/Prose";
import { CONTACT_EMAIL, SITE_NAME, absolute_url } from "@/lib/site";

export const metadata: Metadata = {
  title: `Privacy Policy — ${SITE_NAME}`,
  description: "What TrueOwn collects, why, and what we never do with it.",
  alternates: { canonical: absolute_url("/privacy") },
};

const EFFECTIVE_DATE = "October 24, 2026";

export default function PrivacyPage() {
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-3xl space-y-8 px-4 pb-16 pt-8 outline-none sm:px-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50 sm:text-4xl">Privacy Policy</h1>
        <p className="text-sm text-zinc-500">Effective {EFFECTIVE_DATE}</p>
      </header>
      <Prose>
        <p>
          TrueOwn (“we”) runs gettrueown.com. We collect as little as we can. There are no ads, no advertising or analytics trackers, and
          we do not sell or share personal information for advertising.
        </p>

        <h2>You can browse without an account</h2>
        <p>Only TrueOwn administrators sign in. Visitors never need an account.</p>

        <h2>Your location</h2>
        <ul>
          <li>
            If you allow it, your browser shares your location so we can show nearby businesses. We round it to about 11 meters before it
            leaves your device and use it only to answer that search.
          </li>
          <li>
            We do not save your location in our database or link it to you. Our hosting provider may keep short-lived technical request logs
            that include the rounded coordinates of a search.
          </li>
          <li>
            Your last result is kept in your own browser for up to 15 minutes so the page loads quickly. You can turn location off at any
            time in your browser or phone settings, and search by neighborhood or address instead.
          </li>
        </ul>

        <h2>Searches</h2>
        <ul>
          <li>Your five most recent searches are stored only in your browser, so you can repeat them. You can clear them from the search panel.</li>
          <li>
            When you search a street address, our server looks it up with the OpenStreetMap Nominatim service. The address text, not who
            searched it, may be cached for up to 30 days to avoid repeat lookups.
          </li>
          <li>We count searches in aggregate (for example, how many searches happen in a city) without locations or identifiers.</li>
        </ul>

        <h2>Forms you send us</h2>
        <ul>
          <li>
            <strong>Tips</strong> about ownership changes: the business name, address and a link to your evidence. No personal details
            are required.
          </li>
          <li>
            <strong>Error reports:</strong> what is wrong, your relationship to the business, and, if you choose, an email address so we can
            follow up.
          </li>
          <li>
            <strong>Business claims:</strong> your name, role, a business email, an optional phone number and the business website. Only
            administrators can see these, and we use them only to verify the claim and contact you about it.
          </li>
        </ul>
        <p>We keep form submissions as long as needed to review them and keep an accurate record of changes. You can ask us to delete yours.</p>

        <h2>Spam and abuse protection</h2>
        <p>
          Forms use Cloudflare Turnstile to tell people from bots. To limit abuse, our servers use your IP address to count requests over
          short windows (minutes); these counts expire on their own.
        </p>

        <h2>Service providers</h2>
        <p>We rely on a few providers to run the site. Each receives only what it needs:</p>
        <ul>
          <li>Vercel (hosting) and Supabase (database).</li>
          <li>Cloudflare (domain, and Turnstile on forms).</li>
          <li>Upstash (short-lived rate-limit counters and the address lookup cache).</li>
          <li>OpenStreetMap: the map images are loaded from OpenStreetMap servers, which see your IP address and the area you view.</li>
          <li>
            Sentry (error reports, if enabled): errors are scrubbed of locations, search text, cookies and form contents before they are
            sent.
          </li>
        </ul>

        <h2>Cookies</h2>
        <p>
          The public site sets no cookies. Administrators get sign-in cookies. Your browser&apos;s local storage holds your recent searches and
          the 15-minute location cache described above.
        </p>

        <h2>Children</h2>
        <p>TrueOwn is not directed to children under 13, and we do not knowingly collect their personal information.</p>

        <h2>Your choices and rights</h2>
        <p>
          You can ask to see, correct or delete personal information you sent us (for example, a claim or an error report with your email)
          by writing to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. We will reply within 30 days.
        </p>

        <h2>Business information is public</h2>
        <p>
          Listings describe businesses, not people: names, addresses and ownership drawn from public sources. If a listing is wrong, use
          “Report an error”, or see <Link href="/how-we-classify">how we classify businesses</Link>.
        </p>

        <h2>Changes</h2>
        <p>If this policy changes, we will update the date at the top. Significant changes will be noted on the site.</p>
      </Prose>
    </main>
  );
}
