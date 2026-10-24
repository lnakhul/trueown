import { ImageResponse } from "next/og";

/** Link-preview card (1200×630) shared by the site, brand and owner previews. */
export const OG_SIZE = { width: 1200, height: 630 };

const AMBER = "#fbbf24";
const GREEN = "#34d399";

export function og_card({
  eyebrow,
  title,
  tag,
  tone,
  body,
}: {
  eyebrow?: string;
  title: string;
  tag?: string;
  tone?: "corporate" | "independent";
  body?: string;
}): ImageResponse {
  const accent = tone === "independent" ? GREEN : AMBER;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 72px",
          background: "linear-gradient(135deg, #09090b 0%, #18181b 100%)",
          color: "#fafafa",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 18,
              background: "#18181b",
              border: "2px solid rgba(255,255,255,0.08)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
            }}
          >
            <div style={{ width: 16, height: 16, background: AMBER, transform: "rotate(45deg)", borderRadius: 3 }} />
            <div style={{ width: 16, height: 16, background: GREEN, borderRadius: 999 }} />
          </div>
          <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: -0.5 }}>TrueOwn</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          {eyebrow && <div style={{ fontSize: 30, color: "#a1a1aa" }}>{eyebrow}</div>}
          <div style={{ fontSize: title.length > 28 ? 68 : 84, fontWeight: 700, letterSpacing: -2, lineHeight: 1.05 }}>{title}</div>
          {tag && (
            <div style={{ display: "flex" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "10px 24px",
                  borderRadius: 999,
                  background: tone === "independent" ? "rgba(52,211,153,0.14)" : "rgba(245,158,11,0.16)",
                  color: accent,
                  fontSize: 32,
                  fontWeight: 700,
                }}
              >
                <div
                  style={
                    tone === "independent"
                      ? { width: 16, height: 16, borderRadius: 999, background: accent }
                      : { width: 15, height: 15, background: accent, transform: "rotate(45deg)", borderRadius: 2 }
                  }
                />
                {tag}
              </div>
            </div>
          )}
          {body && <div style={{ fontSize: 30, color: "#d4d4d8", lineHeight: 1.35, maxWidth: 1000 }}>{body}</div>}
        </div>

        <div style={{ fontSize: 26, color: "#71717a" }}>gettrueown.com</div>
      </div>
    ),
    OG_SIZE,
  );
}
