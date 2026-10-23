"use client";

import type { DiscoveryController } from "./use-discovery";
import { LocateIcon, SearchIcon } from "./icons";

type NeighborhoodSearchProps = Pick<
  DiscoveryController,
  | "fallback_notice"
  | "search_text"
  | "set_search_text"
  | "suggestions"
  | "suggestions_visible"
  | "active_suggestion"
  | "handle_search_submit"
  | "handle_search_keydown"
  | "select_neighborhood"
  | "neighborhoods"
  | "neighborhoods_error"
  | "active_neighborhood"
  | "refresh_location"
>;

/** Neighborhood / address search used when device location is unavailable or declined. */
export default function NeighborhoodSearch({
  fallback_notice,
  search_text,
  set_search_text,
  suggestions,
  suggestions_visible,
  active_suggestion,
  handle_search_submit,
  handle_search_keydown,
  select_neighborhood,
  neighborhoods,
  neighborhoods_error,
  active_neighborhood,
  refresh_location,
}: NeighborhoodSearchProps) {
  return (
    <section
      aria-labelledby="neighborhood-heading"
      className="space-y-4 rounded-2xl bg-surface-card p-5 shadow-hairline"
    >
      <div>
        <h2 id="neighborhood-heading" className="text-base font-semibold tracking-tight text-zinc-50">
          Search by Neighborhood
        </h2>
        {fallback_notice && (
          <p role="status" className="mt-1 text-sm text-zinc-400">
            {fallback_notice}
          </p>
        )}
      </div>

      <form onSubmit={handle_search_submit} className="relative" role="search">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-zinc-500">
              <SearchIcon />
            </span>
            <input
              type="search"
              role="combobox"
              aria-expanded={suggestions_visible}
              aria-controls="neighborhood-suggestions"
              aria-autocomplete="list"
              aria-activedescendant={active_suggestion >= 0 ? `neighborhood-suggestion-${active_suggestion}` : undefined}
              onKeyDown={handle_search_keydown}
              value={search_text}
              onChange={(event) => set_search_text(event.target.value)}
              placeholder="e.g. West Village or 186 W 4th St"
              maxLength={100}
              autoComplete="off"
              aria-label="Neighborhood name"
              className="min-h-11 w-full rounded-xl border border-hairline bg-surface-page py-3 pl-10 pr-4 text-base text-zinc-100 outline-none transition-colors placeholder:text-zinc-500 focus:border-zinc-500"
            />
          </div>
          <button
            type="submit"
            disabled={search_text.trim().length === 0}
            className="min-h-11 shrink-0 rounded-xl bg-zinc-100 px-5 py-3 text-sm font-semibold text-zinc-950 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
          >
            Search
          </button>
        </div>
        {suggestions_visible && (
          <ul
            id="neighborhood-suggestions"
            role="listbox"
            aria-label="Neighborhood suggestions"
            className="absolute z-10 mt-2 w-full overflow-hidden rounded-xl border border-hairline bg-surface-raised shadow-lift"
          >
            {suggestions.map((suggestion, index) => (
              <li
                key={suggestion}
                id={`neighborhood-suggestion-${index}`}
                role="option"
                aria-selected={index === active_suggestion}
                onMouseDown={(event) => {
                  // Keep input focus so the click is not lost to a blur.
                  event.preventDefault();
                  select_neighborhood(suggestion);
                }}
                className={`block min-h-11 cursor-pointer px-4 py-3 text-left text-sm text-zinc-200 hover:bg-white/[0.06] ${
                  index === active_suggestion ? "bg-white/[0.08]" : ""
                }`}
              >
                {suggestion}
              </li>
            ))}
          </ul>
        )}
        <p role="status" className="sr-only">
          {suggestions_visible ? `${suggestions.length} suggestions available. Use up and down arrows to review.` : ""}
        </p>
      </form>

      {neighborhoods_error && (
        <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {neighborhoods_error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {neighborhoods.map((neighborhood) => (
          <button
            key={neighborhood}
            type="button"
            onClick={() => select_neighborhood(neighborhood)}
            aria-pressed={active_neighborhood === neighborhood}
            className={`min-h-11 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
              active_neighborhood === neighborhood
                ? "bg-zinc-100 text-zinc-950"
                : "bg-white/[0.04] text-zinc-300 shadow-hairline hover:bg-white/[0.08] hover:text-zinc-100"
            }`}
          >
            {neighborhood}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={refresh_location}
        className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-zinc-200 underline-offset-4 hover:underline"
      >
        <LocateIcon />
        Try my location again
      </button>
    </section>
  );
}
