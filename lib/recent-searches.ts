/**
 * The visitor's recent place searches, kept only in their own browser (never sent
 * anywhere). Storage can be missing or throw (private mode); every call degrades to
 * "no recents".
 */
export const RECENT_SEARCHES_KEY = "trueown:recent-searches:v1";
export const MAX_RECENT_SEARCHES = 5;
const MAX_SEARCH_LENGTH = 100;

export type RecentSearchStorage = Pick<Storage, "getItem" | "setItem">;

export function read_recent_searches(storage: RecentSearchStorage | null): string[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(RECENT_SEARCHES_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0 && entry.length <= MAX_SEARCH_LENGTH)
      .slice(0, MAX_RECENT_SEARCHES);
  } catch {
    return [];
  }
}

function write(storage: RecentSearchStorage | null, searches: string[]): string[] {
  if (storage) {
    try {
      storage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(searches));
    } catch {
      // Full or blocked storage: recents are a convenience only.
    }
  }
  return searches;
}

/** Newest first, no duplicates (case-insensitive), at most five. */
export function remember_search(storage: RecentSearchStorage | null, search: string): string[] {
  const text = search.replace(/\s+/g, " ").trim().slice(0, MAX_SEARCH_LENGTH);
  const current = read_recent_searches(storage);
  if (!text) return current;
  const next = [text, ...current.filter((entry) => entry.toLowerCase() !== text.toLowerCase())].slice(0, MAX_RECENT_SEARCHES);
  return write(storage, next);
}

export function forget_search(storage: RecentSearchStorage | null, search: string): string[] {
  return write(storage, read_recent_searches(storage).filter((entry) => entry.toLowerCase() !== search.toLowerCase()));
}

export function get_recent_search_storage(): RecentSearchStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
