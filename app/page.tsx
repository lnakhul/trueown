import DiscoveryDashboard from "@/components/DiscoveryDashboard";
import type { SelectedLocation } from "@/lib/types";

/** Demo selection matching the seed data; replace with real search/selection later. */
const DEMO_SELECTED_LOCATION: SelectedLocation = {
  brand_name: "Blank Street Coffee",
  corporate_tier: 2,
  parent_entity: "Blank Street Inc.",
  address: "186 W 4th St, West Village",
  latitude: 40.7324,
  longitude: -74.0021,
};

export default function HomePage() {
  return (
    <main>
      <DiscoveryDashboard selected_location={DEMO_SELECTED_LOCATION} />
    </main>
  );
}
