import { describe, expect, it } from "vitest";

import {
  buttonClass,
  countdownPhase,
  formatDateTimeAs,
  formatRemaining,
  listboxIndex,
  menuPosition,
  rovingIndex,
  scrollEdges,
} from "./ui";

// Fixed local date-time: the formatters work on local getters, so building the
// date from local parts keeps the test free of any timezone assumption.
const noon = new Date(2026, 8, 7, 14, 5).toISOString(); // 2026-09-07 14:05 local
const morning = new Date(2026, 8, 7, 9, 5).toISOString();

describe("formatDateTimeAs", () => {
  it("writes the ISO format by default", () => {
    expect(formatDateTimeAs(noon, "iso")).toBe("2026-09-07 14:05");
  });

  it("writes the European format with dots", () => {
    expect(formatDateTimeAs(noon, "eu")).toBe("07.09.2026 14:05");
  });

  it("writes the UK format with slashes", () => {
    expect(formatDateTimeAs(noon, "uk")).toBe("07/09/2026 14:05");
  });

  it("writes the US format month-first, on a 12-hour clock", () => {
    expect(formatDateTimeAs(noon, "us")).toBe("09/07/2026 2:05 PM");
    expect(formatDateTimeAs(morning, "us")).toBe("09/07/2026 9:05 AM");
  });

  it("writes midnight as 12 AM in the US format", () => {
    expect(formatDateTimeAs(new Date(2026, 8, 7, 0, 30).toISOString(), "us")).toBe(
      "09/07/2026 12:30 AM",
    );
  });
});

describe("buttonClass", () => {
  it("composes the variant, the size and the shared chrome", () => {
    const cls = buttonClass("primary", "md");
    expect(cls).toContain("bg-accent");
    expect(cls).toContain("text-on-fill");
    expect(cls).toContain("h-8.5");
    expect(cls).toContain("rounded-full");
  });

  it("defaults to the primary variant at the md size", () => {
    expect(buttonClass()).toBe(buttonClass("primary", "md"));
  });

  it("keeps the variants apart", () => {
    expect(buttonClass("secondary")).toContain("border-line-strong");
    expect(buttonClass("secondary")).not.toContain("bg-accent");
    expect(buttonClass("danger")).toContain("bg-danger");
    expect(buttonClass("ghost")).toContain("text-fg-muted");
    expect(buttonClass("subtle")).toContain("bg-surface-3");
  });

  it("keeps the sizes apart", () => {
    expect(buttonClass("primary", "sm")).toContain("h-7");
    expect(buttonClass("primary", "lg")).toContain("h-10");
  });

  it("appends the extra classes last, so they win", () => {
    expect(buttonClass("primary", "md", "w-full")).toMatch(/w-full$/);
  });

  it("drops an empty extra instead of leaving a trailing space", () => {
    expect(buttonClass("primary", "md", "")).toBe(buttonClass("primary", "md", "").trim());
  });
});

describe("menuPosition", () => {
  const viewport = { width: 1440, height: 900 };
  const rect = (top: number, height = 32, left = 600, width = 32) => ({
    top,
    bottom: top + height,
    left,
    right: left + width,
  });

  it("drops under the trigger when there is room below", () => {
    const p = menuPosition(rect(100), viewport, "end");
    expect(p.up).toBe(false);
    expect(p.top).toBe(138); // bottom + 6
    expect(p.bottom).toBeUndefined();
  });

  it("flips above a trigger sitting low on the viewport", () => {
    const p = menuPosition(rect(820), viewport, "start");
    expect(p.up).toBe(true);
    expect(p.bottom).toBe(86); // height - top + 6
    expect(p.top).toBeUndefined();
  });

  it("stays downward for a trigger in the upper half, however tall the panel", () => {
    // A tall panel on a short viewport: the flip would put the menu off the
    // top, so the trigger must be past the middle for the flip to happen.
    const p = menuPosition(rect(200), { width: 1440, height: 420 }, "end");
    expect(p.up).toBe(false);
  });

  it("anchors on the right edge for align=end and on the left for align=start", () => {
    expect(menuPosition(rect(100, 32, 600, 40), viewport, "end").left).toBe(640);
    expect(menuPosition(rect(100, 32, 600, 40), viewport, "start").left).toBe(600);
  });

  it("takes the assumed panel height into account", () => {
    const low = rect(600);
    expect(menuPosition(low, viewport, "end", 100).up).toBe(false);
    expect(menuPosition(low, viewport, "end", 400).up).toBe(true);
  });
});

describe("scrollEdges", () => {
  it("reports no edge when everything fits", () => {
    expect(scrollEdges(0, 300, 300)).toEqual({ left: false, right: false });
  });

  it("fades the right edge at the start of a scrollable strip", () => {
    expect(scrollEdges(0, 600, 390)).toEqual({ left: false, right: true });
  });

  it("fades both edges in the middle", () => {
    expect(scrollEdges(100, 600, 390)).toEqual({ left: true, right: true });
  });

  it("fades only the left edge at the end", () => {
    expect(scrollEdges(210, 600, 390)).toEqual({ left: true, right: false });
  });

  it("absorbs the sub-pixel scroll positions of a fractional viewport", () => {
    // A zoomed page lands half a pixel short of either end; that is not an
    // edge the reader can scroll towards, so it must not draw a fade.
    expect(scrollEdges(0.5, 600.4, 390)).toEqual({ left: false, right: true });
    expect(scrollEdges(210.4, 600.4, 390)).toEqual({ left: true, right: false });
  });
});

describe("formatRemaining", () => {
  it("writes minutes and seconds, zero-padded on the seconds", () => {
    expect(formatRemaining(14 * 60_000 + 32_000)).toBe("14:32");
    expect(formatRemaining(9_000)).toBe("0:09");
  });

  it("adds the hours only when there are any, and pads the minutes then", () => {
    expect(formatRemaining(3_600_000 + 5 * 60_000)).toBe("1:05:00");
    expect(formatRemaining(59 * 60_000)).toBe("59:00");
  });

  it("rounds up, so the last second is shown as one and not as zero", () => {
    expect(formatRemaining(1)).toBe("0:01");
    expect(formatRemaining(1_001)).toBe("0:02");
  });

  it("never counts into the negative: the server closes the attempt", () => {
    expect(formatRemaining(0)).toBe("0:00");
    expect(formatRemaining(-90_000)).toBe("0:00");
  });
});

describe("countdownPhase", () => {
  it("is normal above the evaluation's own threshold", () => {
    expect(countdownPhase(10 * 60_000, 300)).toBe("normal");
  });

  it("warns from the threshold down", () => {
    expect(countdownPhase(300_000, 300)).toBe("warning");
    expect(countdownPhase(90_000, 300)).toBe("warning");
  });

  it("turns danger under a minute, whatever the threshold says", () => {
    expect(countdownPhase(60_000, 300)).toBe("danger");
    expect(countdownPhase(30_000, 30)).toBe("danger");
    // A threshold under a minute never gets its own warning phase; the
    // stricter rule wins rather than the configured one.
    expect(countdownPhase(45_000, 30)).toBe("danger");
  });

  it("is over at the deadline and past it", () => {
    expect(countdownPhase(0, 300)).toBe("over");
    expect(countdownPhase(-1, 300)).toBe("over");
  });
});

describe("listboxIndex", () => {
  it("moves with the arrows and wraps at both ends", () => {
    expect(listboxIndex("ArrowDown", 0, 3)).toBe(1);
    expect(listboxIndex("ArrowDown", 2, 3)).toBe(0);
    expect(listboxIndex("ArrowUp", 0, 3)).toBe(2);
    expect(listboxIndex("ArrowUp", 2, 3)).toBe(1);
  });

  it("lands on the first or the last row when nothing is highlighted (the menu)", () => {
    expect(listboxIndex("ArrowDown", -1, 3)).toBe(0);
    expect(listboxIndex("ArrowUp", -1, 3)).toBe(2);
  });

  it("keeps the arrows on an empty list, so the caller still prevents the caret move", () => {
    expect(listboxIndex("ArrowDown", 0, 0)).toBe(0);
    expect(listboxIndex("ArrowUp", 0, 0)).toBe(0);
  });

  it("leaves Home and End to a text field unless the list owns them", () => {
    expect(listboxIndex("Home", 2, 3)).toBeNull();
    expect(listboxIndex("End", 0, 3)).toBeNull();
    expect(listboxIndex("Home", 2, 3, { ends: true })).toBe(0);
    expect(listboxIndex("End", 0, 3, { ends: true })).toBe(2);
    expect(listboxIndex("End", 0, 0, { ends: true })).toBe(0);
  });

  it("does not own any other key", () => {
    expect(listboxIndex("Enter", 1, 3, { ends: true })).toBeNull();
    expect(listboxIndex("ArrowRight", 1, 3, { ends: true })).toBeNull();
  });
});

describe("rovingIndex", () => {
  it("moves right and left with wrap, and jumps to the ends", () => {
    expect(rovingIndex("ArrowRight", 0, 3)).toBe(1);
    expect(rovingIndex("ArrowRight", 2, 3)).toBe(0);
    expect(rovingIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(rovingIndex("Home", 2, 3)).toBe(0);
    expect(rovingIndex("End", 0, 3)).toBe(2);
  });

  it("owns nothing on an empty strip, nor the vertical arrows", () => {
    expect(rovingIndex("ArrowRight", 0, 0)).toBeNull();
    expect(rovingIndex("ArrowDown", 0, 3)).toBeNull();
  });
});
