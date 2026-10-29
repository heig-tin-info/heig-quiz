import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { code, heading, list, markdown, points, separator, tests, type Document } from "./document.js";
import { fenceFor, markdownBody, renderMarkdown, sha256 } from "./markdown.js";

const provenance = {
  kind: "item-answers",
  version: 1,
  source: { evaluationId: "e1", itemId: "i1" },
  attempts: ["a1", "a2"],
  generatedAt: "2026-10-29T10:00:00.000Z",
  app: "abc123",
};

/** The front matter and the body, cut as `splitFrontMatter` cuts them. */
function split(file: string): { front: Record<string, unknown>; body: string } {
  const m = /^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/.exec(file);
  if (!m) throw new Error("no front matter");
  return { front: parse(m[2]!) as Record<string, unknown>, body: file.slice(m[0].length) };
}

describe("fenceFor", () => {
  it("is three backticks for text without any", () => {
    expect(fenceFor("int main(void) {}")).toBe("```");
  });

  it("is one longer than the longest run of backticks", () => {
    expect(fenceFor("a ``` b ```` c")).toBe("`````");
    expect(fenceFor("`x`")).toBe("```");
  });
});

describe("renderMarkdown", () => {
  it("cannot be closed early by an answer holding a fence", () => {
    const evil = "printf(\"x\");\n```\n# Injected heading\n````\n";
    const file = markdownBody([code("c", evil), heading(2, "After")]);
    expect(file).toContain("`````c\n" + evil + "`````");
    // The heading that follows is the only one outside the block.
    const outside = file.split("`````")[2]!;
    expect(outside).toContain("## After");
  });

  it("writes a front matter that reads back, with the body's sha256", () => {
    const doc: Document = { provenance, blocks: [heading(1, "Title"), markdown("Some *text*.")] };
    const { front, body } = split(renderMarkdown(doc));
    expect(front).toEqual({
      export: { kind: "item-answers", format: "md", version: 1 },
      source: { evaluationId: "e1", itemId: "i1" },
      attempts: ["a1", "a2"],
      generatedAt: "2026-10-29T10:00:00.000Z",
      app: "abc123",
      sha256: sha256(body),
    });
    expect(body).toBe("# Title\n\nSome *text*.\n");
  });

  it("renders tests, points, lists and separators", () => {
    const body = markdownBody([
      tests([
        { name: "adds", visible: true, ok: true, points: 2 },
        { name: "edge | case", visible: false, ok: false, points: 1.5 },
      ]),
      points(2, 3.5),
      points(null, 3),
      list(["one", "two\nlines"]),
      separator,
    ]);
    expect(body).toBe(
      [
        "Tests passed: 1/2",
        "| Test | Visibility | Result | Points |\n|---|---|---|---|\n| adds | visible | passed | 2 |\n| edge \\| case | hidden | failed | 1.5 |",
        "Points: 2 / 3.5",
        "Points: not graded / 3",
        "- one\n- two lines",
        "---",
      ].join("\n\n") + "\n",
    );
  });

  it("keeps a heading on one line and strips a language tag to its word", () => {
    expect(markdownBody([heading(3, "a\nb"), code("c`; rm", "x")])).toBe("### a b\n\n```crm\nx\n```\n");
  });
});
