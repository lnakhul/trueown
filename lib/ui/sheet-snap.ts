/**
 * Pure snap math for the mobile proximity bottom sheet.
 *
 * Positions are measured as the sheet's visible height in pixels (0 = fully hidden).
 * Velocities are in px/ms with the pointer's convention: positive = moving down (closing).
 */

export type SheetSnap = "closed" | "peek" | "full";

/** Visible height of each open snap point as a share of the viewport height. */
export const SHEET_SNAP_FRACTIONS: Record<Exclude<SheetSnap, "closed">, number> = {
  peek: 0.45,
  full: 0.9,
};

/** A release faster than this (px/ms) is a fling: it moves one snap point in its direction. */
export const SHEET_FLING_VELOCITY = 0.5;

/** How far ahead (ms) a slow release is projected before picking the nearest snap point. */
export const SHEET_PROJECTION_MS = 120;

/** Only pointer samples this recent count toward the release velocity. */
export const SHEET_VELOCITY_WINDOW_MS = 100;

const SNAP_ORDER: readonly SheetSnap[] = ["closed", "peek", "full"];

/** Visible height in px for a snap point at a given viewport height. */
export function snap_height(snap: SheetSnap, viewport_height: number): number {
  return snap === "closed" ? 0 : Math.round(SHEET_SNAP_FRACTIONS[snap] * viewport_height);
}

/** Picks where the sheet settles after the user lets go of the drag handle. */
export function resolve_sheet_snap(
  visible_height: number,
  velocity: number,
  viewport_height: number,
): SheetSnap {
  const heights = SNAP_ORDER.map((snap) => snap_height(snap, viewport_height));

  if (Math.abs(velocity) >= SHEET_FLING_VELOCITY) {
    if (velocity > 0) {
      // Downward fling: the highest snap point strictly below the current position.
      for (let index = SNAP_ORDER.length - 1; index >= 0; index -= 1) {
        if (heights[index]! < visible_height - 1) return SNAP_ORDER[index]!;
      }
      return "closed";
    }
    // Upward fling: the lowest snap point strictly above the current position.
    for (let index = 0; index < SNAP_ORDER.length; index += 1) {
      if (heights[index]! > visible_height + 1) return SNAP_ORDER[index]!;
    }
    return "full";
  }

  // Slow release: project the motion briefly, then take the nearest snap point.
  const projected_height = visible_height - velocity * SHEET_PROJECTION_MS;
  let nearest_index = 0;
  heights.forEach((height, index) => {
    if (Math.abs(height - projected_height) < Math.abs(heights[nearest_index]! - projected_height)) {
      nearest_index = index;
    }
  });
  return SNAP_ORDER[nearest_index]!;
}

/** Dragging past the top snap point meets increasing resistance instead of a hard stop. */
export function apply_drag_resistance(visible_height: number, viewport_height: number): number {
  const max_height = snap_height("full", viewport_height);
  if (visible_height <= max_height) return Math.max(0, visible_height);
  return max_height + (visible_height - max_height) * 0.2;
}

export interface PointerSample {
  /** Pointer clientY in px. */
  y: number;
  /** Timestamp in ms (e.g. PointerEvent.timeStamp). */
  time: number;
}

/** Release velocity (px/ms, positive = down) from the samples in the last window. */
export function measure_release_velocity(samples: readonly PointerSample[]): number {
  const latest = samples[samples.length - 1];
  if (!latest) return 0;
  const window_start = latest.time - SHEET_VELOCITY_WINDOW_MS;
  const earliest = samples.find((sample) => sample.time >= window_start) ?? latest;
  const elapsed = latest.time - earliest.time;
  return elapsed > 0 ? (latest.y - earliest.y) / elapsed : 0;
}
