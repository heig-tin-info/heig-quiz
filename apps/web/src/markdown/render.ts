import DOMPurify from "dompurify";
import katex from "katex";
import { Marked, type Tokens } from "marked";

import { CLOZE_SENTINEL_PATTERN } from "@quiz/domain/cloze";

import { escapeHtml, highlight } from "./highlight";

/*
 * Markdown -> sanitised HTML for content a student reads: question prompts,
 * choices, explanations, teacher comments.
 *
 * The content is written by a teacher, but a teacher is not the trust
 * boundary the browser cares about: the same pipeline renders text that came
 * out of the database, through an import, or out of an AI suggestion, and
 * `docs/spec/03` (N-SEC-05) asks for no raw script, no foreign origin, no
 * `javascript:`. So the output is passed through an explicit ALLOW-list —
 * not a deny-list, which is a promise nobody can keep.
 *
 * The order matters and is the whole design:
 *
 *  1. marked turns the markdown into HTML. Its `image` renderer already drops
 *     every href that is not an `asset:<id>`, so the only `src` a well-formed
 *     document can produce is our own endpoint.
 *  2. DOMPurify sanitises the result against the allow-list below and hands
 *     back a DOM, not a string, so step 3 can inspect what survived.
 *  3. A DOM pass fixes what an allow-list cannot express: an <img> smuggled
 *     in as raw HTML (its src is not ours -> the node goes), an external link
 *     (opens in a new tab, `rel=noreferrer`), a code fence (its language
 *     class and the small tokenizer), and the maths.
 *  4. KaTeX renders `$…$` and `$$…$$` LAST, into the text nodes that are not
 *     inside <code>. Last, because its output is a thicket of spans and
 *     MathML that an allow-list would have to admit wholesale; generated
 *     after sanitisation, it is ours and never comes from the document.
 *     Skipping <code> is also what makes `$HOME` in a shell block stay
 *     `$HOME`.
 */

/** Where an `asset:<id>` image resolves to. Same origin, no CDN (N-SEC-02). */
const ASSET_BASE = "/app/api/assets/";

/**
 * Ids are what the upload endpoint returns; anything else is not an asset.
 *
 * The optional query is how an image carries its WIDTH. A teacher who sizes a
 * picture in the editor writes `![alt](asset:<id>?w=50)`, and that is the
 * whole of it: no second attribute to invent, no HTML in the markdown, and a
 * reader who opens the source pane sees what the setting is. Anything but the
 * presets below is ignored rather than honoured, so a hand-typed `?w=900`
 * cannot push an image out of the column.
 */
const ASSET_REF = /^asset:([A-Za-z0-9_-]{1,64})(?:\?([A-Za-z0-9_=&%.-]{0,64}))?$/;

/** The widths the size menu offers, as a percentage of the content width. */
export const IMAGE_WIDTHS = [25, 33, 50, 66, 75, 100] as const;
export type ImageWidth = (typeof IMAGE_WIDTHS)[number];

/** `asset:<id>` -> the same-origin URL, or null when it is not an asset ref. */
export function assetUrl(href: string): string | null {
  const m = ASSET_REF.exec(href.trim());
  return m ? ASSET_BASE + m[1] : null;
}

/**
 * The width an asset reference asks for, as a percentage. 100 when it asks
 * for nothing, or for something that is not one of the presets: a full-width
 * image is what every image in the app was before the setting existed, so an
 * unreadable query degrades to the old behaviour instead of to nothing.
 */
export function assetWidth(href: string): ImageWidth {
  const m = ASSET_REF.exec(href.trim());
  const w = Number(new URLSearchParams(m?.[2] ?? "").get("w"));
  return (IMAGE_WIDTHS as readonly number[]).includes(w) ? (w as ImageWidth) : 100;
}

/** The same reference, asking for `width`. 100 % drops the query entirely. */
export function withAssetWidth(href: string, width: ImageWidth): string {
  const m = ASSET_REF.exec(href.trim());
  if (!m) return href;
  return width === 100 ? `asset:${m[1]}` : `asset:${m[1]}?w=${width}`;
}

/** The markdown source of an image pointing at an uploaded asset. */
export function assetMarkdown(id: string, alt = ""): string {
  return `![${alt}](asset:${id})`;
}

const ALLOWED_TAGS = [
  "p", "br", "hr", "strong", "em", "del", "code", "pre", "blockquote",
  "ul", "ol", "li", "input", "a", "img",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  "span", "sup", "sub",
];

/*
 * `class` is here because the code fences and the task lists need it, and it
 * is harmless: this app ships no stylesheet a class can weaponise (no
 * `position: fixed` overlay class, no `display:none` on a warning). `style`
 * is NOT here, which is what keeps a prompt from covering the countdown.
 */
const ALLOWED_ATTR = ["href", "title", "alt", "src", "class", "type", "checked", "disabled", "start", "align", "colspan", "rowspan"];

/**
 * Schemes a link may carry. DOMPurify's own default also admits `tel:`,
 * `sms:`, `callto:` and `cid:`; a question prompt has no business dialling a
 * phone, so the list is cut to what a course actually links to. The trailing
 * alternatives are DOMPurify's own way of letting relative URLs through.
 */
const ALLOWED_URI_REGEXP = /^(?:https?:|mailto:|[^a-z]|[a-z+.\-]+(?:[^a-z+:.\-]|$))/i;

const marked = new Marked({
  gfm: true, // tables, task lists, strikethrough, autolinks
  breaks: false,
  renderer: {
    /**
     * Fenced code: the language becomes a class (so the stylesheet can set
     * the mono face and the tint) and the small tokenizer does the rest.
     * `escaped` means marked already escaped the text; `highlight` escapes
     * every run it emits, so it must see the raw source either way.
     */
    code({ text, lang }: Tokens.Code) {
      const tag = (lang ?? "").trim().split(/\s+/)[0] ?? "";
      const cls = tag ? ` class="language-${escapeHtml(tag.toLowerCase())}"` : "";
      return `<pre><code${cls}>${highlight(text, tag)}\n</code></pre>\n`;
    },
    /**
     * The ONE place an <img> is allowed to come from. An `asset:<id>` becomes
     * our endpoint; anything else (an http URL, a data: blob, a relative
     * path) is dropped and leaves its alt text behind, so the prompt still
     * reads and the teacher sees that the image did not take.
     */
    image({ href, title, text }: Tokens.Image) {
      const src = assetUrl(href ?? "");
      if (!src) return escapeHtml(text ?? "");
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      // The width travels as a CLASS and never as a `style`: the allow-list
      // admits `class` and refuses `style` on purpose (a prompt must not be
      // able to position anything), and the six presets are six rules in the
      // `.md-body` block of style.css.
      const width = assetWidth(href ?? "");
      const cls = width === 100 ? "" : ` class="md-img-${width}"`;
      return `<img src="${src}" alt="${escapeHtml(text ?? "")}"${titleAttr}${cls}>`;
    },
  },
});

/** Math delimiters, longest first so `$$` wins over `$`. `\$` is a literal. */
const MATH = /\$\$([\s\S]+?)\$\$|(?<!\\)\$((?:[^$\\\n]|\\.)+?)\$/g;

/** Tags whose text is literal: no maths, no smart anything. */
const LITERAL = new Set(["CODE", "PRE", "KBD", "SAMP"]);

/**
 * Replaces `$…$` and `$$…$$` inside one text node with KaTeX output. Returns
 * true when it changed something, so the caller can skip untouched nodes.
 */
function renderMathIn(node: Text, doc: Document): boolean {
  const text = node.data;
  if (!text.includes("$")) return false;
  MATH.lastIndex = 0;
  let match = MATH.exec(text);
  if (!match) return false;
  const frag = doc.createDocumentFragment();
  let last = 0;
  while (match) {
    if (match.index > last) frag.append(doc.createTextNode(text.slice(last, match.index)));
    const display = match[1] !== undefined;
    const tex = (match[1] ?? match[2] ?? "").trim();
    const host = doc.createElement("span");
    host.className = display ? "md-math md-math-display" : "md-math";
    // `throwOnError: false` renders the offending source in the error colour
    // instead of taking the whole prompt down: a half-written formula must
    // not blank the question a student is reading.
    host.innerHTML = katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      output: "htmlAndMathml",
    });
    frag.append(host);
    last = match.index + match[0].length;
    match = MATH.exec(text);
  }
  if (last < text.length) frag.append(doc.createTextNode(text.slice(last)));
  node.replaceWith(frag);
  return true;
}

/*
 * The blanks of a `cloze` text (decision D5). The parser leaves `⸢<index>⸣`
 * where each `{{…}}` was; the host has to put a field there, and a field is a
 * React element this pipeline never produces. So, with `holes`, a sentinel
 * travels through marked, DOMPurify and the highlighter as a run of
 * private-use characters — no digit, no letter, nothing a tokenizer colours
 * or a markdown rule reads — and comes out as an EMPTY element carrying its
 * index, which the host fills with a portal (`ClozeMarkdownText.tsx`).
 *
 * Private-use and not the sentinel itself, because the sentinel's digits are
 * a number to the code highlighter (`⸢<span class="tok-num">3</span>⸣`),
 * and a hole split over three nodes is a hole nobody finds.
 */
const HOLE_OPEN = "";
const HOLE_CLOSE = "";
const HOLE_DIGIT = 0xe010;
const HOLE_CHARS = /[-]/g;
const HOLE_RUN = /([-]+)/g;
/** The attribute of a hole's element. Ours only: `ALLOW_DATA_ATTR` is off. */
export const HOLE_ATTR = "data-cloze-hole";

function encodeHoles(source: string): string {
  return source
    .replace(HOLE_CHARS, "")
    .replace(new RegExp(CLOZE_SENTINEL_PATTERN, "g"), (_, index: string) => {
      const digits = Array.from(index, (d) => String.fromCharCode(HOLE_DIGIT + Number(d)));
      return HOLE_OPEN + digits.join("") + HOLE_CLOSE;
    });
}

/**
 * Every encoded sentinel becomes `<span data-cloze-hole="N">`. It runs over
 * EVERY text node, code included — a hole in a fenced block is a hole — and
 * before the maths, so a hole written between two `$` keeps its field
 * rather than vanishing into a formula.
 */
function placeHoles(root: HTMLElement) {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue?.includes(HOLE_OPEN)) texts.push(n as Text);
  }
  for (const node of texts) {
    const text = node.data;
    const frag = doc.createDocumentFragment();
    let last = 0;
    HOLE_RUN.lastIndex = 0;
    for (let m = HOLE_RUN.exec(text); m; m = HOLE_RUN.exec(text)) {
      if (m.index > last) frag.append(doc.createTextNode(text.slice(last, m.index)));
      const index = Array.from(m[1]!, (c) => c.charCodeAt(0) - HOLE_DIGIT).join("");
      const hole = doc.createElement("span");
      hole.setAttribute(HOLE_ATTR, index);
      frag.append(hole);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.append(doc.createTextNode(text.slice(last)));
    node.replaceWith(frag);
  }
}

/** Walks the sanitised tree and applies steps 3 and 4 above. */
function postProcess(root: HTMLElement, codeBlockLabel: string, holes: boolean) {
  const doc = root.ownerDocument;
  if (holes) placeHoles(root);

  // A fenced block scrolls sideways on a phone, and a scroll container with
  // nothing focusable inside it cannot be reached with a keyboard at all: a
  // student with no mouse could not read past the fold (W10). `tabindex` is
  // what makes it scrollable from the keyboard, and the named region is what
  // tells a reader what they just landed in. Set here, after DOMPurify, so
  // these three attributes are ours and never something the document asked
  // for.
  for (const pre of Array.from(root.querySelectorAll("pre"))) {
    pre.setAttribute("tabindex", "0");
    // `group` and not `region`: a region is a LANDMARK, and a document with
    // two code fences would then offer a reader two landmarks with the same
    // name — which axe calls out as `landmark-unique`, rightly. A named group
    // says what the box is without pretending to be a section of the page.
    pre.setAttribute("role", "group");
    pre.setAttribute("aria-label", codeBlockLabel);
  }

  // An <img> that did not come from our renderer came from raw HTML. Its src
  // survived the allow-list only if it happens to be same-origin; it is still
  // not an asset of this course, so it goes.
  for (const img of Array.from(root.querySelectorAll("img"))) {
    if (!img.getAttribute("src")?.startsWith(ASSET_BASE)) img.remove();
    else img.setAttribute("loading", "lazy");
  }

  // A link out of the app opens in its own tab and carries no referrer. A
  // relative one (an asset, another page) keeps the current tab. An <a> whose
  // href the allow-list refused (a `javascript:` URL) becomes plain text:
  // leaving it underlined and red would promise a link that does nothing.
  for (const a of Array.from(root.querySelectorAll("a"))) {
    const href = a.getAttribute("href") ?? "";
    if (href === "") {
      a.replaceWith(...Array.from(a.childNodes));
      continue;
    }
    if (/^https?:/i.test(href)) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noreferrer noopener");
    }
  }

  // A task list is read, never ticked: the answer of a question is its own
  // payload, not a checkbox in the prompt.
  for (const input of Array.from(root.querySelectorAll("input"))) {
    if (input.getAttribute("type") !== "checkbox") input.remove();
    else {
      input.setAttribute("disabled", "");
      input.parentElement?.classList.add("md-task");
    }
  }

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let parent = node.parentElement;
      while (parent && parent !== root) {
        if (LITERAL.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        parent = parent.parentElement;
      }
      return node.nodeValue?.includes("$") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
  for (const node of texts) renderMathIn(node, doc);
}

/**
 * Untrusted markdown -> a sanitised HTML string, ready for
 * `dangerouslySetInnerHTML`. Empty in, empty out (the caller shows its own
 * placeholder rather than an empty box).
 *
 * `codeBlockLabel` is the accessible name given to each fenced block, which
 * is a focusable scroll region (W10). It is passed in rather than read from
 * `t()` here: this module is pure, and its tests read the HTML, not a locale.
 */
export function renderMarkdown(
  source: string,
  codeBlockLabel = "Code block",
  options: {
    /**
     * A `cloze` template: each `⸢<index>⸣` becomes an empty
     * `<span data-cloze-hole="<index>">` for the host to fill.
     */
    holes?: boolean;
  } = {},
): string {
  if (!source.trim()) return "";
  const holes = options.holes === true;
  const html = marked.parse(holes ? encodeHoles(source) : source, { async: false });
  const body = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
    // An allow-list names every attribute it admits, `data-*` included — and
    // it keeps `data-cloze-hole` an attribute only `placeHoles` writes.
    ALLOW_DATA_ATTR: false,
    RETURN_DOM: true,
  }) as unknown as HTMLElement;
  postProcess(body, codeBlockLabel, holes);
  return body.innerHTML;
}
