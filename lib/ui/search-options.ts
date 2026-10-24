/**
 * The options shown in the search panel, in order. Pure so the keyboard order and
 * the rendered order can never disagree.
 *
 *   empty input: Use my current location, Recent searches, Popular neighborhoods
 *   typing:      Use my current location, Brands, Owners & backers, Neighborhoods,
 *                Search "<text>" (an address or anything else)
 */
import type { RecentSearch } from "@/lib/recent-searches";
import type { BrandSuggestion, OwnerSuggestion } from "@/lib/types";

export type SearchOption =
  | { kind: "location"; key: string; label: string }
  | { kind: "recent"; key: string; label: string; recent: RecentSearch }
  | { kind: "popular"; key: string; label: string }
  | { kind: "brand"; key: string; label: string; brand: BrandSuggestion }
  | { kind: "owner"; key: string; label: string; owner: OwnerSuggestion }
  | { kind: "suggestion"; key: string; label: string }
  | { kind: "free_text"; key: string; label: string };

export type SearchSection = { title: string | null; options: SearchOption[] };

const MAX_POPULAR_SHOWN = 6;

export function build_search_sections(input: {
  text: string;
  suggestions: string[];
  recents: RecentSearch[];
  popular: string[];
  brands?: BrandSuggestion[];
  owners?: OwnerSuggestion[];
}): SearchSection[] {
  const text = input.text.trim();
  const brands = input.brands ?? [];
  const owners = input.owners ?? [];
  const location: SearchSection = {
    title: null,
    options: [{ kind: "location", key: "location", label: "Use my current location" }],
  };
  if (!text) {
    const sections: SearchSection[] = [location];
    if (input.recents.length > 0) {
      sections.push({
        title: "Recent",
        options: input.recents.map((recent) => ({
          kind: "recent",
          key: `recent:${recent.kind}:${recent.label}`,
          label: recent.label,
          recent,
        })),
      });
    }
    const recent_places = new Set(
      input.recents.filter((recent) => recent.kind === "place").map((recent) => recent.label.toLowerCase()),
    );
    const popular = input.popular.filter((label) => !recent_places.has(label.toLowerCase())).slice(0, MAX_POPULAR_SHOWN);
    if (popular.length > 0) {
      sections.push({ title: "Popular neighborhoods", options: popular.map((label) => ({ kind: "popular", key: `popular:${label}`, label })) });
    }
    return sections;
  }

  const sections: SearchSection[] = [location];
  if (brands.length > 0) {
    sections.push({
      title: "Brands",
      options: brands.map((brand) => ({ kind: "brand", key: `brand:${brand.brand_id}`, label: brand.name, brand })),
    });
  }
  if (owners.length > 0) {
    sections.push({
      title: "Owners & backers",
      options: owners.map((owner) => ({ kind: "owner", key: `owner:${owner.name.toLowerCase()}`, label: owner.name, owner })),
    });
  }
  if (input.suggestions.length > 0) {
    sections.push({
      title: "Neighborhoods",
      options: input.suggestions.map((label) => ({ kind: "suggestion", key: `suggestion:${label}`, label })),
    });
  }
  // An exact match needs no extra "search for" row.
  const lowered = text.toLowerCase();
  const exact = [...input.suggestions, ...brands.map((brand) => brand.name), ...owners.map((owner) => owner.name)].some(
    (label) => label.toLowerCase() === lowered,
  );
  if (!exact) {
    sections.push({ title: null, options: [{ kind: "free_text", key: `free:${text}`, label: text }] });
  }
  return sections;
}

export function flatten_sections(sections: SearchSection[]): SearchOption[] {
  return sections.flatMap((section) => section.options);
}
