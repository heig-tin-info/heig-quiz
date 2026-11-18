import { describe, expect, it } from "vitest";

import { ApiError } from "../api";
import { en } from "../i18n/en";
import { fr } from "../i18n/fr";
import type { TFunction } from "../i18n";
import { uploadRefusalText } from "./uploadRefusal";

/** A translator over one dictionary, `{name}` filled in. */
const tOf =
  (dict: Record<string, string>): TFunction =>
  (key, vars) =>
    dict[key]!.replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? ""));

const svgRefused = (code: string, name?: string) =>
  new ApiError(415, { error: "svg_refused", code, ...(name ? { name } : {}), message: "This SVG is refused: element <script>" });

describe("uploadRefusalText", () => {
  it("words the SVG check's code in the reader's language, never the server's English", () => {
    expect(uploadRefusalText(svgRefused("element", "script"), tOf(en))).toBe("SVG refused: the element <script> is not allowed.");
    const french = uploadRefusalText(svgRefused("element", "script"), tOf(fr));
    expect(french).toContain("<script>");
    expect(french).not.toContain("refused");
    // A limit comes from the server, never from the dictionary.
    expect(uploadRefusalText(svgRefused("too_large", "512 KB"), tOf(en))).toBe("This SVG is over 512 KB.");
    expect(uploadRefusalText(svgRefused("too_complex", "20000"), tOf(fr))).toContain("20000");
  });

  it("names the accepted types for another refused file, and says nothing of any other failure", () => {
    expect(uploadRefusalText(new ApiError(415, { error: "unsupported_media_type" }), tOf(en))).toBe(en["md.image.typeRefused"]);
    expect(uploadRefusalText(new ApiError(500, null), tOf(en))).toBeNull();
    expect(uploadRefusalText(new Error("offline"), tOf(en))).toBeNull();
  });
});
