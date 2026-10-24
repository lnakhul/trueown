/** The TrueOwn mark: an amber diamond (corporate-backed) beside a green dot (independent). */
export default function BrandMark({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 32 32" className={`shrink-0 ${className}`}>
      <rect x="1" y="1" width="30" height="30" rx="9" fill="#18181b" />
      <rect x="1.5" y="1.5" width="29" height="29" rx="8.5" fill="none" stroke="white" strokeOpacity="0.08" />
      <rect x="8.5" y="12" width="7" height="7" rx="1.2" transform="rotate(45 12 15.5)" fill="#fbbf24" />
      <circle cx="21" cy="17" r="3.6" fill="#34d399" />
    </svg>
  );
}
