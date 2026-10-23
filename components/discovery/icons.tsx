/** Inline SVG icons for the discovery UI. All are decorative (aria-hidden). */

interface IconProps {
  className?: string;
}

const STROKE_PROPS = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function NavigateIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className} {...STROKE_PROPS}>
      <polygon points="3 11 22 2 13 21 11 13 3 11" />
    </svg>
  );
}

export function AlertIcon({ className = "h-4 w-4 shrink-0" }: IconProps) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className} {...STROKE_PROPS}>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

export function ChevronRightIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className} {...STROKE_PROPS}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

export function CloseIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className} {...STROKE_PROPS}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function SearchIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className} {...STROKE_PROPS}>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

export function LocateIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className} {...STROKE_PROPS}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
      <circle cx="12" cy="12" r="7" />
    </svg>
  );
}

export function StorefrontIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className} {...STROKE_PROPS}>
      <path d="M3 9 4.5 4h15L21 9" />
      <path d="M3 9h18v1.5a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z" />
      <path d="M5 13.5V20h14v-6.5" />
      <path d="M10 20v-4h4v4" />
    </svg>
  );
}

/** A mid-stride walking figure drawn on a 24-unit grid; place it inside a larger SVG with `transform`. */
export function WalkingFigurePaths() {
  return (
    <g fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="13.5" cy="4" r="1.9" fill="currentColor" stroke="none" />
      <path d="M12.6 7.6 11 13.4" />
      <path d="M12.4 8.6 9.2 11.2" />
      <path d="M12.4 8.6 15.4 11" />
      <path d="M11 13.4 8.4 20" />
      <path d="M11 13.4 14 16.2 13.4 20.4" />
    </g>
  );
}
