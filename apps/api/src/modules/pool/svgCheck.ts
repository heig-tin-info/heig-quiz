/**
 * The strict check of an SVG a teacher embeds in a question (ADR-134).
 *
 * An SVG is a document, not a bitmap: it can carry script, fetch other
 * resources, embed HTML, and hold text nobody sees drawn. Two barriers keep
 * it inert, and this is the second one:
 *   1. it is shown through `<img>` only (the Markdown renderer's one image
 *      rule), where a browser runs no script and fetches nothing, and served
 *      with `INERT_IMAGE_HEADERS` (`nosniff`, CSP `default-src 'none';
 *      sandbox`), so even a direct navigation to its URL is inert;
 *   2. this check REFUSES (it never rewrites) anything outside a small
 *      allow-list of drawing elements, presentation attributes and CSS
 *      functions. What it accepts is stored byte for byte.
 *
 * It also keeps out what a student could READ in the source without it being
 * drawn — comments (XML and CSS), `<title>`, `<desc>`, `<metadata>`, text
 * outside a text element: a student in an attempt may fetch the asset
 * (invariant 4). Text hidden by its styling, or in an attribute value, stays
 * a residual risk (ADR-134).
 *
 * Only the question-asset upload calls it: avatars and remote pictures stay
 * raster (`sniffImage`, `AvatarMime`).
 */
import { SaxesParser, type SaxesTagNS } from "saxes";

import type { SvgRefusalCode } from "@quiz/contracts";

/** The most bytes an SVG may weigh: far below `ASSETS_MAX_BYTES`, ample for a diagram. */
export const SVG_MAX_BYTES = 512 * 1024;
/** The deepest nesting: renderers (usvg in Typst, the browsers) recurse on it. */
export const SVG_MAX_DEPTH = 64;

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

/** The drawing elements; anything else — script, foreignObject, image, filters, animation, a, title… — is refused. */
const ELEMENTS: ReadonlySet<string> = new Set([
  "svg", "g", "defs", "symbol", "use",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "textPath",
  "marker", "linearGradient", "radialGradient", "stop",
  "clipPath", "mask", "pattern", "style",
]);

/** Where non-blank text may stand: what is drawn. A stylesheet's text is collected and checked whole. */
const TEXT_PARENTS: ReadonlySet<string> = new Set(["text", "tspan", "textPath"]);

/** Presentation and geometry attributes; anything else — an `on*` handler, a foreign namespace — is refused. */
const ATTRIBUTES: ReadonlySet<string> = new Set([
  "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "width", "height",
  "viewBox", "preserveAspectRatio", "d", "points", "transform",
  "fill", "fill-opacity", "fill-rule",
  "stroke", "stroke-width", "stroke-dasharray", "stroke-dashoffset", "stroke-linecap",
  "stroke-linejoin", "stroke-miterlimit", "stroke-opacity", "opacity",
  "font-family", "font-size", "font-weight", "font-style",
  "text-anchor", "dominant-baseline", "alignment-baseline", "baseline-shift", "letter-spacing",
  "dx", "dy", "rotate", "textLength", "lengthAdjust",
  "marker-start", "marker-mid", "marker-end", "markerWidth", "markerHeight", "markerUnits",
  "refX", "refY", "orient",
  "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "spreadMethod",
  "fx", "fy", "fr",
  "clip-path", "clip-rule", "mask", "patternUnits", "patternContentUnits", "patternTransform",
  "id", "class", "style", "display", "visibility", "version",
  "xmlns", "xmlns:xlink", "href", "xlink:href",
  "startOffset", "method", "spacing", "side", "path",
]);

/**
 * The functions an attribute value or a stylesheet may call: colours,
 * arithmetic, transforms, and `url(#id)`. Any other `name(` — `image(`,
 * `image-set(`, `cross-fade(`, `src(`, `expression(`, `var(`… — is refused.
 */
const FUNCTIONS: ReadonlySet<string> = new Set([
  "rgb", "rgba", "hsl", "hsla", "calc", "url",
  "matrix", "translate", "translatex", "translatey", "scale", "scalex", "scaley",
  "rotate", "skew", "skewx", "skewy",
]);

/** A same-document reference: `#id`, nothing before the hash. */
const FRAGMENT = /^#[A-Za-z_][\w.:-]*$/;
/** `url(#id)`, quoted or not: the only `url(` an attribute or a stylesheet may hold. */
const LOCAL_URL = /url\(\s*(["']?)#[A-Za-z_][\w.:-]*\1\s*\)/gi;
/** A function call: a name, then `(`. */
const CALL = /([A-Za-z_-][\w-]*)\s*\(/g;

export interface SvgRefused {
  code: SvgRefusalCode;
  /** The element, attribute, namespace, function or construct at fault. */
  name?: string;
  /** The English wording, for an MCP client and the log. */
  message: string;
}

export type SvgVerdict = { ok: true } | ({ ok: false } & SvgRefused);

/** Thrown inside the parser's handlers; the first one ends the check. */
class Refusal extends Error {
  constructor(
    readonly code: SvgRefusalCode,
    message: string,
    readonly subject?: string,
  ) {
    super(message);
  }
}

/** Whether `bytes` mean to be markup at all (an SVG or another XML document), past a BOM and blanks. */
export function looksLikeMarkup(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 512).toString("utf8").replace(/^﻿/, "").trimStart();
  return head.startsWith("<");
}

/** One open element: its name, its id, and whether a `<use>` sits in it (or it is one). */
interface Frame {
  name: string;
  id: string | undefined;
  holdsUse: boolean;
}

/**
 * Accepts `bytes` as a question's SVG, or refuses it with the first
 * offending thing: a closed code, its name, and an English message.
 */
export function checkSvg(bytes: Buffer): SvgVerdict {
  try {
    run(bytes);
    return { ok: true };
  } catch (error) {
    if (error instanceof Refusal) {
      return { ok: false, code: error.code, ...(error.subject === undefined ? {} : { name: error.subject }), message: error.message };
    }
    return { ok: false, code: "malformed", message: `not well-formed XML (${(error as Error).message})` };
  }
}

function run(bytes: Buffer): void {
  if (bytes.length > SVG_MAX_BYTES) throw new Refusal("too_large", `larger than ${SVG_MAX_BYTES / 1024} KB`);
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    throw new Refusal("encoding", "not UTF-8 text");
  }
  const stack: Frame[] = [];
  /** The text of the `<style>` being read, checked whole at its close tag. */
  let css: string | null = null;
  let rootSeen = false;
  /** The ids of the elements that are or hold a `<use>`, and every `<use>`'s target. */
  const holdingUse = new Set<string>();
  const useTargets: string[] = [];

  const parser = new SaxesParser({ xmlns: true });
  parser.on("xmldecl", (decl) => {
    if (decl.encoding !== undefined && decl.encoding.toLowerCase() !== "utf-8") {
      throw new Refusal("encoding", `encoding ${decl.encoding} (UTF-8 only)`, decl.encoding);
    }
  });
  parser.on("doctype", () => {
    throw new Refusal("doctype", "a DOCTYPE");
  });
  parser.on("comment", () => {
    throw new Refusal("comment", "an XML comment");
  });
  parser.on("processinginstruction", (pi) => {
    throw new Refusal("instruction", `a processing instruction <?${pi.target}?>`, pi.target);
  });
  parser.on("cdata", (data) => {
    if (css === null) throw new Refusal("cdata", "a CDATA section outside <style>");
    css += data;
  });
  parser.on("text", (text) => {
    if (css !== null) {
      css += text;
      return;
    }
    const parent = stack.at(-1)?.name;
    if (text.trim() !== "" && (parent === undefined || !TEXT_PARENTS.has(parent))) {
      throw new Refusal("text", `text outside a text element${parent ? ` (in <${parent}>)` : ""}`, parent);
    }
  });
  parser.on("opentag", (tag) => {
    if (css !== null) throw new Refusal("element", `element <${tag.local}> inside <style>`, tag.local);
    const name = openElement(tag, rootSeen);
    rootSeen = true;
    const id = tag.attributes["id"]?.value;
    if (name === "use") {
      for (const frame of stack) frame.holdsUse = true;
      useTargets.push((tag.attributes["href"] ?? tag.attributes["xlink:href"])?.value.slice(1) ?? "");
    }
    stack.push({ name, id, holdsUse: name === "use" });
    if (stack.length > SVG_MAX_DEPTH) throw new Refusal("too_deep", `nested deeper than ${SVG_MAX_DEPTH} levels`);
    if (name === "style") css = "";
  });
  parser.on("closetag", () => {
    const frame = stack.pop()!;
    if (frame.holdsUse && frame.id !== undefined) holdingUse.add(frame.id);
    if (frame.name === "style") {
      checkCss(css ?? "", "<style>");
      css = null;
    }
  });

  parser.write(source).close();
  if (!rootSeen) throw new Refusal("not_svg", "no <svg> element");
  // A `<use>` repeats a plain drawing, never one that repeats another: no amplification by chains.
  const chained = useTargets.find((target) => holdingUse.has(target));
  if (chained !== undefined) {
    throw new Refusal("use_chain", `<use> of #${chained}, which is or holds a <use>`, chained);
  }
}

/** Checks one element and its attributes; its local name. */
function openElement(tag: SaxesTagNS, nested: boolean): string {
  const name = tag.local;
  if (!nested && (tag.uri !== SVG_NS || name !== "svg")) {
    throw new Refusal("not_svg", `the root is <${tag.name}>, not an <svg> in the SVG namespace`, tag.name);
  }
  if (tag.uri !== SVG_NS) throw new Refusal("namespace", `element <${tag.name}> outside the SVG namespace`, tag.uri || tag.name);
  if (!ELEMENTS.has(name)) throw new Refusal("element", `element <${name}>`, name);
  for (const attr of Object.values(tag.attributes)) checkAttribute(name, attr.name, attr.value);
  return name;
}

function checkAttribute(element: string, name: string, value: string): void {
  const where = `${name} on <${element}>`;
  // `type` is the stylesheet's own, and says CSS.
  if (element === "style" && name === "type") {
    if (value !== "text/css") throw new Refusal("attribute", `stylesheet type ${value}`, `type="${value}"`);
    return;
  }
  if (!ATTRIBUTES.has(name)) {
    const handler = /^on/i.test(name) ? "event handler " : "";
    throw new Refusal("attribute", `${handler}attribute ${where}`, name);
  }
  if (name === "xmlns" && value !== SVG_NS) throw new Refusal("namespace", `namespace ${value}`, value);
  if (name === "xmlns:xlink" && value !== XLINK_NS) throw new Refusal("namespace", `namespace ${value} for xlink`, value);
  if ((name === "href" || name === "xlink:href") && !FRAGMENT.test(value)) {
    throw new Refusal("href", `${where} is not a same-document #id reference`, name);
  }
  // After the parser decoded the entities: `&#x5C;` is a backslash too.
  if (value.includes("\\")) throw new Refusal("escape", `a backslash escape in ${where}`, name);
  if (name === "style") checkCss(value, where);
  else checkFunctions(value, where);
}

/** A stylesheet, whole: no import, no comment, no escape, no `javascript:`, then its functions. */
function checkCss(css: string, where: string): void {
  if (/@import/i.test(css)) throw new Refusal("css", `@import in ${where}`, "@import");
  if (css.includes("/*")) throw new Refusal("css", `a comment in ${where}`, "/*");
  if (css.includes("\\")) throw new Refusal("escape", `a backslash escape in ${where}`, where);
  if (/javascript:/i.test(css)) throw new Refusal("css", `javascript: in ${where}`, "javascript:");
  checkFunctions(css, where);
}

/** Every function call of `text` is on the allow-list, and every `url(` is `url(#id)`. */
function checkFunctions(text: string, where: string): void {
  const rest = text.replace(LOCAL_URL, "");
  for (const [, fn] of rest.matchAll(CALL)) {
    const lower = fn!.toLowerCase();
    if (lower === "url") throw new Refusal("url", `${where} has a url() that is not #id`);
    if (!FUNCTIONS.has(lower)) throw new Refusal("function", `function ${fn}() in ${where}`, fn);
  }
}
