import { OG_SIZE, og_card } from "@/lib/og-card";

export const alt = "TrueOwn: see who really owns the shops around you";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image() {
  return og_card({
    title: "Who really owns the shops around you?",
    body: "Private equity, venture capital or independent: see the owners behind your neighborhood spots, and find independent alternatives nearby.",
  });
}
