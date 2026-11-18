/** The foreign images a question tool refuses (ADR-134): what the renderer would not draw. */
import { describe, expect, it } from "vitest";

import { foreignImages, imageIssues } from "./images.js";

const ID = "0b6f6a52-6c7e-4a0d-9e8e-3a3f1e2b4c5d";

describe("foreignImages", () => {
  it("lets an uploaded asset through, sized or not", () => {
    expect(foreignImages(`![a](asset:${ID}) ![b](asset:${ID}?w=50) ![c](<asset:${ID}> "title")`)).toEqual([]);
    expect(foreignImages("A [link](https://example.org) is not an image.")).toEqual([]);
  });

  it("finds every other image: a URL, a data: URI, a path, a reference, raw HTML", () => {
    expect(
      foreignImages(
        "![a](https://x.org/a.png) ![b](data:image/png;base64,AA) ![c](./c.svg) ![d][ref] ![e][] <IMG src=x> ![f]()",
      ),
    ).toEqual([
      "![a](https://x.org/a.png",
      "![b](data:image/png;base64,AA",
      "![c](./c.svg",
      "![f](",
      "![d][ref]",
      "![e][]",
      "<IMG",
    ]);
  });
});

describe("imageIssues", () => {
  it("names each string of the config by its path, and the explanation", () => {
    const issues = imageIssues({
      config: { prompt: "ok", choices: [{ text: "![x](http://x.org/x.png)" }] },
      explanation: "<img src=y>",
    });
    expect(issues?.map((i) => i.path)).toEqual(["choices.0.text", "explanation"]);
    expect(issues?.[0]?.message).toContain("upload_asset");
    expect(imageIssues({ config: { prompt: `![a](asset:${ID})` } })).toBeNull();
    expect(imageIssues({})).toBeNull();
  });
});
