import { describe, expect, it } from "vitest";

import { decodeEntities } from "../entities.js";
import { rawBlock, typstString, typstTable, typstText, typstValue } from "./escape.js";
import { markdownToTypst, typstContext, type TypstContext } from "./markdown.js";
import { latexToTypstMath, safeTypstMath } from "./math.js";

const typst = (text: string, ctx: TypstContext = typstContext()) => markdownToTypst(text, ctx);

/**
 * Whether `source` holds `#` only where this renderer writes a function of
 * its closed set: every other `#` must be escaped (`\#`).
 */
const OWN_CALLS = /#(?:strong|emph|strike|raw|linebreak|link|img|hr|heading|quote|list|enum|table|block|box)\b/g;
const strayHashes = (source: string) =>
  source.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(OWN_CALLS, "").replace(/\\#/g, "").match(/#/g) ?? [];

describe("typstText", () => {
  it("escapes every character that opens markup, code, a label or a comment", () => {
    expect(typstText("#import")).toBe("\\#import");
    for (const c of ["\\", "#", "*", "_", "`", "$", "<", ">", "@", "[", "]", "~", "=", "-", "+", "/", ".", "'", '"']) {
      expect(typstText(`a${c}b`)).toBe(`a\\${c}b`);
    }
    expect(typstText("a // b /* c */")).toBe("a \\/\\/ b \\/\\* c *\\/".replace("*\\/", "\\*\\/"));
  });

  it("drops control characters and keeps line breaks", () => {
    expect(typstText("a\u0000b\u0007c\r\nd\te")).toBe("abc\nd\te");
  });
});

describe("typstString", () => {
  it("is a literal no content can leave", () => {
    expect(typstString('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
    expect(typstString("\u0001")).toBe('"\\u{1}"');
    expect(typstValue(["A"])).toBe('("A",)');
    expect(typstValue(["A", "B"])).toBe('("A", "B")');
    expect(typstValue({ a: null, b: [1, true], c: {} })).toBe('("a": none, "b": (1, true), "c": (:))');
  });

  it("builds a code block and a table, whatever their content", () => {
    expect(rawBlock('c") #x', 'a"b')).toBe('#raw(block: true, lang: "c#x", "a\\"b")');
    expect(rawBlock("", "x")).toBe('#raw(block: true, lang: none, "x")');
    expect(typstTable(["h"], [["c"]])).toBe("#table(columns: 1,\n  table.header([#strong[h]]),\n  [c],\n)");
    expect(typstTable(["a", "b"], [], ["auto", "right"])).toBe(
      "#table(columns: 2, align: (auto, right),\n  table.header([#strong[a]], [#strong[b]]),\n)",
    );
  });

  it("decodes the entities the web decodes, and leaves the others", () => {
    expect(decodeEntities("a &amp; b &#233; &#xE9; &eacute; &#xD800;")).toBe("a & b é é &eacute; &#xD800;");
  });
});

describe("markdownToTypst", () => {
  it("prints a prompt that holds Typst code as text", () => {
    const out = typst('Read #import "@preview/x:0.1.0": * and #read("/etc/passwd") // or /* this */ $x$ <lbl> @ref');
    expect(out).toContain('\\#import \\"\\@preview\\/x:0\\.1\\.0\\": \\*');
    expect(out).toContain('\\#read(\\"\\/etc\\/passwd\\")');
    expect(out).toContain("\\<lbl\\> \\@ref");
    expect(strayHashes(out)).toEqual([]);
  });

  it("maps paragraphs, strong, emphasis, strikethrough and line breaks", () => {
    expect(typst("one **two** _three_ ~~four~~\n\nnext")).toBe(
      "one #strong[two] #emph[three] #strike[four]\n\nnext",
    );
    expect(typst("a  \nb")).toBe("a#linebreak()b");
  });

  it("writes inline code and fences as string literals, whatever backticks they hold", () => {
    expect(typst("run `a<b> # $HOME`")).toBe('run #raw("a<b> # $HOME")');
    const fence = "````c\nprintf(\"```\"); // `` x\n````";
    expect(typst(fence)).toBe('#raw(block: true, lang: "c", "printf(\\"```\\"); // `` x")');
    expect(typst("```\nplain\n```")).toBe('#raw(block: true, lang: none, "plain")');
    // A hostile language tag is cut to a word.
    expect(typst('```c") #read("x\nbody\n```')).toBe('#raw(block: true, lang: "c", "body")');
  });

  it("maps headings under the document's, lists, task items, quotes, tables and rules", () => {
    expect(typst("# Part")).toBe("#heading(level: 3, outlined: false)[Part]");
    expect(typst("- a\n- b")).toBe("#list(tight: true, [a], [b])");
    expect(typst("3. a\n4. b")).toBe("#enum(tight: true, start: 3, [a], [b])");
    expect(typst("- [x] done\n- [ ] todo")).toBe("#list(tight: true, [☑ done], [☐ todo])");
    expect(typst("> said")).toBe("#quote(block: true)[said]");
    expect(typst("| a | b |\n|---|:-:|\n| 1 | 2 |")).toBe(
      [
        "#table(columns: 2, align: (auto, center),",
        "  table.header([#strong[a]], [#strong[b]]),",
        "  [1], [2],",
        ")",
      ].join("\n"),
    );
    expect(typst("---")).toBe("#hr");
  });

  it("prints raw HTML as the text it is", () => {
    expect(typst("<script>alert(1)</script>")).toBe("\\<script\\>alert(1)\\<\\/script\\>");
    expect(typst("a <b>x</b>")).toBe("a \\<b\\>x\\<\\/b\\>");
  });

  it("links the web's schemes only, and keeps the text of any other", () => {
    expect(typst("[site](https://heig-vd.ch)")).toBe('#link("https://heig-vd.ch")[site]');
    expect(typst("[x](javascript:alert(1))")).toBe("x");
  });

  it("draws an image from an asset reference only, at its preset width", () => {
    const ctx = typstContext();
    expect(typst("![a](asset:abc-1?w=50) ![b](asset:abc-1) ![c](asset:zz?w=900)", ctx)).toBe(
      '#img("abc-1", "a", 50) #img("abc-1", "b", 100) #img("zz", "c", 100)',
    );
    expect(ctx.assets.size).toBe(2);
    expect([...ctx.assets.values()]).toEqual([
      { id: "abc-1" },
      { id: "zz" },
    ]);
    const other = typstContext();
    expect(typst("![the alt](https://evil.example/x.png) ![d](asset:../../etc/passwd)", other)).toBe("the alt d");
    expect(other.assets.size).toBe(0);
  });

  it("converts formulas outside code, inline and on a line of their own", () => {
    const ctx = typstContext();
    expect(typst("Let $\\frac{a}{b}$ be.", ctx)).toBe("Let $a/b$ be\\.");
    expect(typst("$$\\sqrt{x}$$", ctx)).toBe("$ sqrt(x) $");
    // The text pass finds a formula the inline tokenizer refused (spaces inside).
    expect(typst("so $ \\alpha $ here", ctx)).toBe("so $alpha$ here");
    expect(ctx.formulas).toBe(3);
    expect(ctx.warnings).toBe(0);
    // Never inside code, never a price.
    expect(typst("`$x$` costs $5")).toBe('#raw("$x$") costs \\$5');
  });

  it("prints a formula that does not convert as its LaTeX in a box, and counts it", () => {
    const ctx = typstContext();
    const out = typst('$\\unknownmacro{x}$ and $\\text{a"b#c}$', ctx);
    expect(out).toBe(
      [
        '#box(stroke: 0.5pt + luma(150), inset: (x: 2pt), outset: (y: 2pt), radius: 2pt, raw("\\\\unknownmacro{x}"))',
        '#box(stroke: 0.5pt + luma(150), inset: (x: 2pt), outset: (y: 2pt), radius: 2pt, raw("\\\\text{a\\"b#c}"))',
      ].join(" and "),
    );
    expect(ctx.warnings).toBe(2);
    expect(strayHashes(out)).toEqual([]);
  });

  it("boxes every formula when asked for raw maths", () => {
    const ctx = typstContext("raw");
    expect(typst("$$x^2$$", ctx)).toBe('#block(stroke: 0.5pt + luma(150), inset: 4pt, radius: 2pt, raw("x^2"))');
    expect(ctx.warnings).toBe(1);
    expect(ctx.formulas).toBe(0);
  });

  it("keeps a cloze-like brace and the escapes as text", () => {
    expect(typst("\\* not bold \\$ not math {{x}}")).toBe("\\* not bold \\$ not math {{x}}");
  });
});

describe("latexToTypstMath", () => {
  it("converts the formulas a statement writes", () => {
    const corpus: [string, string][] = [
      ["\\frac{a}{b}", "a/b"],
      ["\\sqrt[3]{x^2}", "root(3, x^2)"],
      ["x_{i,j}^2", "x_(i, j)^2"],
      ["\\mathbb{R}", "RR"],
      ["\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}", "mat(1, 2; 3, 4)"],
      ["\\int_0^1 f(x)\\,dx", "integral_0^1 f(x) thin d x"],
      ["\\sum_{i=1}^n i", "sum_(i = 1)^n i"],
      ["\\overline{A \\cdot B}", "overline(A dot.op B)"],
      ["\\begin{cases} a & x>0 \\\\ b & \\text{else} \\end{cases}", 'cases(a & x > 0, b & "else")'],
      ["10\\,\\mathrm{k\\Omega}", "10 thin upright(k Omega)"],
      ["^\\circ C", "#none^circle.small C"],
    ];
    for (const [tex, expected] of corpus) expect(latexToTypstMath(tex)).toBe(expected);
  });

  it("refuses what is not maths alone, or names nobody knows", () => {
    for (const tex of ["\\foo + 1", "\\text{a\"b#c}", "\\frac{", "\\hspace{1cm} x", "\\color{red}{x}", "@x", ""]) {
      expect(latexToTypstMath(tex)).toBeNull();
    }
  });

  it("reads a converted formula for code, comments, labels and references", () => {
    expect(safeTypstMath('a + "b # c"')).toBe(true);
    expect(safeTypstMath("#read(x)")).toBe(false);
    expect(safeTypstMath("a // b")).toBe(false);
    expect(safeTypstMath("a /* b")).toBe(false);
    expect(safeTypstMath("a <x> b")).toBe(false);
    expect(safeTypstMath("a @x")).toBe(false);
    expect(safeTypstMath('a "b')).toBe(false);
    expect(safeTypstMath("a $ b")).toBe(false);
    expect(safeTypstMath("a ` b")).toBe(false);
    expect(safeTypstMath("a \\/ \\/ b")).toBe(true);
  });
});
