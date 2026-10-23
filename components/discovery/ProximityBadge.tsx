import { PROXIMITY_RADIUS_METERS, format_proximity, proximity_share } from "@/lib/proximity-format";
import { WalkingFigurePaths } from "./icons";

interface ProximityBadgeProps {
  distance_meters: number;
  /** "compact" drops the meters line, for tight rows. */
  variant?: "default" | "compact";
}

const RING_RADIUS = 15;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * Walking-time badge: a walking figure inside a radial arc that fills with
 * distance as a share of the 1500m search radius, plus a readable label.
 */
export default function ProximityBadge({ distance_meters, variant = "default" }: ProximityBadgeProps) {
  const { minutes, meters } = format_proximity(distance_meters);
  const share = proximity_share(meters);
  const arc_length = Math.max(share * RING_CIRCUMFERENCE, 1.5);

  return (
    <div className="flex items-center gap-2.5">
      <svg aria-hidden="true" viewBox="0 0 36 36" className="h-9 w-9 shrink-0 text-independent">
        <circle cx="18" cy="18" r={RING_RADIUS} fill="none" stroke="currentColor" strokeOpacity={0.14} strokeWidth={2.5} />
        <circle
          cx="18"
          cy="18"
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={`${arc_length} ${RING_CIRCUMFERENCE}`}
          transform="rotate(-90 18 18)"
        />
        <g transform="translate(9.6 9.2) scale(0.7)">
          <WalkingFigurePaths />
        </g>
      </svg>
      <p className="leading-tight">
        <span className="block text-sm font-semibold text-zinc-50">{minutes} min walk</span>
        {variant === "default" && <span className="block text-xs text-zinc-400">{meters}m away</span>}
        <span className="sr-only">
          {variant === "compact" ? `, ${meters} meters away` : ""}, within the {PROXIMITY_RADIUS_METERS} meter search radius
        </span>
      </p>
    </div>
  );
}
