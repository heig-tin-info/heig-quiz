import { describe, expect, it } from "vitest";

import { ASSET_REF, markdownImages } from "./images.js";

describe("markdownImages", () => {
  it("reads images as the renderers do: inline, by reference, raw HTML; never in code or escaped", () => {
    const text = "![a](asset:x1?w=50) ![b][r] <img src=y> `![c](z)` \\![d](w)\n\n```\n<img src=q>\n```\n\n[r]: https://x.org/b.png";
    expect(markdownImages(text)).toEqual([
      { kind: "markdown", href: "asset:x1?w=50", raw: "![a](asset:x1?w=50)" },
      { kind: "markdown", href: "https://x.org/b.png", raw: "![b][r]" },
      { kind: "html", raw: "<img src=y>" },
    ]);
  });
});

describe("ASSET_REF", () => {
  it("is an asset id with an optional query, and nothing else", () => {
    expect(ASSET_REF.exec("asset:ab_1?w=25")?.slice(1)).toEqual(["ab_1", "w=25"]);
    expect(ASSET_REF.test("asset:../x")).toBe(false);
    expect(ASSET_REF.test("https://x.org/asset:a")).toBe(false);
  });
});
