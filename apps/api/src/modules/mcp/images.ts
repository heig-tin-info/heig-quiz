/**
 * The images a question tool refuses (ADR-134): a Markdown field draws only
 * `![alt](asset:<id>)` (`ASSET_REF`); anything else — an `https://` picture,
 * a `data:` URI, a relative path, raw `<img>` — is dropped to its alt text
 * where a student reads it. A model that writes one believes it placed a
 * figure; refusing the call says so, and points it to `upload_asset`.
 *
 * The images are read by the renderers' own lexer (`markdownImages`), so a
 * picture inside a code span or a fence, or an escaped `\![x](y)`, is text.
 * Only the MCP tools check this, on the strings the CALL ITSELF sends: the
 * web editor writes asset references by construction, and a draft inherited
 * from an earlier save is not the model's to answer for.
 */
import { ASSET_REF, markdownImages } from "@quiz/docexport/images";

/** One refused image, in the shape of a validation issue (`checkConfig`'s). */
export interface ImageIssue {
  path: string;
  message: string;
}

const MESSAGE =
  "An image in a question is only `![alt](asset:<id>)`, the Markdown `upload_asset` returns: call upload_asset " +
  "with the SVG source and use its `markdown`. Nothing was written.";

/**
 * Every refused image of the Markdown a call sends: each string of `config`
 * (by its path, relative to the config as `checkConfig` gives it) and the
 * `explanation`. Null when there is none.
 */
export function imageIssues(sent: { config?: unknown; explanation?: string | undefined }): ImageIssue[] | null {
  const issues: ImageIssue[] = [];
  const visit = (value: unknown, path: string[]) => {
    if (typeof value === "string") {
      for (const image of markdownImages(value)) {
        if (image.kind === "markdown" && ASSET_REF.test(image.href)) continue;
        issues.push({ path: path.join("."), message: `${MESSAGE} Refused: ${image.raw.slice(0, 120)}` });
      }
    } else if (Array.isArray(value)) value.forEach((v, i) => visit(v, [...path, String(i)]));
    else if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) visit(v, [...path, k]);
    }
  };
  if (sent.config !== undefined) visit(sent.config, []);
  if (sent.explanation !== undefined) visit(sent.explanation, ["explanation"]);
  return issues.length === 0 ? null : issues;
}
