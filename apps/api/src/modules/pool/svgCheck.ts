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
 *      allow-list of drawing elements and presentation attributes. What it
 *      accepts is stored byte for byte.
 *
 * It also keeps out what a student could READ in the source without it being
 * drawn — comments, `<title>`, `<desc>`, `<metadata>`, text outside a text
 * element: a student in an attempt may fetch the asset (invariant 4), so a
 * note to self in a diagram must not travel with it. A `<text>` hidden by
 * its styling stays a residual risk (ADR-134).
 *
 * Only the question-asset upload calls it: avatars and remote pictures stay
 * raster (`sniffImage`, `AvatarMime`).
 */
import { SaxesParser, type SaxesTagNS } from "saxes";

/** The most bytes an SVG may weigh: far below `ASSETS_MAX_BYTES`, ample for a diagram. */
export const SVG_MAX_BYTES = 512 * 1024;
/** The most elements, and the deepest nesting, an SVG may have. */
export const SVG_MAX_ELEMENTS = 5000;
export const SVG_MAX_DEPTH = 64;
/** The largest width, height or viewBox coordinate accepted. */
export const SVG_MAX_DIMENSION = 10_000;

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

/** Where non-blank text may stand: what is drawn, and the stylesheet. */
const TEXT_PARENTS: ReadonlySet<string> = new Set(["text", "tspan", "textPath", "style"]);

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

/** A same-document reference: `#id`, nothing before the hash. */
const FRAGMENT = /^#[A-Za-z_][\w.:-]*$/;
/** `url(#id)`, quoted or not: the only `url(` an attribute or a stylesheet may hold. */
const LOCAL_URL = /url\(\s*(["']?)#[A-Za-z_][\w.:-]*\1\s*\)/gi;
/** What a stylesheet may never say, each with the reason given. */
const CSS_REFUSED: readonly [RegExp, string][] = [
  [/@import/i, "@import"],
  [/\\/, "a backslash escape"],
  [/javascript:/i, "javascript:"],
  [/expression\s*\(/i, "expression("],
  [/image-set\s*\(|(?:^|[^\w-])src\s*\(/i, "an external resource"],
];

export type SvgVerdict =
  | { ok: true; width: number | null; height: number | null }
  | { ok: false; reason: string };

/** Thrown inside the parser's handlers; the first one ends the check. */
class Refusal extends Error {}

/** Whether `bytes` mean to be markup at all (an SVG or another XML document), past a BOM and blanks. */
export function looksLikeMarkup(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 512).toString("utf8").replace(/^﻿/, "").trimStart();
  return head.startsWith("<");
}

/**
 * Accepts `bytes` as a question's SVG, with the picture's size, or refuses
 * it with a reason that names the first offending thing.
 */
export function checkSvg(bytes: Buffer): SvgVerdict {
  if (bytes.length > SVG_MAX_BYTES) return { ok: false, reason: `larger than ${SVG_MAX_BYTES / 1024} KB` };
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return { ok: false, reason: "not UTF-8 text" };
  }
  const facts: { width: number | null; height: number | null } = { width: null, height: null };
  const stack: string[] = [];
  let elements = 0;
  let rootSeen = false;

  const parser = new SaxesParser({ xmlns: true, position: true });
  parser.on("xmldecl", (decl) => {
    if (decl.encoding !== undefined && decl.encoding.toLowerCase() !== "utf-8") {
      throw new Refusal(`encoding ${decl.encoding} (UTF-8 only)`);
    }
  });
  parser.on("doctype", () => {
    throw new Refusal("a DOCTYPE");
  });
  parser.on("comment", () => {
    throw new Refusal("an XML comment");
  });
  parser.on("processinginstruction", (pi) => {
    throw new Refusal(`a processing instruction <?${pi.target}?>`);
  });
  parser.on("cdata", (data) => {
    if (stack.at(-1) !== "style") throw new Refusal("a CDATA section outside <style>");
    checkCss(data, "<style>");
  });
  parser.on("text", (text) => {
    const parent = stack.at(-1);
    if (parent === "style") checkCss(text, "<style>");
    else if (text.trim() !== "" && (parent === undefined || !TEXT_PARENTS.has(parent))) {
      throw new Refusal(`text outside a text element${parent ? ` (in <${parent}>)` : ""}`);
    }
  });
  parser.on("opentag", (tag) => {
    const name = openElement(tag, rootSeen);
    if (!rootSeen) {
      rootSeen = true;
      Object.assign(facts, rootSize(tag));
    }
    elements += 1;
    if (elements > SVG_MAX_ELEMENTS) throw new Refusal(`more than ${SVG_MAX_ELEMENTS} elements`);
    stack.push(name);
    if (stack.length > SVG_MAX_DEPTH) throw new Refusal(`nested deeper than ${SVG_MAX_DEPTH} levels`);
  });
  parser.on("closetag", () => {
    stack.pop();
  });

  try {
    parser.write(source).close();
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.message };
    return { ok: false, reason: `not well-formed XML (${(error as Error).message})` };
  }
  if (!rootSeen) return { ok: false, reason: "no <svg> element" };
  return { ok: true, ...facts };
}

/** Checks one element and its attributes; its local name. */
function openElement(tag: SaxesTagNS, nested: boolean): string {
  const name = tag.local;
  if (tag.uri !== SVG_NS) {
    throw new Refusal(nested ? `element <${tag.name}> outside the SVG namespace` : "the root is not an <svg> in the SVG namespace");
  }
  if (!nested && name !== "svg") throw new Refusal(`the root is <${name}>, not <svg>`);
  if (!ELEMENTS.has(name)) throw new Refusal(`element <${name}>`);
  for (const attr of Object.values(tag.attributes)) checkAttribute(name, attr.name, attr.value);
  if (name === "style") checkStyleType(tag);
  return name;
}

function checkAttribute(element: string, name: string, value: string): void {
  const where = `${name} on <${element}>`;
  if (/^on/i.test(name)) throw new Refusal(`event handler attribute ${where}`);
  // `type` is the stylesheet's own, checked by `checkStyleType`.
  if (!ATTRIBUTES.has(name) && !(element === "style" && name === "type")) throw new Refusal(`attribute ${where}`);
  if (name === "xmlns" && value !== SVG_NS) throw new Refusal(`namespace ${value}`);
  if (name === "xmlns:xlink" && value !== XLINK_NS) throw new Refusal(`namespace ${value} for xlink`);
  if ((name === "href" || name === "xlink:href") && !FRAGMENT.test(value)) {
    throw new Refusal(`${where} is not a same-document #id reference`);
  }
  if (/url\s*\(/i.test(value.replace(LOCAL_URL, ""))) throw new Refusal(`${where} has a url() that is not #id`);
  if (name === "style") checkCss(value, where);
  if (name === "viewBox") checkViewBox(value, where);
}

/** `<style type>`: CSS only, said the one way. */
function checkStyleType(tag: SaxesTagNS): void {
  const type = tag.attributes["type"]?.value;
  if (type !== undefined && type !== "text/css") throw new Refusal(`stylesheet type ${type}`);
}

function checkCss(css: string, where: string): void {
  for (const [pattern, what] of CSS_REFUSED) if (pattern.test(css)) throw new Refusal(`${what} in ${where}`);
  if (/url\s*\(/i.test(css.replace(LOCAL_URL, ""))) throw new Refusal(`a url() that is not #id in ${where}`);
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/** Four numbers, the box positive and sane. */
function checkViewBox(value: string, where: string): [number, number, number, number] {
  const parts = value.trim().split(/[\s,]+/);
  const nums = parts.map(Number);
  if (parts.length !== 4 || !parts.every((p) => NUMBER.test(p))) throw new Refusal(`${where} is not four numbers`);
  const [minX, minY, w, h] = nums as [number, number, number, number];
  const sane = (n: number) => Math.abs(n) <= SVG_MAX_DIMENSION;
  if (!(w > 0 && h > 0) || ![minX, minY, w, h].every(sane)) {
    throw new Refusal(`${where} out of range (positive, at most ${SVG_MAX_DIMENSION})`);
  }
  return [minX, minY, w, h];
}

/**
 * The root's own size: its `width`/`height` when they are plain numbers (or
 * pixels), else the viewBox's, else null. A width or a height must be
 * positive and at most {@link SVG_MAX_DIMENSION}, whatever its unit.
 */
function rootSize(tag: SaxesTagNS): { width: number | null; height: number | null } {
  const box = tag.attributes["viewBox"]?.value;
  const view = box === undefined ? null : checkViewBox(box, "viewBox on <svg>");
  const length = (name: "width" | "height", fallback: number | null): number | null => {
    const raw = tag.attributes[name]?.value.trim();
    if (raw === undefined) return fallback;
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(px|%|em|ex|pt|pc|mm|cm|in)?$/i.exec(raw);
    const n = m ? Number(m[1]) : NaN;
    if (!(n > 0 && n <= SVG_MAX_DIMENSION)) throw new Refusal(`${name} on <svg> out of range (positive, at most ${SVG_MAX_DIMENSION})`);
    const unit = m![2]?.toLowerCase();
    return unit === undefined || unit === "px" ? Math.max(1, Math.round(n)) : fallback;
  };
  return {
    width: length("width", view ? Math.max(1, Math.round(view[2])) : null),
    height: length("height", view ? Math.max(1, Math.round(view[3])) : null),
  };
}
