/**
 * Map tile source. The default needs no API key: OpenStreetMap's standard tiles,
 * darkened in the browser with a CSS filter so they match the dark theme.
 *
 * For production traffic, point NEXT_PUBLIC_MAP_TILE_URL at a provider you have
 * an account with (CARTO, Stadia, MapTiler...). Keyed URLs carry the key in the
 * query string, which is normal for browser tile keys (restrict it by domain in
 * the provider's dashboard). Set NEXT_PUBLIC_MAP_TILE_DARK=true when that style
 * is already dark so no filter is applied.
 *
 * Note: CARTO's basemaps (dark_all, light_all...) now return an "API KEY
 * REQUIRED" image without a key, which is why they are no longer the default.
 */
export interface TileConfig {
  url: string;
  attribution: string;
  subdomains: string;
  max_zoom: number;
  /** True when the tiles are light and must be darkened with the CSS filter. */
  needs_dark_filter: boolean;
}

export const DEFAULT_TILE_CONFIG: TileConfig = {
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  subdomains: "abc",
  max_zoom: 19,
  needs_dark_filter: true,
};

export interface TileEnv {
  url?: string;
  attribution?: string;
  subdomains?: string;
  max_zoom?: string;
  is_dark?: string;
}

/** Leaflet URL templates must be https and contain {z}, {x} and {y}. */
function valid_template(url: string): boolean {
  if (!["{z}", "{x}", "{y}"].every((placeholder) => url.includes(placeholder))) return false;
  try {
    // Placeholders are not valid URL characters everywhere; swap them before parsing.
    return new URL(url.replace(/\{[a-z]+\}/g, "0")).protocol === "https:";
  } catch {
    return false;
  }
}

/** Builds the tile config from env values; anything missing or invalid falls back to the default. */
export function resolve_tile_config(env: TileEnv): TileConfig {
  const url = env.url?.trim();
  if (!url || !valid_template(url)) return DEFAULT_TILE_CONFIG;

  const attribution = env.attribution?.trim();
  const max_zoom = Number(env.max_zoom);
  return {
    url,
    // A custom provider must credit its data; never show an empty attribution.
    attribution: attribution || DEFAULT_TILE_CONFIG.attribution,
    subdomains: env.subdomains?.trim() || DEFAULT_TILE_CONFIG.subdomains,
    max_zoom: Number.isInteger(max_zoom) && max_zoom >= 1 && max_zoom <= 22 ? max_zoom : DEFAULT_TILE_CONFIG.max_zoom,
    needs_dark_filter: env.is_dark?.trim().toLowerCase() !== "true",
  };
}

/** NEXT_PUBLIC_ values must be read by literal name so Next.js can inline them into the browser bundle. */
export function tile_config_from_env(): TileConfig {
  return resolve_tile_config({
    url: process.env.NEXT_PUBLIC_MAP_TILE_URL,
    attribution: process.env.NEXT_PUBLIC_MAP_TILE_ATTRIBUTION,
    subdomains: process.env.NEXT_PUBLIC_MAP_TILE_SUBDOMAINS,
    max_zoom: process.env.NEXT_PUBLIC_MAP_TILE_MAX_ZOOM,
    is_dark: process.env.NEXT_PUBLIC_MAP_TILE_DARK,
  });
}
