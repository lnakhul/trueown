/**
 * The visitor's recent searches, kept only in their own browser (never sent
 * anywhere). Storage can be missing or throw (private mode); every call degrades to
 * "no recents".
 *
 * Entries are typed so a brand or owner reopens as that brand or owner, not as a
 * place search. Plain strings from the first version read as places.
 */
export const RECENT_SEARCHES_KEY = "trueown:recent-searches:v1";
export const MAX_RECENT_SEARCHES = 5;
const MAX_SEARCH_LENGTH = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RecentSearch =
  | { kind: "place"; label: string }
  | { kind: "brand"; label: string; brand_id: string }
  | { kind: "owner"; label: string };

export type RecentSearchStorage = Pick<Storage, "getItem" | "setItem">;

function clean_label(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_SEARCH_LENGTH);
}

function parse_entry(entry: unknown): RecentSearch | null {
  if (typeof entry === "string") {
    const label = clean_label(entry);
    return label && entry.length <= MAX_SEARCH_LENGTH ? { kind: "place", label } : null;
  }
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.label !== "string" || record.label.length > MAX_SEARCH_LENGTH) return null;
  const label = clean_label(record.label);
  if (!label) return null;
  if (record.kind === "place" || record.kind === "owner") return { kind: record.kind, label };
  if (record.kind === "brand" && typeof record.brand_id === "string" && UUID_PATTERN.test(record.brand_id)) {
    return { kind: "brand", label, brand_id: record.brand_id };
  }
  return null;
}

/** Two entries are the same search when kind and (case-insensitive) label match. */
export function recent_key(search: RecentSearch): string {
  return `${search.kind}:${search.label.toLowerCase()}`;
}

export function read_recent_searches(storage: RecentSearchStorage | null): RecentSearch[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(RECENT_SEARCHES_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(parse_entry)
      .filter((entry): entry is RecentSearch => entry !== null)
      .slice(0, MAX_RECENT_SEARCHES);
  } catch {
    return [];
  }
}

function write(storage: RecentSearchStorage | null, searches: RecentSearch[]): RecentSearch[] {
  if (storage) {
    try {
      storage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(searches));
    } catch {
      // Full or blocked storage: recents are a convenience only.
    }
  }
  return searches;
}

/** Newest first, no duplicates, at most five. */
export function remember_search(storage: RecentSearchStorage | null, search: RecentSearch): RecentSearch[] {
  const current = read_recent_searches(storage);
  const entry = parse_entry({ ...search, label: clean_label(search.label) });
  if (!entry) return current;
  const key = recent_key(entry);
  return write(storage, [entry, ...current.filter((existing) => recent_key(existing) !== key)].slice(0, MAX_RECENT_SEARCHES));
}

export function forget_search(storage: RecentSearchStorage | null, search: RecentSearch): RecentSearch[] {
  const key = recent_key(search);
  return write(storage, read_recent_searches(storage).filter((existing) => recent_key(existing) !== key));
}

export function get_recent_search_storage(): RecentSearchStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
