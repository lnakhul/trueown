import type { Metadata } from "next";
import DiscoveryDashboard from "@/components/DiscoveryDashboard";
import SiteFooter from "@/components/site/SiteFooter";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = { alternates: { canonical: SITE_URL } };

export default function HomePage() {
  return (
    <>
      <main id="main-content" tabIndex={-1} className="outline-none">
        <DiscoveryDashboard />
      </main>
      <SiteFooter />
    </>
  );
}
