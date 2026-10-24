"use client";

import { FormEvent, KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import type { RecentSearch } from "@/lib/recent-searches";
import type { BrandSuggestion, OwnerSuggestion } from "@/lib/types";
import { OWNERSHIP_TAG, format_distance, summarize_names } from "@/lib/ui/ownership-labels";
import { build_search_sections, flatten_sections, type SearchOption } from "@/lib/ui/search-options";
import { BuildingIcon, ClockIcon, CloseIcon, LocateIcon, PinIcon, SearchIcon } from "./icons";

interface SearchBarProps {
  search_text: string;
  set_search_text: (text: string) => void;
  suggestions: string[];
  brands: BrandSuggestion[];
  owners: OwnerSuggestion[];
  recent_searches: RecentSearch[];
  popular_neighborhoods: string[];
  on_select_place: (place: string) => void;
  on_select_brand: (brand: BrandSuggestion) => void;
  on_select_owner: (owner_name: string) => void;
  on_select_recent: (recent: RecentSearch) => void;
  on_use_location: () => void;
  on_forget_recent: (recent: RecentSearch) => void;
  /** Waiting for the device's position. */
  is_locating: boolean;
  /** Results are anchored on the device's position. */
  is_near_me: boolean;
  /** Lets other controls (e.g. the empty state) focus the input. */
  input_id?: string;
}

/** Amber diamond for corporate-backed, green dot for independent: the same marks as the map. */
function OwnershipMark({ tier }: { tier: 1 | 2 | 3 }) {
  return tier === 3 ? (
    <span aria-hidden="true" className="flex h-4 w-4 items-center justify-center">
      <span className="h-2.5 w-2.5 rounded-full bg-independent" />
    </span>
  ) : (
    <span aria-hidden="true" className="flex h-4 w-4 items-center justify-center">
      <span className="h-2.5 w-2.5 rotate-45 rounded-[2px] bg-corporate" />
    </span>
  );
}

function OptionIcon({ option }: { option: SearchOption }) {
  if (option.kind === "location") return <LocateIcon className="h-4 w-4 text-independent" />;
  if (option.kind === "recent") {
    return option.recent.kind === "owner" ? (
      <BuildingIcon className="h-4 w-4 text-zinc-500" />
    ) : (
      <ClockIcon className="h-4 w-4 text-zinc-500" />
    );
  }
  if (option.kind === "brand") return <OwnershipMark tier={option.brand.corporate_tier} />;
  if (option.kind === "owner") return <BuildingIcon className="h-4 w-4 text-corporate" />;
  if (option.kind === "free_text") return <SearchIcon className="h-4 w-4 text-zinc-500" />;
  return <PinIcon className="h-4 w-4 text-zinc-500" />;
}

function option_text(option: SearchOption): string {
  return option.kind === "free_text" ? `Search “${option.label}”` : option.label;
}

/** Second line: the ownership answer, right in the dropdown. */
function OptionDetail({ option }: { option: SearchOption }) {
  if (option.kind === "brand") {
    const { brand } = option;
    const where = [
      `${brand.location_count} ${brand.location_count === 1 ? "location" : "locations"}`,
      brand.nearest_distance_meters !== null ? `nearest ${format_distance(brand.nearest_distance_meters)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <span className="block truncate text-xs">
        <span className={brand.corporate_tier === 3 ? "text-independent" : "text-corporate"}>
          {OWNERSHIP_TAG[brand.corporate_tier]}
        </span>
        <span className="text-zinc-500"> · {where}</span>
      </span>
    );
  }
  if (option.kind === "owner") {
    const { brand_names } = option.owner;
    return (
      <span className="block truncate text-xs text-zinc-500">
        {brand_names.length === 1 ? "Owns or backs " : `Owns or backs ${brand_names.length} brands: `}
        {summarize_names(brand_names)}
      </span>
    );
  }
  if (option.kind === "recent" && option.recent.kind !== "place") {
    return <span className="block text-xs text-zinc-500">{option.recent.kind === "brand" ? "Brand" : "Owner or backer"}</span>;
  }
  return null;
}

/**
 * Pill search with a "use my location" button. Focusing it opens a compact panel:
 * current location first, then recent searches and a few popular neighborhoods, or
 * live suggestions plus a free-text (address) search while typing.
 */
export default function SearchBar({
  search_text,
  set_search_text,
  suggestions,
  brands,
  owners,
  recent_searches,
  popular_neighborhoods,
  on_select_place,
  on_select_brand,
  on_select_owner,
  on_select_recent,
  on_use_location,
  on_forget_recent,
  is_locating,
  is_near_me,
  input_id,
}: SearchBarProps) {
  const [is_open, set_is_open] = useState(false);
  const [active_index, set_active_index] = useState(-1);
  const container_ref = useRef<HTMLDivElement>(null);
  const input_ref = useRef<HTMLInputElement>(null);
  const listbox_id = useId();

  const sections = useMemo(
    () =>
      build_search_sections({
        text: search_text,
        suggestions,
        recents: recent_searches,
        popular: popular_neighborhoods,
        brands,
        owners,
      }),
    [search_text, suggestions, recent_searches, popular_neighborhoods, brands, owners],
  );
  const options = useMemo(() => flatten_sections(sections), [sections]);

  // New options mean the old highlighted row may no longer exist.
  useEffect(() => set_active_index(-1), [options.length, search_text]);

  // Close when focus or a click moves outside the search.
  useEffect(() => {
    if (!is_open) return;
    function handle_pointer(event: MouseEvent | TouchEvent): void {
      if (container_ref.current && !container_ref.current.contains(event.target as Node)) set_is_open(false);
    }
    document.addEventListener("mousedown", handle_pointer);
    document.addEventListener("touchstart", handle_pointer, { passive: true });
    return () => {
      document.removeEventListener("mousedown", handle_pointer);
      document.removeEventListener("touchstart", handle_pointer);
    };
  }, [is_open]);

  function choose(option: SearchOption): void {
    set_is_open(false);
    input_ref.current?.blur();
    if (option.kind === "location") on_use_location();
    else if (option.kind === "brand") on_select_brand(option.brand);
    else if (option.kind === "owner") on_select_owner(option.owner.name);
    else if (option.kind === "recent") on_select_recent(option.recent);
    else on_select_place(option.label);
  }

  function handle_submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const highlighted = active_index >= 0 ? options[active_index] : null;
    if (highlighted) {
      choose(highlighted);
      return;
    }
    if (search_text.trim()) {
      set_is_open(false);
      on_select_place(search_text);
      input_ref.current?.blur();
    }
  }

  function handle_keydown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      set_is_open(false);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    set_is_open(true);
    if (options.length === 0) return;
    set_active_index((index) =>
      event.key === "ArrowDown" ? (index + 1) % options.length : index <= 0 ? options.length - 1 : index - 1,
    );
  }

  const option_id = (index: number) => `${listbox_id}-option-${index}`;
  let running_index = -1;

  return (
    <div ref={container_ref} className="relative">
      <div className="flex items-center gap-2">
        <form role="search" onSubmit={handle_submit} className="min-w-0 flex-1">
          <div className="flex h-12 items-center gap-2.5 rounded-full border border-hairline bg-surface-card/95 px-4 shadow-lift backdrop-blur transition-colors focus-within:border-zinc-500">
            <SearchIcon className="h-4 w-4 shrink-0 text-zinc-400" />
            <input
              ref={input_ref}
              id={input_id}
              type="search"
              role="combobox"
              aria-label="Search a brand, owner, neighborhood or address"
              aria-expanded={is_open}
              aria-controls={listbox_id}
              aria-autocomplete="list"
              aria-activedescendant={is_open && active_index >= 0 ? option_id(active_index) : undefined}
              value={search_text}
              onChange={(event) => {
                set_search_text(event.target.value);
                set_is_open(true);
              }}
              onFocus={() => set_is_open(true)}
              onKeyDown={handle_keydown}
              placeholder="Search shops, places"
              maxLength={100}
              autoComplete="off"
              enterKeyHint="search"
              className="min-w-0 flex-1 bg-transparent text-base text-zinc-100 outline-none placeholder:text-zinc-500 [&::-webkit-search-cancel-button]:hidden"
            />
            {search_text && (
              <button
                type="button"
                onClick={() => {
                  set_search_text("");
                  set_is_open(true);
                  input_ref.current?.focus();
                }}
                aria-label="Clear search"
                className="-mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            )}
          </div>
        </form>
        <button
          type="button"
          onClick={() => {
            set_is_open(false);
            on_use_location();
          }}
          aria-label={is_locating ? "Finding your location" : "Use my current location"}
          aria-pressed={is_near_me}
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full border shadow-lift backdrop-blur transition-colors ${
            is_near_me
              ? "border-independent/40 bg-independent-muted text-independent"
              : "border-hairline bg-surface-card/95 text-zinc-200 hover:text-zinc-50"
          }`}
        >
          <LocateIcon className={`h-5 w-5 ${is_locating ? "motion-safe:animate-pulse" : ""}`} />
        </button>
      </div>

      {is_open && (
        <div className="absolute inset-x-0 top-full z-40 mt-2 max-h-[min(60vh,28rem)] overflow-y-auto overscroll-contain rounded-2xl border border-hairline bg-surface-raised py-2 shadow-lift">
          <div id={listbox_id} role="listbox" aria-label="Search suggestions">
            {sections.map((section, section_index) => {
              const heading_id = `${listbox_id}-section-${section_index}`;
              return (
                <div key={section.title ?? `section-${section_index}`} role="group" aria-labelledby={section.title ? heading_id : undefined}>
                  {section.title && (
                    <p id={heading_id} role="presentation" className="px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
                      {section.title}
                    </p>
                  )}
                  {section.options.map((option) => {
                    running_index += 1;
                    const index = running_index;
                    const is_active = index === active_index;
                    return (
                      <div
                        key={option.key}
                        id={option_id(index)}
                        role="option"
                        aria-selected={is_active}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => choose(option)}
                        onMouseEnter={() => set_active_index(index)}
                        className={`flex min-h-11 cursor-pointer items-center gap-3 px-4 py-2.5 text-sm ${
                          is_active ? "bg-white/[0.08]" : ""
                        } ${option.kind === "location" ? "font-medium text-zinc-50" : "text-zinc-200"}`}
                      >
                        <OptionIcon option={option} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{option_text(option)}</span>
                          <OptionDetail option={option} />
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {!search_text.trim() && recent_searches.length > 0 && (
            <div className="mt-1 border-t border-hairline px-4 pt-2">
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => recent_searches.forEach((place) => on_forget_recent(place))}
                className="inline-flex min-h-11 items-center text-xs font-medium text-zinc-400 underline-offset-4 hover:text-zinc-100 hover:underline"
              >
                Clear recent searches
              </button>
            </div>
          )}
          <p role="status" className="sr-only">
            {`${options.length} options. Use up and down arrows to review.`}
          </p>
        </div>
      )}
    </div>
  );
}
