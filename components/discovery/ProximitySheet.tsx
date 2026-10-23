"use client";

import {
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  type PointerSample,
  type SheetSnap,
  apply_drag_resistance,
  measure_release_velocity,
  resolve_sheet_snap,
  snap_height,
} from "@/lib/ui/sheet-snap";
import { ChevronRightIcon, CloseIcon } from "./icons";
import { prefers_reduced_motion } from "./use-media-query";

/** Settle animation length; the easing reads like a spring without a physics library. */
const SETTLE_DURATION_MS = 380;
const SETTLE_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
/** Pointer travel (px) before a press on the header turns into a drag. */
const DRAG_START_THRESHOLD = 4;

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ProximitySheetProps {
  is_open: boolean;
  /** Called once the close animation has finished. */
  on_close: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
}

interface DragSession {
  pointer_id: number;
  start_y: number;
  start_height: number;
  is_dragging: boolean;
  samples: PointerSample[];
}

/**
 * Mobile bottom sheet (below `md`): a modal dialog that opens at a ~45% peek,
 * drags to ~90%, and snaps with velocity awareness. Esc, the scrim and a
 * downward fling close it; focus is trapped inside and restored to the opener.
 */
export default function ProximitySheet({ is_open, on_close, title, subtitle, children }: ProximitySheetProps) {
  const sheet_ref = useRef<HTMLDivElement>(null);
  const scrim_ref = useRef<HTMLDivElement>(null);
  const visible_height_ref = useRef(0);
  const drag_session_ref = useRef<DragSession | null>(null);
  const suppress_click_ref = useRef(false);
  const is_closing_ref = useRef(false);
  const close_timer_ref = useRef<number | null>(null);
  const [viewport_height, set_viewport_height] = useState(0);
  const [snap, set_snap] = useState<SheetSnap>("peek");
  const viewport_height_ref = useRef(0);

  const full_height = snap_height("full", viewport_height);
  const peek_height = snap_height("peek", viewport_height);

  /** Moves the sheet (and fades the scrim) without a React render. */
  const apply_position = useCallback((height: number, animate: boolean) => {
    visible_height_ref.current = height;
    const sheet = sheet_ref.current;
    const scrim = scrim_ref.current;
    const current_viewport = viewport_height_ref.current;
    if (!sheet || current_viewport === 0) return;
    const full = snap_height("full", current_viewport);
    const transition = animate && !prefers_reduced_motion() ? `${SETTLE_DURATION_MS}ms ${SETTLE_EASING}` : "0ms";
    sheet.style.transition = `transform ${transition}`;
    sheet.style.transform = `translate3d(0, ${Math.max(0, full - height)}px, 0)`;
    if (scrim) {
      const peek = snap_height("peek", current_viewport);
      scrim.style.transition = `opacity ${transition}`;
      scrim.style.opacity = String(Math.min(1, Math.max(0, height / peek)));
    }
  }, []);

  const request_close = useCallback(() => {
    if (is_closing_ref.current) return;
    is_closing_ref.current = true;
    apply_position(0, true);
    close_timer_ref.current = window.setTimeout(on_close, prefers_reduced_motion() ? 0 : SETTLE_DURATION_MS);
  }, [apply_position, on_close]);

  const settle_at = useCallback(
    (next_snap: SheetSnap) => {
      if (next_snap === "closed") {
        request_close();
        return;
      }
      set_snap(next_snap);
      apply_position(snap_height(next_snap, viewport_height_ref.current), true);
    },
    [apply_position, request_close],
  );

  // Track the viewport so snap points follow rotation and browser chrome changes.
  useLayoutEffect(() => {
    if (!is_open) return;
    const sync_viewport = () => {
      viewport_height_ref.current = window.innerHeight;
      set_viewport_height(window.innerHeight);
    };
    sync_viewport();
    window.addEventListener("resize", sync_viewport);
    return () => window.removeEventListener("resize", sync_viewport);
  }, [is_open]);

  // Open: start hidden, then animate up to the peek snap point.
  useLayoutEffect(() => {
    if (!is_open || viewport_height === 0) return;
    if (visible_height_ref.current === 0 && !is_closing_ref.current) {
      apply_position(0, false);
      // Reading layout commits the hidden position, so the next change transitions.
      sheet_ref.current?.getBoundingClientRect();
      set_snap("peek");
      apply_position(snap_height("peek", viewport_height_ref.current), true);
      return;
    }
    // Viewport resized while open: hold the current snap point.
    if (!is_closing_ref.current && drag_session_ref.current === null) {
      apply_position(snap_height(snap, viewport_height), false);
    }
    // `snap` is read, not tracked: settling already positions the sheet.
  }, [is_open, viewport_height, apply_position]);

  // Modal side effects: focus in and back out, body scroll lock, inert page behind.
  useEffect(() => {
    if (!is_open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const page_main = document.getElementById("main-content");
    const previous_overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    page_main?.setAttribute("inert", "");
    sheet_ref.current?.focus({ preventScroll: true });

    return () => {
      if (close_timer_ref.current !== null) window.clearTimeout(close_timer_ref.current);
      document.body.style.overflow = previous_overflow;
      page_main?.removeAttribute("inert");
      visible_height_ref.current = 0;
      is_closing_ref.current = false;
      drag_session_ref.current = null;
      opener?.focus({ preventScroll: true });
    };
  }, [is_open]);

  /** Esc closes; Tab wraps so focus cannot leave the dialog. */
  function handle_keydown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      request_close();
      return;
    }
    if (event.key !== "Tab" || !sheet_ref.current) return;
    const focusable = Array.from(sheet_ref.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === sheet_ref.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handle_pointer_down(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (is_closing_ref.current) return;
    drag_session_ref.current = {
      pointer_id: event.pointerId,
      start_y: event.clientY,
      start_height: visible_height_ref.current,
      is_dragging: false,
      samples: [{ y: event.clientY, time: event.timeStamp }],
    };
  }

  function handle_pointer_move(event: ReactPointerEvent<HTMLDivElement>): void {
    const session = drag_session_ref.current;
    if (!session || session.pointer_id !== event.pointerId) return;
    const delta_y = event.clientY - session.start_y;
    if (!session.is_dragging) {
      if (Math.abs(delta_y) < DRAG_START_THRESHOLD) return;
      // Capture only once it is a drag, so a plain tap still clicks the header buttons.
      session.is_dragging = true;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // The pointer may already be gone (e.g. released mid-gesture); dragging still works without capture.
      }
    }
    session.samples.push({ y: event.clientY, time: event.timeStamp });
    if (session.samples.length > 12) session.samples.shift();
    apply_position(apply_drag_resistance(session.start_height - delta_y, viewport_height_ref.current), false);
  }

  function handle_pointer_end(event: ReactPointerEvent<HTMLDivElement>): void {
    const session = drag_session_ref.current;
    if (!session || session.pointer_id !== event.pointerId) return;
    drag_session_ref.current = null;
    if (!session.is_dragging) return;
    suppress_click_ref.current = true;
    window.setTimeout(() => {
      suppress_click_ref.current = false;
    }, 0);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (event.type === "pointercancel") {
      settle_at(snap);
      return;
    }
    const velocity = measure_release_velocity(session.samples);
    settle_at(resolve_sheet_snap(visible_height_ref.current, velocity, viewport_height_ref.current));
  }

  function toggle_expanded(): void {
    if (suppress_click_ref.current) return;
    settle_at(snap === "full" ? "peek" : "full");
  }

  if (!is_open || typeof document === "undefined") return null;

  return createPortal(
    <div className="md:hidden">
      <div
        ref={scrim_ref}
        aria-hidden="true"
        onClick={request_close}
        className="fixed inset-0 z-40 bg-black/60 opacity-0"
      />
      <div
        ref={sheet_ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="proximity-sheet-title"
        tabIndex={-1}
        onKeyDown={handle_keydown}
        style={{ height: full_height || "90vh", transform: "translate3d(0, 100%, 0)" }}
        className="fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-3xl bg-surface-card shadow-lift outline-none will-change-transform [box-shadow:inset_0_1px_0_rgb(255_255_255/0.08),0_-16px_48px_-12px_rgb(0_0_0/0.7)]"
      >
        {/* Drag zone: the grabber and title row. */}
        <div
          onPointerDown={handle_pointer_down}
          onPointerMove={handle_pointer_move}
          onPointerUp={handle_pointer_end}
          onPointerCancel={handle_pointer_end}
          className="shrink-0 cursor-grab touch-none select-none px-4 pb-2 pt-2 active:cursor-grabbing"
        >
          <div aria-hidden="true" className="mx-auto mb-1.5 h-1.5 w-10 rounded-full bg-zinc-600" />
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <h2 id="proximity-sheet-title" className="truncate text-lg font-semibold tracking-tight text-zinc-50">
                {title}
              </h2>
              {subtitle && <p className="truncate text-xs text-zinc-400">{subtitle}</p>}
            </div>
            <button
              type="button"
              onClick={toggle_expanded}
              aria-label={snap === "full" ? "Collapse panel" : "Expand panel"}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
            >
              <ChevronRightIcon
                className={`h-5 w-5 transition-transform duration-300 ${snap === "full" ? "rotate-90" : "-rotate-90"}`}
              />
            </button>
            <button
              type="button"
              onClick={() => {
                if (!suppress_click_ref.current) request_close();
              }}
              aria-label="Close"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-zinc-300 transition-colors hover:bg-white/[0.1] hover:text-zinc-50"
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-2"
          style={{
            // At peek the lower part of the sheet is off-screen; pad so everything can scroll into view.
            paddingBottom: `calc(env(safe-area-inset-bottom) + 1.5rem + ${snap === "peek" ? full_height - peek_height : 0}px)`,
          }}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
