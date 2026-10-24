import {
  MAX_RECENT_SEARCHES,
  RECENT_SEARCHES_KEY,
  forget_search,
  read_recent_searches,
  remember_search,
  type RecentSearch,
  type RecentSearchStorage,
} from "@/lib/recent-searches";
import { OWNERSHIP_TAG, format_distance, summarize_names } from "@/lib/ui/ownership-labels";
import { build_search_sections, flatten_sections } from "@/lib/ui/search-options";
import type { BrandSuggestion, OwnerSuggestion } from "@/lib/types";

function create_storage(): RecentSearchStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return { entries, getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => void entries.set(key, value) };
}

const place = (label: string): RecentSearch => ({ kind: "place", label });
const BRAND_ID = "b1111111-1111-1111-1111-111111111111";

describe("recent searches", () => {
  test("newest first, deduplicated without regard to case, capped", () => {
    const storage = create_storage();
    remember_search(storage, place("West Village"));
    remember_search(storage, place("  Astoria  "));
    expect(remember_search(storage, place("west village")).map((entry) => entry.label)).toEqual(["west village", "Astoria"]);
    for (let index = 0; index < 10; index += 1) remember_search(storage, place(`Place ${index}`));
    const recents = read_recent_searches(storage);
    expect(recents).toHaveLength(MAX_RECENT_SEARCHES);
    expect(recents[0]!.label).toBe("Place 9");
  });

  test("brands and owners are remembered as what they are", () => {
    const storage = create_storage();
    remember_search(storage, { kind: "brand", label: "Blank Street Coffee", brand_id: BRAND_ID });
    remember_search(storage, { kind: "owner", label: "Blackstone" });
    // A place with the same text is a different search.
    remember_search(storage, place("Blackstone"));
    expect(read_recent_searches(storage)).toEqual([
      { kind: "place", label: "Blackstone" },
      { kind: "owner", label: "Blackstone" },
      { kind: "brand", label: "Blank Street Coffee", brand_id: BRAND_ID },
    ]);
  });

  test("forgetting removes one entry", () => {
    const storage = create_storage();
    remember_search(storage, place("SoHo"));
    remember_search(storage, place("Chelsea"));
    expect(forget_search(storage, place("soho"))).toEqual([place("Chelsea")]);
  });

  test("blank searches are ignored", () => {
    const storage = create_storage();
    expect(remember_search(storage, place("   "))).toEqual([]);
    expect(storage.entries.size).toBe(0);
  });

  test("first-version plain strings read as places; corrupt or foreign entries are dropped", () => {
    const storage = create_storage();
    storage.setItem(RECENT_SEARCHES_KEY, "{not json");
    expect(read_recent_searches(storage)).toEqual([]);
    storage.setItem(
      RECENT_SEARCHES_KEY,
      JSON.stringify([1, "", "Astoria", { a: 1 }, { kind: "brand", label: "No id" }, { kind: "brand", label: "X", brand_id: "not-a-uuid" }]),
    );
    expect(read_recent_searches(storage)).toEqual([place("Astoria")]);
    expect(read_recent_searches(null)).toEqual([]);
    expect(remember_search(null, place("Astoria"))).toEqual([place("Astoria")]);
  });

  test("storage that throws never breaks searching", () => {
    const throwing: RecentSearchStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(read_recent_searches(throwing)).toEqual([]);
    expect(remember_search(throwing, place("Astoria"))).toEqual([place("Astoria")]);
  });
});

const BLANK_STREET: BrandSuggestion = {
  brand_id: BRAND_ID,
  name: "Blank Street Coffee",
  corporate_tier: 2,
  industry_vertical: "coffee_bakery",
  location_count: 4,
  nearest_distance_meters: 120,
};
const FUND: OwnerSuggestion = { name: "Blank Capital", brand_names: ["Blank Street Coffee", "Other Coffee"] };

describe("search panel options", () => {
  test("empty input: location, then recents, then popular picks not already recent", () => {
    const sections = build_search_sections({
      text: "",
      suggestions: [],
      recents: [place("Astoria"), { kind: "owner", label: "SoHo" }],
      popular: ["astoria", "SoHo", "Chelsea"],
    });
    expect(sections.map((section) => section.title)).toEqual([null, "Recent", "Popular neighborhoods"]);
    // Only a recent *place* hides the same popular neighborhood.
    expect(sections[2]!.options.map((option) => option.label)).toEqual(["SoHo", "Chelsea"]);
  });

  test("popular picks are capped so the panel never becomes a long list", () => {
    const popular = Array.from({ length: 20 }, (_, index) => `Neighborhood ${index}`);
    const sections = build_search_sections({ text: "", suggestions: [], recents: [], popular });
    expect(sections[1]!.options.length).toBeLessThanOrEqual(6);
  });

  test("typing: location, brands, owners, neighborhoods, then a free-text search", () => {
    const sections = build_search_sections({
      text: "blank",
      suggestions: ["Blankville"],
      recents: [],
      popular: [],
      brands: [BLANK_STREET],
      owners: [FUND],
    });
    expect(sections.map((section) => section.title)).toEqual([null, "Brands", "Owners & backers", "Neighborhoods", null]);
    expect(flatten_sections(sections).map((option) => option.kind)).toEqual(["location", "brand", "owner", "suggestion", "free_text"]);
  });

  test("an exact neighborhood, brand or owner match has no extra free-text row", () => {
    for (const text of ["west village ", "blank street coffee", "BLANK CAPITAL"]) {
      const options = flatten_sections(
        build_search_sections({ text, suggestions: ["West Village"], recents: [], popular: [], brands: [BLANK_STREET], owners: [FUND] }),
      );
      expect(options.map((option) => option.kind)).not.toContain("free_text");
    }
  });

  test("an address with no suggestions still offers a search", () => {
    const options = flatten_sections(build_search_sections({ text: "186 W 4th St", suggestions: [], recents: [], popular: [] }));
    expect(options.map((option) => option.kind)).toEqual(["location", "free_text"]);
  });
});

describe("ownership labels", () => {
  test("tags, distances and name lists", () => {
    expect(OWNERSHIP_TAG[1]).toBe("Private equity owned");
    expect(OWNERSHIP_TAG[3]).toBe("Independent");
    expect(format_distance(123)).toBe("120m");
    expect(format_distance(1540)).toBe("1.5 km");
    expect(format_distance(23_400)).toBe("23 km");
    expect(summarize_names(["A"])).toBe("A");
    expect(summarize_names(["A", "B"])).toBe("A and B");
    expect(summarize_names(["A", "B", "C", "D"])).toBe("A, B and 2 more");
  });
});
