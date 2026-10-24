import type { Metadata } from "next";
import Link from "next/link";
import Prose from "@/components/site/Prose";
import { CONTACT_EMAIL, SITE_NAME, absolute_url } from "@/lib/site";

export const metadata: Metadata = {
  title: `About — ${SITE_NAME}`,
  description: "TrueOwn shows who really owns the coffee shops and bakeries around you, and points you to independent alternatives nearby.",
  alternates: { canonical: absolute_url("/about") },
};

export default function AboutPage() {
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-3xl space-y-8 px-4 pb-16 pt-8 outline-none sm:px-6">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50 sm:text-4xl">About TrueOwn</h1>
        <p className="text-lg text-zinc-300">
          Many neighborhood favorites are owned or funded by private equity and venture capital, and it is rarely obvious from the sign
          on the door. TrueOwn makes it obvious, and helps you find the independent spot down the street.
        </p>
      </header>
      <Prose>
        <h2>How it works</h2>
        <ul>
          <li>
            <strong>Open the map.</strong> Share your location or search a neighborhood, address, brand or investor.
          </li>
          <li>
            <strong>See who owns what.</strong> Amber diamonds are corporate-backed (private equity owned or venture capital funded). Green
            dots are independent.
          </li>
          <li>
            <strong>Keep it local.</strong> Tap a corporate-backed spot to see independent alternatives within a short walk, with directions.
          </li>
        </ul>

        <h2>Every claim has a source</h2>
        <p>
          We only mark a business as corporate-backed when there is public evidence: SEC filings, investor announcements, business
          intelligence databases or reputable news. Independents are confirmed through state business registries, local press or the
          owner&apos;s own confirmation. Every brand page links to its source and shows when it was last checked.{" "}
          <Link href="/how-we-classify">Read how we classify businesses</Link>.
        </p>
        <p>
          Ownership changes. We watch the news and SEC filings for acquisitions and new investment, and a person reviews every change
          before it appears on the site.
        </p>

        <h2>Where we are</h2>
        <p>
          TrueOwn launches with coffee shops and bakeries in New York City. More cities and kinds of business will follow.
        </p>

        <h2>Get involved</h2>
        <ul>
          <li>Know of an ownership change? Use “Submit a tip” at the bottom of any page, with a link to your evidence.</li>
          <li>
            Run an independent business? <Link href="/claim">Claim your business</Link> to confirm it.
          </li>
          <li>Spotted a mistake? Use “Report an error” on the listing.</li>
        </ul>

        <h2>Contact</h2>
        <p>
          Write to us at <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>
      </Prose>
    </main>
  );
}
