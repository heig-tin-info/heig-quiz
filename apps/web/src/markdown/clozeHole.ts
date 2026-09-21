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
import { matchClozeHole } from "@quiz/domain";

/** The token the tokenizer below emits; `body: null` is the escaped `\{{`. */
type ClozeHoleToken = MarkdownToken & { raw?: string; body?: string | null };

/**
 * What the chip reads, from the raw body.
 *
 * The body already carries its own operator — `#` for a number, `/` for a
 * regex — so repeating it as a glyph would be noise. The one case that needs a
 * mark is the DROPDOWN: `=free|delete` says nothing to a teacher at a glance,
 * and the little caret says "this is a list" the way the player will draw it.
 */
export function clozeHoleLabel(body: string): string {
  const weight = /^\d+(?:\.\d+)?\*/.exec(body)?.[0] ?? "";
  const rest = body.slice(weight.length);
  return rest.startsWith("=") ? `▾ ${weight}${rest.slice(1)}` : body;
}

export const ClozeHole = Node.create({
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
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-type": "cloze-hole",
        class: "rt-hole",
        title: body === null ? "\\{{" : `{{${body}}}`,
      }),
      body === null ? "{{" : clozeHoleLabel(body),
    ];
  },

  parseMarkdown: (token: MarkdownToken) => ({
    type: "clozeHole",
    attrs: { body: (token as ClozeHoleToken).body ?? null },
  }),

  /** VERBATIM: the braces, the `|`, the `=`, the `#` and the `*` as written. */
  renderMarkdown: (node: { attrs?: Record<string, unknown> }) => {
    const raw = node.attrs?.body;
    return raw === null || raw === undefined ? "\\{{" : `{{${String(raw)}}}`;
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
      (token as ClozeHoleToken).body === null ? "{{" : ((token as ClozeHoleToken).raw ?? ""),
    ),
  }),
});

/** Markdown's own escape rule, undone: `\<punctuation>` is that character. */
function unescapeMarkdown(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

/** The pair to register: the chip, or the plain characters (see above). */
export const clozeHoleExtensions = (active: boolean) => [active ? ClozeHole : ClozeHoleFallback];
