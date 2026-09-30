import { describe, expect, it } from "vitest";

import { assetContentType, journalAssetUrl } from "./assets.js";

describe("assets", () => {
  it("are served under the classroom, each segment encoded", () => {
    expect(journalAssetUrl("c1", "010-basics/images/a b#1.png")).toBe(
      "/app/api/classrooms/c1/journal/assets/010-basics/images/a%20b%231.png",
    );
  });

  it("take their content type from the extension, octet-stream otherwise", () => {
    expect(assetContentType("images/P.SVG")).toBe("image/svg+xml");
    expect(assetContentType("handout.pdf")).toBe("application/pdf");
    expect(assetContentType("archive.tar.xz")).toBe("application/octet-stream");
    expect(assetContentType("Makefile")).toBe("application/octet-stream");
  });
});
