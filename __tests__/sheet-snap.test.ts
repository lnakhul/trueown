import {
  SHEET_FLING_VELOCITY,
  apply_drag_resistance,
  measure_release_velocity,
  resolve_sheet_snap,
  snap_height,
} from "@/lib/ui/sheet-snap";

const VIEWPORT = 800;
const PEEK = snap_height("peek", VIEWPORT); // 360
const FULL = snap_height("full", VIEWPORT); // 720

describe("snap_height", () => {
  it("maps snap points to ~45% and ~90% of the viewport", () => {
    expect(snap_height("closed", VIEWPORT)).toBe(0);
    expect(PEEK).toBe(360);
    expect(FULL).toBe(720);
  });
});

describe("resolve_sheet_snap (slow release)", () => {
  it("settles on the nearest snap point", () => {
    expect(resolve_sheet_snap(PEEK + 40, 0, VIEWPORT)).toBe("peek");
    expect(resolve_sheet_snap(FULL - 60, 0, VIEWPORT)).toBe("full");
    expect(resolve_sheet_snap(PEEK + 200, 0, VIEWPORT)).toBe("full");
    expect(resolve_sheet_snap(100, 0, VIEWPORT)).toBe("closed");
  });

  it("projects gentle motion before choosing", () => {
    // 520px is nearer peek at rest, but a steady upward drift carries it to full.
    expect(resolve_sheet_snap(520, 0, VIEWPORT)).toBe("peek");
    expect(resolve_sheet_snap(520, -0.4, VIEWPORT)).toBe("full");
    // 200px is nearer peek, but a steady downward drift closes it.
    expect(resolve_sheet_snap(200, 0, VIEWPORT)).toBe("peek");
    expect(resolve_sheet_snap(200, 0.4, VIEWPORT)).toBe("closed");
  });
});

describe("resolve_sheet_snap (fling)", () => {
  it("a downward fling from peek closes the sheet", () => {
    expect(resolve_sheet_snap(PEEK, SHEET_FLING_VELOCITY, VIEWPORT)).toBe("closed");
    expect(resolve_sheet_snap(PEEK - 20, 2, VIEWPORT)).toBe("closed");
  });

  it("a downward fling from full drops one step to peek", () => {
    expect(resolve_sheet_snap(FULL, 1.2, VIEWPORT)).toBe("peek");
    expect(resolve_sheet_snap(FULL - 100, 1.2, VIEWPORT)).toBe("peek");
  });

  it("an upward fling moves one step up, even from just above peek", () => {
    expect(resolve_sheet_snap(PEEK + 10, -1, VIEWPORT)).toBe("full");
    expect(resolve_sheet_snap(PEEK, -1, VIEWPORT)).toBe("full");
    expect(resolve_sheet_snap(FULL, -1, VIEWPORT)).toBe("full");
  });
});

describe("apply_drag_resistance", () => {
  it("passes through within range and resists past full", () => {
    expect(apply_drag_resistance(400, VIEWPORT)).toBe(400);
    expect(apply_drag_resistance(-30, VIEWPORT)).toBe(0);
    expect(apply_drag_resistance(FULL + 100, VIEWPORT)).toBe(FULL + 20);
  });
});

describe("measure_release_velocity", () => {
  it("uses only the most recent samples", () => {
    const samples = [
      { y: 0, time: 0 },
      { y: 10, time: 250 }, // stale: outside the 100ms window from the last sample
      { y: 20, time: 350 },
      { y: 80, time: 400 },
    ];
    expect(measure_release_velocity(samples)).toBeCloseTo((80 - 20) / 50);
  });

  it("is zero with no movement or one sample", () => {
    expect(measure_release_velocity([])).toBe(0);
    expect(measure_release_velocity([{ y: 5, time: 10 }])).toBe(0);
  });
});
