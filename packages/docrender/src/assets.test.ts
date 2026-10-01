import { describe, expect, it } from "vitest";

import { journalAssetUrl } from "./assets.js";

describe("assets", () => {
  it("are served under the classroom, each segment encoded", () => {
    expect(journalAssetUrl("c1", "010-basics/images/a b#1.png")).toBe(
      "/app/api/classrooms/c1/journal/assets/010-basics/images/a%20b%231.png",
    );
  });
});
