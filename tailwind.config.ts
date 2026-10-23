import type { Config } from "tailwindcss";
import { fontFamily } from "tailwindcss/defaultTheme";

/**
 * Dark design tokens. Surfaces use zinc (950 page, 900 cards) with 6% white hairlines;
 * `corporate` (amber) marks Tier 1/2 brands and `independent` (emerald) marks Tier 3.
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          page: "#09090b", // zinc-950
          card: "#18181b", // zinc-900
          raised: "#27272a", // zinc-800
        },
        hairline: "rgb(255 255 255 / 0.06)",
        corporate: {
          DEFAULT: "#fbbf24", // amber-400
          strong: "#f59e0b", // amber-500
          muted: "rgb(245 158 11 / 0.12)",
          ring: "rgb(245 158 11 / 0.28)",
        },
        independent: {
          DEFAULT: "#34d399", // emerald-400
          muted: "rgb(52 211 153 / 0.12)",
          ring: "rgb(52 211 153 / 0.28)",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", ...fontFamily.sans],
      },
      boxShadow: {
        hairline: "inset 0 0 0 1px rgb(255 255 255 / 0.06)",
        lift: "0 1px 1px rgb(0 0 0 / 0.25), 0 4px 8px -2px rgb(0 0 0 / 0.35), 0 16px 32px -8px rgb(0 0 0 / 0.45)",
      },
      transitionTimingFunction: {
        // Slight overshoot that reads like a spring without a physics library.
        spring: "cubic-bezier(0.32, 0.72, 0, 1)",
      },
    },
  },
  plugins: [],
};

export default config;
