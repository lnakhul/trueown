"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ReactNode, useEffect, useId, useRef, useState } from "react";
import { SITE_NAV } from "@/lib/site";

/**
 * A menu button with the site's pages. Used on phones in the site header, and on
 * every screen size on the map page (where the logo opens it).
 */
export default function SiteMenu({
  children,
  label = "Menu",
  align = "right",
  className = "",
}: {
  children: ReactNode;
  label?: string;
  align?: "left" | "right";
  className?: string;
}) {
  const [is_open, set_is_open] = useState(false);
  const container_ref = useRef<HTMLDivElement>(null);
  const menu_id = useId();
  const pathname = usePathname();

  useEffect(() => set_is_open(false), [pathname]);

  useEffect(() => {
    if (!is_open) return;
    function close_outside(event: MouseEvent | TouchEvent): void {
      if (container_ref.current && !container_ref.current.contains(event.target as Node)) set_is_open(false);
    }
    function close_on_escape(event: KeyboardEvent): void {
      if (event.key === "Escape") set_is_open(false);
    }
    document.addEventListener("mousedown", close_outside);
    document.addEventListener("touchstart", close_outside, { passive: true });
    document.addEventListener("keydown", close_on_escape);
    return () => {
      document.removeEventListener("mousedown", close_outside);
      document.removeEventListener("touchstart", close_outside);
      document.removeEventListener("keydown", close_on_escape);
    };
  }, [is_open]);

  return (
    <div ref={container_ref} className={`relative ${className}`}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={is_open}
        aria-controls={menu_id}
        onClick={() => set_is_open((open) => !open)}
        className="flex min-h-11 min-w-11 items-center justify-center rounded-xl"
      >
        {children}
      </button>
      {is_open && (
        <nav
          id={menu_id}
          aria-label="Site"
          className={`absolute top-full z-50 mt-2 w-60 rounded-2xl border border-hairline bg-surface-raised p-2 shadow-lift ${
            align === "left" ? "left-0" : "right-0"
          }`}
        >
          <ul>
            {SITE_NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={pathname === item.href ? "page" : undefined}
                  className="flex min-h-11 items-center rounded-xl px-3 text-sm font-medium text-zinc-200 hover:bg-white/[0.06] aria-[current=page]:text-zinc-50 aria-[current=page]:bg-white/[0.06]"
                >
                  {item.label}
                </Link>
              </li>
            ))}
            <li className="mt-1 border-t border-hairline pt-1">
              <Link href="/claim" className="flex min-h-11 items-center rounded-xl px-3 text-sm text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100">
                Claim your business
              </Link>
            </li>
          </ul>
        </nav>
      )}
    </div>
  );
}
