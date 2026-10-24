import type { Metadata } from "next";
import Link from "next/link";
import Prose from "@/components/site/Prose";
import { CONTACT_EMAIL, SITE_NAME, absolute_url } from "@/lib/site";

export const metadata: Metadata = {
  title: `Terms of Use — ${SITE_NAME}`,
  description: "The terms for using TrueOwn.",
  alternates: { canonical: absolute_url("/terms") },
};

const EFFECTIVE_DATE = "October 24, 2026";

export default function TermsPage() {
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-3xl space-y-8 px-4 pb-16 pt-8 outline-none sm:px-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50 sm:text-4xl">Terms of Use</h1>
        <p className="text-sm text-zinc-500">Effective {EFFECTIVE_DATE}</p>
      </header>
      <Prose>
        <p>
          These terms apply to gettrueown.com (“TrueOwn”). By using the site you agree to them. If you do not agree, please do not use the
          site.
        </p>

        <h2>What TrueOwn is</h2>
        <p>
          TrueOwn is an information service. It shows who owns or funds businesses, based on public sources, and suggests independent
          alternatives nearby. It is free to use.
        </p>

        <h2>Information, not advice</h2>
        <ul>
          <li>
            We work to keep listings accurate and cite a source for each one, but ownership changes and sources can be incomplete. Listings
            may be out of date or wrong. Check the linked source before relying on it.
          </li>
          <li>
            Our classifications (private equity owned, venture capital funded, independent) describe ownership and funding, as explained in{" "}
            <Link href="/how-we-classify">how we classify businesses</Link>. They are not a judgment of any business&apos;s quality or
            conduct.
          </li>
          <li>Nothing on TrueOwn is financial, investment, legal or other professional advice.</li>
        </ul>

        <h2>Brands and trademarks</h2>
        <p>
          Business names and trademarks belong to their owners. TrueOwn is not affiliated with, sponsored by or endorsed by the businesses or
          investors it lists.
        </p>

        <h2>What you send us</h2>
        <ul>
          <li>Tips, error reports and business claims must be truthful and, where asked, backed by a real source.</li>
          <li>Only the owner, a co-owner or a manager (with permission) may claim a business.</li>
          <li>
            By sending a tip or report, you let us use its contents to review and update listings. We may decline or remove any submission.
          </li>
        </ul>

        <h2>Acceptable use</h2>
        <p>Please do not:</p>
        <ul>
          <li>break the law or others&apos; rights through the site;</li>
          <li>submit false, misleading or spam content, or impersonate someone;</li>
          <li>try to get around rate limits, spam protection or security, or access areas you are not authorized to use;</li>
          <li>overload the site or copy its data in bulk with automated tools.</li>
        </ul>
        <p>We may limit or block access that breaks these rules.</p>

        <h2>Other sites</h2>
        <p>
          Listings link to sources and services we do not control (news sites, SEC EDGAR, maps and directions). Their content and terms are
          their own.
        </p>

        <h2>No warranty</h2>
        <p>
          TrueOwn is provided “as is” and “as available”, without warranties of any kind, express or implied, including accuracy, fitness for
          a particular purpose and non-infringement, to the fullest extent the law allows.
        </p>

        <h2>Limitation of liability</h2>
        <p>
          To the fullest extent the law allows, TrueOwn and the people who run it are not liable for any indirect, incidental, special or
          consequential damages, or for any loss arising from use of, or reliance on, the site or its information.
        </p>

        <h2>Changes</h2>
        <p>We may update these terms. The date at the top shows the latest version; continuing to use the site means you accept it.</p>

        <h2>Governing law</h2>
        <p>These terms are governed by the laws of the State of New York, without regard to its conflict-of-laws rules.</p>

        <h2>Contact</h2>
        <p>
          Questions about these terms: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>
      </Prose>
    </main>
  );
}
