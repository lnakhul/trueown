"use client";

import { KeyboardEvent, ReactNode, RefObject, useEffect, useRef } from "react";

interface SidePanelProps {
  is_open: boolean;
  on_close: () => void;
  heading_id: string;
  title: string;
  description: ReactNode;
  /** Receives focus when the panel opens (usually the first field). */
  initial_focus_ref: RefObject<HTMLElement>;
  children: ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled]), iframe';

/**
 * Right-hand dialog shared by the tip and report-an-error forms: scrim, slide-in
 * panel, focus moved in on open and restored on close, Escape to close, and Tab
 * kept inside. Stacks above the mobile bottom sheet (z-50).
 */
export default function SidePanel({
  is_open,
  on_close,
  heading_id,
  title,
  description,
  initial_focus_ref,
  children,
}: SidePanelProps) {
  const panel_ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!is_open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Wait a frame so the inputs are enabled and the panel is visible.
    const frame_id = window.requestAnimationFrame(() => initial_focus_ref.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame_id);
      opener?.focus();
    };
  }, [is_open, initial_focus_ref]);

  function handle_keydown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      on_close();
      return;
    }
    if (event.key !== "Tab" || !panel_ref.current) return;
    const focusable = panel_ref.current.querySelectorAll<HTMLElement>(FOCUSABLE);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <>
      {is_open && (
        <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-[2px]" onClick={on_close} aria-hidden="true" />
      )}
      <aside
        ref={panel_ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={heading_id}
        aria-hidden={!is_open}
        onKeyDown={handle_keydown}
        // `inert` removes the closed panel from the tab order and accessibility tree.
        {...(is_open ? {} : ({ inert: "" } as Record<string, string>))}
        className={`fixed inset-y-0 right-0 z-[70] w-full max-w-md overflow-y-auto overscroll-contain bg-surface-card shadow-lift [box-shadow:inset_1px_0_0_rgb(255_255_255/0.06),-24px_0_48px_-12px_rgb(0_0_0/0.6)] transition-[transform,visibility] duration-300 ease-spring ${
          is_open ? "visible translate-x-0" : "invisible translate-x-full"
        }`}
      >
        <div className="flex min-h-full flex-col gap-5 p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id={heading_id} className="text-xl font-semibold tracking-tight text-zinc-50">
                {title}
              </h2>
              <div className="mt-1 text-sm text-zinc-400">{description}</div>
            </div>
            <button
              type="button"
              onClick={on_close}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-zinc-300 transition-colors hover:bg-white/[0.1] hover:text-zinc-50"
              aria-label="Close panel"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div className="flex flex-1 flex-col">{children}</div>
        </div>
      </aside>
    </>
  );
}
