import { describe, expect, it } from "vitest";

import { GAP, MARGIN, place } from "./placement";

const viewport = { width: 1440, height: 900 };
const size = { width: 300, height: 140 };

describe("place", () => {
  it("hangs the bubble under the target, centred, tail on the centre", () => {
    const p = place({ left: 600, top: 100, width: 120, height: 40 }, size, viewport, "bottom");
    expect(p).toEqual({ x: 510, y: 140 + GAP, side: "bottom", tail: 150 });
  });

  it("flips to the other side when the preferred one has no room", () => {
    const p = place({ left: 600, top: 820, width: 120, height: 40 }, size, viewport, "bottom");
    expect(p.side).toBe("top");
    expect(p.y).toBe(820 - GAP - size.height);
  });

  it("clamps at the edge and keeps the tail pointing at the target", () => {
    const p = place({ left: 1400, top: 100, width: 30, height: 30 }, size, viewport, "bottom");
    expect(p.x).toBe(viewport.width - MARGIN - size.width);
    // The target's centre is at 1415: 1415 - 1128 = 287, pulled off the corner.
    expect(p.tail).toBe(size.width - 26);
  });

  it("goes to the right of a sidebar row", () => {
    const p = place({ left: 12, top: 200, width: 216, height: 32 }, size, viewport, "right");
    expect(p).toMatchObject({ side: "right", x: 228 + GAP });
    expect(p.tail).toBe(216 - p.y);
  });
});
