import {
  MAX_RECENT_SEARCHES,
  RECENT_SEARCHES_KEY,
  forget_search,
  read_recent_searches,
  remember_search,
  type RecentSearchStorage,
} from "@/lib/recent-searches";
import { build_search_sections, flatten_sections } from "@/lib/ui/search-options";

function create_storage(): RecentSearchStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return { entries, getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => void entries.set(key, value) };
}

describe("recent searches", () => {
  test("newest first, deduplicated without regard to case, capped", () => {
    const storage = create_storage();
    remember_search(storage, "West Village");
    remember_search(storage, "  Astoria  ");
    expect(remember_search(storage, "west village")).toEqual(["west village", "Astoria"]);
    for (let index = 0; index < 10; index += 1) remember_search(storage, `Place ${index}`);
    const recents = read_recent_searches(storage);
    expect(recents).toHaveLength(MAX_RECENT_SEARCHES);
    expect(recents[0]).toBe("Place 9");
  });

  test("forgetting removes one entry", () => {
    const storage = create_storage();
    remember_search(storage, "SoHo");
    remember_search(storage, "Chelsea");
    expect(forget_search(storage, "soho")).toEqual(["Chelsea"]);
  });

  test("blank searches are ignored", () => {
    const storage = create_storage();
    expect(remember_search(storage, "   ")).toEqual([]);
    expect(storage.entries.size).toBe(0);
  });

  test("corrupt, foreign or missing storage reads as empty", () => {
    const storage = create_storage();
    storage.setItem(RECENT_SEARCHES_KEY, "{not json");
    expect(read_recent_searches(storage)).toEqual([]);
    storage.setItem(RECENT_SEARCHES_KEY, JSON.stringify([1, "", "ok", { a: 1 }]));
    expect(read_recent_searches(storage)).toEqual(["ok"]);
    expect(read_recent_searches(null)).toEqual([]);
    expect(remember_search(null, "Astoria")).toEqual(["Astoria"]);
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
    expect(remember_search(throwing, "Astoria")).toEqual(["Astoria"]);
  });
});

describe("search panel options", () => {
  test("empty input: location, then recents, then popular picks not already recent", () => {
    const sections = build_search_sections({
      text: "",
      suggestions: [],
      recents: ["Astoria"],
      popular: ["astoria", "SoHo", "Chelsea"],
    });
    expect(sections.map((section) => section.title)).toEqual([null, "Recent", "Popular neighborhoods"]);
    expect(flatten_sections(sections).map((option) => option.kind)).toEqual(["location", "recent", "popular", "popular"]);
    expect(sections[2]!.options.map((option) => option.label)).toEqual(["SoHo", "Chelsea"]);
  });

  test("popular picks are capped so the panel never becomes a long list", () => {
    const popular = Array.from({ length: 20 }, (_, index) => `Neighborhood ${index}`);
    const sections = build_search_sections({ text: "", suggestions: [], recents: [], popular });
    expect(sections[1]!.options.length).toBeLessThanOrEqual(6);
  });

  test("typing: location, suggestions, then a free-text search", () => {
    const options = flatten_sections(
      build_search_sections({ text: "wes", suggestions: ["West Village", "Westerleigh"], recents: ["SoHo"], popular: ["SoHo"] }),
    );
    expect(options.map((option) => option.kind)).toEqual(["location", "suggestion", "suggestion", "free_text"]);
    expect(options[3]!.label).toBe("wes");
  });

  test("an exact neighborhood match has no extra free-text row", () => {
    const options = flatten_sections(
      build_search_sections({ text: "west village ", suggestions: ["West Village"], recents: [], popular: [] }),
    );
    expect(options.map((option) => option.kind)).toEqual(["location", "suggestion"]);
  });

  test("an address with no suggestions still offers a search", () => {
    const options = flatten_sections(build_search_sections({ text: "186 W 4th St", suggestions: [], recents: [], popular: [] }));
    expect(options.map((option) => option.kind)).toEqual(["location", "free_text"]);
  });
});
