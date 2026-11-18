/**
 * The images a question tool refuses (ADR-134): a Markdown field draws only
 * `![alt](asset:<id>)`, the renderer's `ASSET_REF`; anything else — an
 * `https://` picture, a `data:` URI, a relative path, raw `<img>` — is
 * dropped to its alt text where a student reads it. A model that writes one
 * believes it placed a figure; refusing the call says so, and points it to
 * `upload_asset`.
 *
 * Only the MCP tools check this, on the strings the CALL ITSELF sends: the
 * web editor writes asset references by construction, and a draft inherited
 * from an earlier save is not the model's to answer for. The scan is textual:
 * an image written inside a code sample is refused too, a false positive the
 * model recovers from (an inline code span of `![…](…)` is rare in a statement).
 */
import { ASSET_REF } from "@quiz/contracts";

/** `![alt](src "title")`: the src, angle brackets allowed. */
const INLINE_IMAGE = /!\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^\s)]*)/g;
/** `![alt][ref]` and `![alt][]`: a reference-style image, whose src is defined elsewhere. */
const REFERENCE_IMAGE = /!\[(?:[^\]\\]|\\.)*\]\[[^\]]*\]/g;
/** A raw HTML image. */
const RAW_IMG = /<img\b/gi;

/** One refused image, in the shape of a validation issue (`checkConfig`'s). */
export interface ImageIssue {
  path: string;
  message: string;
}

const MESSAGE =
  "An image in a question is only `![alt](asset:<id>)`, the Markdown `upload_asset` returns: call upload_asset " +
  "with the SVG source and use its `markdown`. Nothing was written.";

/** The images of `text` that the renderer would not draw, each worded once. */
export function foreignImages(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(INLINE_IMAGE)) {
    const src = m[1]!.replace(/^<|>$/g, "").trim();
    if (!ASSET_REF.test(src)) found.push(m[0]);
  }
  for (const m of text.matchAll(REFERENCE_IMAGE)) found.push(m[0]);
  for (const m of text.matchAll(RAW_IMG)) found.push(m[0]);
  return found;
}

/**
 * Every refused image of the Markdown a call sends: each string of `config`
 * (by its path) and the `explanation`. Null when there is none.
 */
export function imageIssues(sent: { config?: unknown; explanation?: string | undefined }): ImageIssue[] | null {
  const issues: ImageIssue[] = [];
  const visit = (value: unknown, path: string[]) => {
    if (typeof value === "string") {
      for (const image of foreignImages(value)) {
        issues.push({ path: path.join("."), message: `${MESSAGE} Refused: ${image.slice(0, 120)}` });
      }
    } else if (Array.isArray(value)) value.forEach((v, i) => visit(v, [...path, String(i)]));
    else if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) visit(v, [...path, k]);
    }
  };
  // Config paths as `checkConfig` gives them, relative to the config.
  if (sent.config !== undefined) visit(sent.config, []);
  if (sent.explanation !== undefined) visit(sent.explanation, ["explanation"]);
  return issues.length === 0 ? null : issues;
}
