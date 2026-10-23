"use client";

import { useEffect, useState } from "react";

/** Tracks a CSS media query; false during SSR and the first client render. */
export function use_media_query(query: string): boolean {
  const [is_match, set_is_match] = useState(false);
  useEffect(() => {
    const media_query_list = window.matchMedia(query);
    const sync_match = () => set_is_match(media_query_list.matches);
    sync_match();
    media_query_list.addEventListener("change", sync_match);
    return () => media_query_list.removeEventListener("change", sync_match);
  }, [query]);
  return is_match;
}

export const DESKTOP_MEDIA_QUERY = "(min-width: 768px)";
export const REDUCED_MOTION_MEDIA_QUERY = "(prefers-reduced-motion: reduce)";

/** Reads reduced-motion preference at call time (for imperative animations). */
export function prefers_reduced_motion(): boolean {
  return typeof window !== "undefined" && window.matchMedia(REDUCED_MOTION_MEDIA_QUERY).matches;
}
