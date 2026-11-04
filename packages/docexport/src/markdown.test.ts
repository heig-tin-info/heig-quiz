import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  answerZone,
  code,
  drawing,
  heading,
  list,
  markdown,
  noAnswerOr,
  number,
  points,
  scopeZones,
  separator,
  tests,
  type Block,
  type Document,
} from "./document.js";
import { EN_LABELS, FR_LABELS, type Lang } from "./labels.js";
import { createHash } from "node:crypto";

import { fenceFor, markdownBody, renderMarkdown } from "./markdown.js";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The body of `blocks`, worded in `lang`. */
const body = (blocks: readonly Block[], lang: Lang = "en") => markdownBody({ lang, blocks });

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
    const file = body([code("c", evil), heading(2, "After")]);
    expect(file).toContain("`````c\n" + evil + "`````");
    // The heading that follows is the only one outside the block.
    const outside = file.split("`````")[2]!;
    expect(outside).toContain("## After");
  });

  it("writes a front matter that reads back, with the body's sha256", () => {
    const doc: Document = { provenance, lang: "en", blocks: [heading(1, "Title"), markdown("Some *text*.")] };
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
    const text = body([
      tests([
        { name: "adds", visible: true, ok: true, points: 2 },
        { name: "edge | case", visible: false, ok: false, points: 1.5 },
      ]),
      points(2, 3.5),
      points(null, 3),
      list(["one", "two\nlines"]),
      separator,
    ]);
    expect(text).toBe(
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
    expect(body([heading(3, "a\nb"), code("c`; rm", "x")])).toBe("### a b\n\n```crm\nx\n```\n");
  });
});

describe("answer zones (ADR-125)", () => {
  it("draws bubbles, lines, a free frame and the name fields", () => {
    const text = body([
      answerZone("bubbles", { labels: ["A", "B", "C"] }),
      answerZone("bubbles", { labels: ["A", "B"], multiple: true }),
      answerZone("lines", { lines: 2 }),
      answerZone("name"),
    ]);
    const line = `\`${"_".repeat(40)}\``;
    expect(text).toBe(
      [
        "○ A  ○ B  ○ C",
        "☐ A  ☐ B",
        `${line}\n\n${line}`,
        "Name: ________________  First name: ________________",
      ].join("\n\n") + "\n",
    );
  });

  it("sizes a free frame by its height: a blank line per 8 mm, three at least", () => {
    const blankLines = (heightMm?: number) => body([answerZone("free", heightMm === undefined ? {} : { heightMm })]).split("\n").length - 3;
    expect(blankLines(80)).toBe(10);
    expect(blankLines(10)).toBe(3);
    expect(blankLines()).toBe(3);
  });

  it("keys a zone to its item, and to the part it answers", () => {
    const scoped = scopeZones("item-9", [answerZone("lines"), answerZone("lines", { part: "b3" }), separator]);
    expect(scoped.map((b) => (b.kind === "answerZone" ? b.id : b.kind))).toEqual(["item-9", "item-9:b3", "separator"]);
  });
});

describe("drawings (ADR-126)", () => {
  const figure = { viewBox: [0, 0, 10, 10] as const, items: [{ kind: "text" as const, x: 0, y: 0, text: "SECRET_SVG" }] };

  it("prints a figure as its alt text on an italic line, never its SVG", () => {
    const text = body([drawing(figure, "A circuit *with* two_resistors\nin series")]);
    expect(text).toBe("*A circuit \\*with\\* two\\_resistors in series*\n");
    expect(text).not.toContain("SECRET_SVG");
    expect(text).not.toContain("<svg");
    expect(body([drawing(figure, "  ")])).toBe("\n");
  });

  it("previews a ruled frame as a plain one, its starter left out", () => {
    const zone = answerZone("free", { heightMm: 40, pattern: { kind: "grid", pitchMm: 4 }, underlay: figure });
    expect(body([zone])).toBe(body([answerZone("free", { heightMm: 40 })]));
    expect(body([zone])).not.toContain("SECRET_SVG");
  });
});

describe("labels", () => {
  it("words a document in its language", () => {
    const blocks = [points(null, 2), answerZone("name"), noAnswerOr(FR_LABELS, true, separator)];
    expect(body(blocks)).toBe(
      "Points: not graded / 2\n\nName: ________________  First name: ________________\n\nPas de réponse.\n",
    );
    expect(body(blocks, "fr")).toBe(
      "Points\u202F: pas encore noté / 2\n\nNom\u202F: ________________  Prénom\u202F: ________________\n\nPas de réponse.\n",
    );
  });

  it("has every word in both languages", () => {
    expect(Object.keys(FR_LABELS).sort()).toEqual(Object.keys(EN_LABELS).sort());
    for (const value of [...Object.values(EN_LABELS), ...Object.values(FR_LABELS)]) expect(value.trim()).not.toBe("");
    expect([EN_LABELS.lang, FR_LABELS.lang]).toEqual(["en", "fr"]);
  });

  it("writes points with two decimals at most, and an answer only when there is one", () => {
    expect([number(2), number(1.256), number(1 / 3)]).toEqual(["2", "1.26", "0.33"]);
    expect(noAnswerOr(EN_LABELS, false, separator)).toBe(separator);
  });
});
