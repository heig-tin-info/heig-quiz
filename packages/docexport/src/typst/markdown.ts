/**
 * A statement's Markdown into Typst source (ADR-125 §1, §2), on `marked`'s
 * lexer: the grammar of the web app's renderer (`apps/web/src/markdown/
 * render.ts`) and of the journal's (`@quiz/docrender`), so a prompt is cut
 * into the same blocks on paper as on the screen.
 *
 * Safe by construction, like the journal's renderer: the output holds only
 * text escaped by {@link typstText}, string literals ({@link typstString})
 * and a closed set of Typst functions written here. A code fence is a
 * `raw(block: true, …)` call on a string literal, never backtick markup, so
 * no run of backticks in an answer can close it; raw HTML is printed as the
 * text it is; an image is drawn only from an `asset:<id>` reference, by the
 * preamble's `img`, and only when the caller could load it into the compile
 * root (`drawable`); any other image leaves its alt text. A `$…$` or `$$…$$` outside code is a formula, through
 * `tex2typst` ({@link latexToTypstMath}), or its LaTeX in a raw box when it
 * does not convert: one formula never fails the PDF.
 *
 * The web's French spacing (`@quiz/docrender/typography`) is not applied:
 * `@quiz/core` depends on this package and `@quiz/docrender` on
 * `@quiz/contracts`, which depends on `@quiz/core`, so this package cannot
 * import it; the paper keeps the spaces the author typed.
 */
import { Marked, type Token, type Tokens } from "marked";

import { decodeEntities } from "../entities.js";
import { rawBlock, typstString, typstTable, typstText } from "./escape.js";
import { latexToTypstMath } from "./math.js";

/** An image the source may draw: the API copies the asset's bytes to `assets/<id>` of the compile root. */
export interface AssetRef {
  id: string;
}

/**
 * What the conversion of a whole document shares: the assets it drew, how
 * many formulas fell back to their LaTeX, and whether formulas are converted
 * at all (`raw`: every formula in its box, the compile's second try).
 */
export interface TypstContext {
  math: "typst" | "raw";
  assets: Map<string, AssetRef>;
  /** Formulas printed as their LaTeX source. */
  warnings: number;
  /** Formulas converted into Typst maths. */
  formulas: number;
}

export const typstContext = (math: TypstContext["math"] = "typst"): TypstContext => ({
  math,
  assets: new Map(),
  warnings: 0,
  formulas: 0,
});

/** The asset ids the upload endpoint gives; the optional query carries the width (`?w=50`). */
const ASSET_REF = /^asset:([A-Za-z0-9_-]{1,64})(?:\?([A-Za-z0-9_=&%.-]{0,64}))?$/;

/** The widths the web's size menu offers, in percent of the column; anything else is full width. */
const IMAGE_WIDTHS: readonly number[] = [25, 33, 50, 66, 75, 100];

/**
 * A `$…$` or `$$…$$` at the start of `src`, under the web renderer's rule
 * (`MATH_AT_START` of `apps/web/src/markdown/render.ts`): no backtick nor
 * link inside, and a single `$` held to pandoc's spacing rule, so `$5` in
 * prose and `$HOME` in a code span stay text.
 */
const MATH_AT_START = /^(?:\$\$[^`]+?\$\$|\$(?![\s$])(?:[^$\\\n`]|\\.)*?(?<![\s\\])\$(?!\d))/;
const LINK_INSIDE = /\]\(/;

/** The formulas a text token still holds (the web's text-node pass): `$$…$$` first, `\$` a literal dollar. */
const MATH = /\$\$([\s\S]+?)\$\$|(?<!\\)\$((?:[^$\\\n]|\\.)+?)\$/g;

const marked = new Marked({
  gfm: true,
  breaks: false,
  extensions: [
    {
      name: "math",
      level: "inline",
      start: (src: string) => {
        const at = src.search(/(?<!\\)\$/);
        return at < 0 ? undefined : at;
      },
      tokenizer: (src: string) => {
        const match = MATH_AT_START.exec(src);
        if (!match || LINK_INSIDE.test(match[0])) return undefined;
        return { type: "math", raw: match[0] };
      },
    },
  ],
});

/** A formula's LaTeX, printed as typed in a thin frame. */
function rawFormula(tex: string, display: boolean): string {
  const body = `raw(${typstString(tex)})`;
  return display
    ? `#block(stroke: 0.5pt + luma(150), inset: 4pt, radius: 2pt, ${body})`
    : `#box(stroke: 0.5pt + luma(150), inset: (x: 2pt), outset: (y: 2pt), radius: 2pt, ${body})`;
}

/** One formula, `display` on a line of its own. */
export function formula(tex: string, display: boolean, ctx: TypstContext): string {
  // A narrow no-break space in a formula is a space to the converter, as
  // the web hands KaTeX.
  const source = tex.replace(/ /g, " ").trim();
  const typst = ctx.math === "typst" ? latexToTypstMath(source) : null;
  if (typst === null) {
    ctx.warnings += 1;
    return rawFormula(source, display);
  }
  ctx.formulas += 1;
  return display ? `$ ${typst} $` : `$${typst}$`;
}

/** Text with the formulas the inline tokenizer refused (`$ a : b $`) found again, as the web's second pass does. */
function textWithMath(text: string, ctx: TypstContext): string {
  let out = "";
  let last = 0;
  MATH.lastIndex = 0;
  for (let m = MATH.exec(text); m; m = MATH.exec(text)) {
    out += typstText(text.slice(last, m.index));
    out += formula(m[1] ?? m[2] ?? "", m[1] !== undefined, ctx);
    last = m.index + m[0].length;
  }
  return out + typstText(text.slice(last));
}

/** The `$…$` source of a math token, as `[display, tex]`. */
function mathOf(raw: string): [boolean, string] {
  return raw.startsWith("$$") ? [true, raw.slice(2, -2)] : [false, raw.slice(1, -1)];
}

/** A link a reader can follow off the paper: the web's schemes, nothing else. */
const LINKABLE = /^(?:https?:|mailto:)/i;

/** An asset image, drawn by the preamble's `img` when it was loaded, else its alt text; any other image, its alt text. */
function image(token: Tokens.Image, ctx: TypstContext): string {
  const alt = decodeEntities(token.text ?? "");
  const m = ASSET_REF.exec((token.href ?? "").trim());
  if (!m) return typstText(alt);
  const id = m[1]!;
  ctx.assets.set(id, { id });
  const asked = Number(new URLSearchParams(m[2] ?? "").get("w"));
  const width = IMAGE_WIDTHS.includes(asked) ? asked : 100;
  return `#img(${typstString(id)}, ${typstString(alt)}, ${width})`;
}

function inline(tokens: readonly Token[] | undefined, ctx: TypstContext): string {
  return (tokens ?? []).map((t) => inlineToken(t, ctx)).join("");
}

function inlineToken(token: Token, ctx: TypstContext): string {
  switch (token.type) {
    case "text":
      return "tokens" in token && token.tokens?.length
        ? inline(token.tokens, ctx)
        : textWithMath(decodeEntities(token.text), ctx);
    case "escape":
      return typstText(token.text);
    case "strong":
      return `#strong[${inline(token.tokens, ctx)}]`;
    case "em":
      return `#emph[${inline(token.tokens, ctx)}]`;
    case "del":
      return `#strike[${inline(token.tokens, ctx)}]`;
    case "codespan":
      return `#raw(${typstString(decodeEntities(token.text))})`;
    case "br":
      return "#linebreak()";
    case "link": {
      const text = inline(token.tokens, ctx);
      const href = (token.href ?? "").trim();
      return LINKABLE.test(href) ? `#link(${typstString(href)})[${text}]` : text;
    }
    case "image":
      return image(token as Tokens.Image, ctx);
    case "math": {
      const [display, tex] = mathOf(token.raw);
      return formula(tex, display, ctx);
    }
    // Raw HTML (`html`, `tag`) is the text it is (D15, as the journal prints it).
    default:
      return "raw" in token && typeof token.raw === "string" ? typstText(token.raw) : "";
  }
}

function tableBlock(token: Tokens.Table, ctx: TypstContext): string {
  const cell = (c: Tokens.TableCell) => inline(c.tokens, ctx);
  return typstTable(
    token.header.map(cell),
    token.rows.map((row) => row.map(cell)),
    token.align.map((a) => a ?? "auto"),
  );
}

function listBlock(token: Tokens.List, ctx: TypstContext): string {
  // A task item: its box before its text, ticked as the author left it.
  const items = token.items
    .map((item) => {
      const box = item.task ? (item.checked ? "☑ " : "☐ ") : "";
      return `[${box}${blocks((item.tokens ?? []).filter((t) => t.type !== "checkbox"), ctx)}]`;
    })
    .join(", ");
  if (!token.ordered) return `#list(tight: ${!token.loose}, ${items})`;
  const start = typeof token.start === "number" ? token.start : 1;
  return `#enum(tight: ${!token.loose}, start: ${start}, ${items})`;
}

/** Statement headings sit under the document's own (a question is a level-2 heading). */
const HEADING_OFFSET = 2;

function block(token: Token, ctx: TypstContext): string {
  switch (token.type) {
    case "space":
    case "def":
      return "";
    case "paragraph":
      return inline(token.tokens, ctx);
    case "heading":
      return `#heading(level: ${Math.min(6, token.depth + HEADING_OFFSET)}, outlined: false)[${inline(token.tokens, ctx)}]`;
    case "code":
      return rawBlock((token.lang ?? "").trim().split(/\s+/)[0] ?? "", token.text);
    case "blockquote":
      return `#quote(block: true)[${blocks(token.tokens ?? [], ctx)}]`;
    case "list":
      return listBlock(token as Tokens.List, ctx);
    case "table":
      return tableBlock(token as Tokens.Table, ctx);
    case "hr":
      return "#hr";
    // A tight list item's `text`, a block of raw HTML: as inline.
    default:
      return inlineToken(token, ctx).trim();
  }
}

function blocks(tokens: readonly Token[], ctx: TypstContext): string {
  return tokens
    .map((t) => block(t, ctx))
    .filter((s) => s !== "")
    .join("\n\n");
}

/** One Markdown text as Typst markup; its images and formulas are counted in `ctx`. */
export function markdownToTypst(text: string, ctx: TypstContext): string {
  return blocks(marked.lexer(text), ctx);
}
