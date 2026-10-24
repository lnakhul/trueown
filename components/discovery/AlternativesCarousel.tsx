"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AlternativeRecommendation } from "@/lib/types";
import AlternativeCard from "./AlternativeCard";
import { ChevronRightIcon } from "./icons";
import { prefers_reduced_motion } from "./use-media-query";

/** Above this many cards, page dots become a "3 / 12" counter. */
const MAX_PAGE_DOTS = 10;

export interface ScrollRequest {
  location_id: string;
  /** Changes on every request so repeated taps on the same marker still scroll. */
  request_key: number;
}

interface AlternativesCarouselProps {
  heading: string;
  heading_id?: string;
  alternatives: AlternativeRecommendation[];
  active_alternative_id: string | null;
  on_activate: (location_id: string) => void;
  scroll_request: ScrollRequest | null;
  /** "sheet" makes each card nearly full-width for one-at-a-time swiping. */
  layout: "sheet" | "inline";
  /** False when distances were not measured from the visitor. */
  show_distance?: boolean;
}

/** Swipeable, scroll-snapping row of independent alternatives with page dots. */
export default function AlternativesCarousel({
  heading,
  heading_id,
  alternatives,
  active_alternative_id,
  on_activate,
  scroll_request,
  layout,
  show_distance = true,
}: AlternativesCarouselProps) {
  const list_ref = useRef<HTMLUListElement>(null);
  const [page_index, set_page_index] = useState(0);
  const page_index_ref = useRef(0);

  const scroll_to_index = useCallback((index: number) => {
    const list = list_ref.current;
    const item = list?.children[index] as HTMLElement | undefined;
    if (!list || !item) return;
    const scroll_padding = parseFloat(getComputedStyle(list).scrollPaddingLeft) || 0;
    list.scrollTo({
      left: item.offsetLeft - scroll_padding,
      behavior: prefers_reduced_motion() ? "auto" : "smooth",
    });
  }, []);

  /** Derives the current page from scroll position; the snapped card becomes active. */
  const handle_scroll = useCallback(() => {
    const list = list_ref.current;
    if (!list || list.children.length === 0) return;
    const scroll_padding = parseFloat(getComputedStyle(list).scrollPaddingLeft) || 0;
    const at_end = list.scrollLeft >= list.scrollWidth - list.clientWidth - 2;
    let next_index = list.children.length - 1;
    if (!at_end) {
      let smallest_gap = Number.POSITIVE_INFINITY;
      Array.from(list.children).forEach((child, index) => {
        const gap = Math.abs((child as HTMLElement).offsetLeft - scroll_padding - list.scrollLeft);
        if (gap < smallest_gap) {
          smallest_gap = gap;
          next_index = index;
        }
      });
    }
    if (next_index !== page_index_ref.current) {
      page_index_ref.current = next_index;
      set_page_index(next_index);
      const alternative = alternatives[next_index];
      if (alternative) on_activate(alternative.location_id);
    }
  }, [alternatives, on_activate]);

  // A marker tap on the map brings its card into view.
  useEffect(() => {
    if (!scroll_request) return;
    const index = alternatives.findIndex((alternative) => alternative.location_id === scroll_request.location_id);
    if (index >= 0) scroll_to_index(index);
  }, [scroll_request, alternatives, scroll_to_index]);

  if (alternatives.length === 0) {
    return (
      <section aria-labelledby={heading_id} className="space-y-2">
        <h3 id={heading_id} className="text-base font-semibold tracking-tight text-zinc-50">
          {heading}
        </h3>
        <p className="rounded-2xl bg-surface-card px-4 py-6 text-center text-sm text-zinc-400 shadow-hairline">
          No verified independent alternatives nearby yet. Know one? Submit a tip below.
        </p>
      </section>
    );
  }

  const total = alternatives.length;
  const card_width = layout === "sheet" ? "w-[86%]" : "w-[17.5rem]";

  return (
    <section aria-labelledby={heading_id} className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <h3 id={heading_id} className="text-base font-semibold leading-snug tracking-tight text-zinc-50">
          {heading}
        </h3>
        {total > 1 && (
          <div className="hidden shrink-0 gap-1 md:flex">
            <button
              type="button"
              onClick={() => scroll_to_index(Math.max(0, page_index - 1))}
              disabled={page_index === 0}
              aria-label="Previous alternative"
              className="flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.04] text-zinc-300 shadow-hairline transition-colors hover:bg-white/[0.08] disabled:opacity-40"
            >
              <ChevronRightIcon className="h-4 w-4 rotate-180" />
            </button>
            <button
              type="button"
              onClick={() => scroll_to_index(Math.min(total - 1, page_index + 1))}
              disabled={page_index === total - 1}
              aria-label="Next alternative"
              className="flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.04] text-zinc-300 shadow-hairline transition-colors hover:bg-white/[0.08] disabled:opacity-40"
            >
              <ChevronRightIcon className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      <ul
        ref={list_ref}
        role="list"
        tabIndex={0}
        onScroll={handle_scroll}
        aria-label="Independent alternatives, scroll sideways to see more"
        className="scrollbar-none relative -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto overscroll-x-contain px-4 pb-1 md:mx-0 md:scroll-px-0 md:px-0"
      >
        {alternatives.map((alternative, index) => (
          <li
            key={alternative.location_id}
            aria-label={`${index + 1} of ${total}`}
            className={`${card_width} shrink-0 snap-start`}
          >
            <AlternativeCard
              alternative={alternative}
              is_active={alternative.location_id === active_alternative_id}
              on_activate={on_activate}
              show_distance={show_distance}
            />
          </li>
        ))}
      </ul>

      {total > 1 &&
        (total <= MAX_PAGE_DOTS ? (
          <div className="flex justify-center" role="group" aria-label="Choose an alternative">
            {alternatives.map((alternative, index) => (
              <button
                key={alternative.location_id}
                type="button"
                onClick={() => scroll_to_index(index)}
                aria-label={`Show ${alternative.brand_name} (${index + 1} of ${total})`}
                aria-current={index === page_index ? "true" : undefined}
                className="group flex h-11 w-6 items-center justify-center"
              >
                <span
                  aria-hidden="true"
                  className={`block h-1.5 rounded-full transition-all duration-300 ease-spring ${
                    index === page_index ? "w-4 bg-independent" : "w-1.5 bg-zinc-600 group-hover:bg-zinc-400"
                  }`}
                />
              </button>
            ))}
          </div>
        ) : (
          <p className="text-center text-xs tabular-nums text-zinc-500" aria-live="polite">
            {page_index + 1} / {total}
          </p>
        ))}
    </section>
  );
}
