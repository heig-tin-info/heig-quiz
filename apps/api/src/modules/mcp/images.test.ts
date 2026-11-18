/** The foreign images a question tool refuses (ADR-134): what the renderer would not draw. */
import { describe, expect, it } from "vitest";

import { imageIssues } from "./images.js";

const ID = "0b6f6a52-6c7e-4a0d-9e8e-3a3f1e2b4c5d";
/** The refused images of one prompt, by their raw source. */
const refused = (prompt: string) =>
  (imageIssues({ config: { prompt } }) ?? []).map((i) => i.message.slice(i.message.indexOf("Refused: ") + 9));

describe("imageIssues", () => {
  it("lets an uploaded asset through, sized or not, and a link that is not an image", () => {
    expect(refused(`![a](asset:${ID}) ![b](asset:${ID}?w=50) ![c](<asset:${ID}> "title")`)).toEqual([]);
    expect(refused("A [link](https://example.org) is not an image.")).toEqual([]);
  });

  it("refuses a URL, a data: URI, a path, a resolved reference and raw HTML", () => {
    expect(
      refused("![a](https://x.org/a.png) ![b](data:image/png;base64,AA) ![c](./c.svg) ![d][ref] <IMG src=x>\n\n[ref]: https://x.org/d.png"),
    ).toEqual(["![a](https://x.org/a.png)", "![b](data:image/png;base64,AA)", "![c](./c.svg)", "![d][ref]", "<IMG src=x>"]);
  });

  it("leaves what the renderers print as text: code spans, fences, escapes", () => {
    expect(refused("Write `<img src=x>` or `![a](https://x.org)` in HTML.")).toEqual([]);
    expect(refused("```html\n<img src=\"x.png\">\n![a](https://x.org/a.png)\n```")).toEqual([]);
    expect(refused("Not an image: \\![x](y)")).toEqual([]);
  });

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
