/**
 * The options shown in the search panel, in order. Pure so the keyboard order and
 * the rendered order can never disagree.
 *
 *   empty input: Use my current location, Recent searches, Popular neighborhoods
 *   typing:      Use my current location, matching neighborhoods, Search "<text>"
 */
export type SearchOption =
  | { kind: "location"; key: string; label: string }
  | { kind: "recent"; key: string; label: string }
  | { kind: "popular"; key: string; label: string }
  | { kind: "suggestion"; key: string; label: string }
  | { kind: "free_text"; key: string; label: string };

export type SearchSection = { title: string | null; options: SearchOption[] };

const MAX_POPULAR_SHOWN = 6;

export function build_search_sections(input: {
  text: string;
  suggestions: string[];
  recents: string[];
  popular: string[];
}): SearchSection[] {
  const text = input.text.trim();
  const location: SearchSection = {
    title: null,
    options: [{ kind: "location", key: "location", label: "Use my current location" }],
  };
  if (!text) {
    const sections: SearchSection[] = [location];
    if (input.recents.length > 0) {
      sections.push({ title: "Recent", options: input.recents.map((label) => ({ kind: "recent", key: `recent:${label}`, label })) });
    }
    const recent = new Set(input.recents.map((label) => label.toLowerCase()));
    const popular = input.popular.filter((label) => !recent.has(label.toLowerCase())).slice(0, MAX_POPULAR_SHOWN);
    if (popular.length > 0) {
      sections.push({ title: "Popular neighborhoods", options: popular.map((label) => ({ kind: "popular", key: `popular:${label}`, label })) });
    }
    return sections;
  }
  const sections: SearchSection[] = [location];
  if (input.suggestions.length > 0) {
    sections.push({
      title: "Neighborhoods",
      options: input.suggestions.map((label) => ({ kind: "suggestion", key: `suggestion:${label}`, label })),
    });
  }
  // An exact neighborhood match needs no extra "search for" row.
  if (!input.suggestions.some((label) => label.toLowerCase() === text.toLowerCase())) {
    sections.push({ title: null, options: [{ kind: "free_text", key: `free:${text}`, label: text }] });
  }
  return sections;
}

export function flatten_sections(sections: SearchSection[]): SearchOption[] {
  return sections.flatMap((section) => section.options);
}
