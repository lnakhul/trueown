import {
  PROXIMITY_RADIUS_METERS,
  WALKING_METERS_PER_MINUTE,
  estimate_walking_minutes,
  format_proximity,
  proximity_share,
} from "@/lib/proximity-format";
import { map_to_alternative } from "@/lib/db/proximity";

describe("format_proximity", () => {
  it("builds the walking label from minutes and rounded meters", () => {
    expect(format_proximity(140)).toEqual({ minutes: 2, meters: 140, label: "2 min walk • 140m away" });
    expect(format_proximity(240)).toEqual({ minutes: 3, meters: 240, label: "3 min walk • 240m away" });
  });

  it("rounds meters to the nearest whole meter before estimating", () => {
    expect(format_proximity(139.6).meters).toBe(140);
    expect(format_proximity(160.4)).toMatchObject({ meters: 160, minutes: 2 });
  });

  it("rounds minutes up so an estimate is never optimistic", () => {
    expect(estimate_walking_minutes(WALKING_METERS_PER_MINUTE)).toBe(1);
    expect(estimate_walking_minutes(WALKING_METERS_PER_MINUTE + 1)).toBe(2);
    expect(estimate_walking_minutes(1500)).toBe(19);
  });

  it("never shows less than a 1-minute walk", () => {
    expect(format_proximity(0)).toEqual({ minutes: 1, meters: 0, label: "1 min walk • 0m away" });
    expect(format_proximity(12).minutes).toBe(1);
    expect(format_proximity(-5)).toMatchObject({ minutes: 1, meters: 0 });
  });
});

describe("proximity_share", () => {
  it("is the distance as a clamped share of the search radius", () => {
    expect(proximity_share(0)).toBe(0);
    expect(proximity_share(PROXIMITY_RADIUS_METERS / 2)).toBe(0.5);
    expect(proximity_share(PROXIMITY_RADIUS_METERS * 2)).toBe(1);
    expect(proximity_share(Number.NaN)).toBe(0);
  });
});

describe("map_to_alternative", () => {
  it("reuses the shared walking formula", () => {
    const mapped = map_to_alternative({
      location_id: "loc",
      brand_name: "Corner Bakery",
      address: "1 Main St",
      neighborhood: null,
      unique_selling_proposition: null,
      distance_meters: 239.7,
      latitude: 40.7,
      longitude: -74,
    });
    expect(mapped.distance_meters).toBe(240);
    expect(mapped.walking_minutes).toBe(format_proximity(240).minutes);
  });
});
