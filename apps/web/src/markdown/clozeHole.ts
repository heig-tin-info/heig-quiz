/*
 * The `{{…}}` hole of the `cloze` type, as an OBJECT in the rich editor.
 *
 * Why a node and not simply text. The markdown serializer backslash-escapes
 * the characters that mean something inline — `` \ ` * _ [ ] ~ `` — so a hole
 * written as text came back `{{2\*Newton}}` the first time a teacher touched
 * the field, and `@quiz/domain`'s parser no longer read it as a weight. Worse,
 * marked's inline lexer had already eaten the `*` pair of two holes as
 * emphasis on the way IN. That is why the cloze editor was the one type still
 * stuck with a textarea. An inline ATOM node fixes both ends at once: the
 * tokenizer takes the hole out of the inline stream before any emphasis rule
 * sees it, and `renderMarkdown` writes the body back byte for byte.
 *
 * The grammar itself is NOT re-implemented here. `matchClozeHole` in
 * `@quiz/domain` is the very function `parseCloze` walks with, escape rules
 * (`\{{`, `\}}`) included, so the editor and the grader cannot disagree about
 * where a hole ends.
 *
 * `body: null` is the escaped opening `\{{` — two literal braces. It is a node
 * too, and for the same reason: a text node holding `{{` would be written back
 * unescaped and would parse as a hole the next time the question was opened.
 */
import { Extension, InputRule, mergeAttributes, Node } from "@tiptap/core";
import type { MarkdownToken } from "@tiptap/core";
import { matchClozeHole, parseBlankBody, type ClozeBlank } from "@quiz/domain";

/** The token the tokenizer below emits; `body: null` is the escaped `\{{`. */
type ClozeHoleToken = MarkdownToken & { raw?: string; body?: string | null };

/*
 * ---------------------------------------------------------------------------
 * THE PIPE OF A HOLE, INSIDE A TABLE CELL
 *
 * A markdown table row is split on every unescaped `|` — by marked's block
 * lexer, long before any inline tokenizer sees the cell — so `| a | {{x|y}} |`
 * reached the editor as THREE columns and the hole was gone. The domain side
 * does not have this problem: `parseCloze` runs before markdown and the cell
 * already holds a sentinel by the time the row is split (decision D5). The
 * editor has no such pass, so it does the same thing by hand, at its two
 * boundaries: every `|` INSIDE a hole body becomes U+E000 on the way in, and
 * `|` again on the way out.
 *
 * The substitution is undone at the very END of the serialisation, after the
 * table renderer has padded its columns — the shipped renderer
 * (`renderTableToMarkdown`, @tiptap/extension-table 3.31) does NOT escape a
 * pipe in a cell, it only pads, so a `\|` would have travelled into the stored
 * markdown as two characters and the padding is computed on a string of the
 * same length either way.
 * ---------------------------------------------------------------------------
 */

/** A private-use code point: it cannot occur in a question a teacher wrote. */
const HOLE_PIPE = "\uE000";

/**
 * Every `|` inside a `{{…}}` body, replaced by `HOLE_PIPE`.
 *
 * CODE is left alone — a fenced block, and a backtick span. A hole there is
 * plain text, not a chip, so the substitution would be visible as a tofu box
 * in the editing surface; and the one case that needed protecting, a code span
 * in a table cell, is already handled by the table extension itself, which
 * escapes the pipes of a code span on a row line before splitting it
 * (`preprocessTablePipes`, @tiptap/extension-table).
 */
export function protectHolePipes(markdown: string): string {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s{0,3}(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      return fenced ? line : protectLine(line);
    })
    .join("\n");
}

function protectLine(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      // A code span travels verbatim, closing run included; an unclosed run is
      // not a span at all, so only the backticks themselves are copied.
      const run = /^`+/.exec(line.slice(i))![0];
      const close = line.indexOf(run, i + run.length);
      const end = close === -1 ? i + run.length : close + run.length;
      out += line.slice(i, end);
      i = end;
      continue;
    }
    const hole = line[i] === "{" || line.startsWith("\\{{", i) ? matchClozeHole(line.slice(i)) : undefined;
    if (hole === undefined) {
      out += line[i];
      i += 1;
      continue;
    }
    out += hole.body === null ? hole.raw : `{{${hole.body.split("|").join(HOLE_PIPE)}}}`;
    i += hole.raw.length;
  }
  return out;
}

/** The inverse, applied to the whole serialised document. */
export function restoreHolePipes(markdown: string): string {
  return markdown.split(HOLE_PIPE).join("|");
}

/**
 * What the chip reads, and in which tone.
 *
 * The shape of the blank is the thing a teacher has to recognise at a glance,
 * not its syntax: one answer is a word, several answers are a SET of
 * possibilities, and a number or a regex is machinery. So the chip shows the
 * first answer and says how many more there are, and the second tone
 * (`info`, DESIGN.md) exists for exactly that distinction.
 */
interface ClozeHoleChip {
  /** What the pill reads. */
  text: string;
  /** A small suffix: `+2` for the other answers, `▾` for a dropdown, `±t`. */
  suffix: string | null;
  tone: "one" | "set" | "machine" | "broken";
}

function clozeHoleChip(body: string): ClozeHoleChip {
  const blank = parseBlankBody(body);
  if (typeof blank === "string") return { text: body, suffix: null, tone: "broken" };
  const weight = blank.weight === 1 ? "" : `${blank.weight}× `;
  const chip = shape(blank);
  return { ...chip, text: weight + chip.text };
}

function shape(blank: ClozeBlank): ClozeHoleChip {
  switch (blank.kind) {
    case "text":
      return blank.answers.length === 1
        ? { text: blank.answers[0]!, suffix: null, tone: "one" }
        : { text: blank.answers[0]!, suffix: `+${blank.answers.length - 1}`, tone: "set" };
    case "select": {
      const first = blank.options[blank.correct[0] ?? 0] ?? "";
      return { text: first, suffix: "▾", tone: "set" };
    }
    case "number": {
      if (blank.tolerance === 0) return { text: `#${blank.value}`, suffix: null, tone: "machine" };
      const tolerance =
        blank.mode === "rel" ? `${Number((blank.tolerance * 100).toFixed(6))}%` : String(blank.tolerance);
      return { text: `#${blank.value}`, suffix: `±${tolerance}`, tone: "machine" };
    }
    case "regex":
      return { text: `/${blank.pattern}/${blank.flags}`, suffix: null, tone: "machine" };
  }
}

/** The whole list a multi-answer chip stands for, for the read-only popover. */
export interface ClozeHolePossibility {
  label: string;
  correct: boolean | null;
}

export function clozeHolePossibilities(body: string): ClozeHolePossibility[] | null {
  const blank = parseBlankBody(body);
  if (typeof blank === "string") return null;
  if (blank.kind === "text" && blank.answers.length > 1) {
    return blank.answers.map((label) => ({ label, correct: null }));
  }
  if (blank.kind === "select") {
    return blank.options.map((label, i) => ({ label, correct: blank.correct.includes(i) }));
  }
  return null;
}

const ClozeHole = Node.create({
  name: "clozeHole",
  group: "inline",
  inline: true,
  atom: true,
  // Backspace takes the whole chip, never half of it.
  selectable: true,

  addAttributes() {
    return {
      body: {
        default: "",
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-literal") === "true"
            ? null
            : (element.getAttribute("data-body") ?? ""),
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-body": attributes.body === null ? "" : String(attributes.body ?? ""),
          "data-literal": attributes.body === null ? "true" : null,
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="cloze-hole"]' }];
  },

  /*
   * A chip, drawn by the serializer rather than by a React node view: it holds
   * one string and no interaction of its own — the click is `RichText`'s, the
   * same way it opens a formula — so a component per hole would be a React
   * tree rebuilt on every keystroke of a prompt for nothing.
   */
  renderHTML({ node, HTMLAttributes }) {
    const raw: unknown = node.attrs.body;
    const body = raw === null ? null : String(raw ?? "");
    if (body === null) {
      return [
        "span",
        mergeAttributes(HTMLAttributes, {
          "data-type": "cloze-hole",
          class: "rt-hole",
          "data-tone": "literal",
          title: "\\{{",
        }),
        "{{",
      ];
    }
    const chip = clozeHoleChip(body);
    const attrs = mergeAttributes(HTMLAttributes, {
      "data-type": "cloze-hole",
      class: "rt-hole",
      "data-tone": chip.tone,
      title: `{{${body}}}`,
    });
    return chip.suffix === null
      ? ["span", attrs, chip.text]
      : ["span", attrs, chip.text, ["span", { class: "rt-hole-suffix" }, chip.suffix]];
  },

  /** The node attribute holds the REAL body: the `|` comes back here. */
  parseMarkdown: (token: MarkdownToken) => {
    const body = (token as ClozeHoleToken).body ?? null;
    return {
      type: "clozeHole",
      attrs: { body: body === null ? null : restoreHolePipes(body) },
    };
  },

  /**
   * VERBATIM: the braces, the `=`, the `#` and the `*` as written — and the
   * `|` as `HOLE_PIPE`, which `RichText.serialize` turns back into a pipe once
   * the table renderer has had its say (the block comment at the head).
   */
  renderMarkdown: (node: { attrs?: Record<string, unknown> }) => {
    const raw = node.attrs?.body;
    if (raw === null || raw === undefined) return "\\{{";
    return `{{${String(raw).split("|").join(HOLE_PIPE)}}}`;
  },

  markdownTokenizer: {
    name: "clozeHole",
    level: "inline" as const,
    // `\{{` is a hole token too (the literal one), so the scan starts at the
    // backslash when there is one right before the braces.
    start: (src: string) => {
      const at = src.indexOf("{{");
      if (at === -1) return -1;
      return at > 0 && src[at - 1] === "\\" ? at - 1 : at;
    },
    tokenize: (src: string) => {
      const hole = matchClozeHole(src);
      if (hole === undefined) return undefined;
      return { type: "clozeHole", raw: hole.raw, body: hole.body };
    },
  },

  addInputRules() {
    return [
      /*
       * Typing `{{` makes an EMPTY hole, which `RichText` immediately opens
       * its body field on — there is nothing to type into an atom. The
       * lookbehind leaves `\{{` alone: a teacher escaping the braces is asking
       * for the characters, and the tokenizer reads that back as the literal.
       */
      new InputRule({
        find: /(?<!\\)\{\{$/,
        handler: ({ state, range }) => {
          state.tr.replaceWith(range.from, range.to, this.type.create({ body: "" }));
        },
      }),
    ];
  },
});

/**
 * The same token, in a field that has NO holes.
 *
 * It is not optional, and the reason is unpleasant: `@tiptap/markdown`
 * registers a `markdownTokenizer` on the marked SINGLETON, so the moment one
 * cloze editor exists in the page every other Tiptap field lexes `{{…}}` as a
 * `clozeHole` token too. A field with no handler for that token DROPS it — the
 * text of an mcq prompt would vanish on the next save. So every field carries
 * a handler; this one turns the token back into the characters it was made of,
 * which is what a prompt meant by them.
 *
 * It registers the SAME tokenizer, so the two are interchangeable and the
 * result no longer depends on which field was opened first.
 */
const ClozeHoleFallback = Extension.create({
  name: "clozeHoleText",
  markdownTokenName: "clozeHole",
  markdownTokenizer: ClozeHole.config.markdownTokenizer,
  parseMarkdown: (token: MarkdownToken) => ({
    type: "text",
    /*
     * UNESCAPED, or the backslashes pile up: the serializer escapes the `*`
     * of `{{2*a}}` to `{{2\*a}}`, and a literal re-read of that would escape
     * the backslash in turn, one more on every save.
     */
    text: unescapeMarkdown(
      restoreHolePipes(
        (token as ClozeHoleToken).body === null ? "{{" : ((token as ClozeHoleToken).raw ?? ""),
      ),
    ),
  }),
});

/** Markdown's own escape rule, undone: `\<punctuation>` is that character. */
function unescapeMarkdown(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

/** The pair to register: the chip, or the plain characters (see above). */
export const clozeHoleExtensions = (active: boolean) => [active ? ClozeHole : ClozeHoleFallback];
