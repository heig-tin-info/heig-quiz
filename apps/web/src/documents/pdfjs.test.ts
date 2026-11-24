import { describe, expect, it } from "vitest";

import { documentParams, pdfjsAssets, RANGE_CHUNK } from "./pdfjs";

/*
 * The one place these options are written down: the viewer's test checks
 * that a PDF is opened with `documentParams`, this one what they are.
 */
describe("how a PDF is fetched and read (the viewer's hardening)", () => {
  const params = documentParams("/app/api/courses/c/documents/d/file", "6.5.438");

  it("reads by 1 MiB ranges, only what is shown", () => {
    expect(RANGE_CHUNK).toBe(1048576);
    expect(params).toMatchObject({ disableAutoFetch: true, disableStream: true, rangeChunkSize: 1048576 });
  });

  it("sends the app's same-origin cookies, never cross-origin ones", () => {
    expect(params.withCredentials).toBe(false);
  });

  it("renders no XFA form", () => {
    expect(params.enableXfa).toBe(false);
  });

  it("draws a font the PDF does not embed from the fonts we serve, never the machine's", () => {
    expect(params.useSystemFonts).toBe(false);
  });

  it("takes every resource from our own origin, in the folder of the pdf.js version loaded", () => {
    expect(pdfjsAssets("6.5.438")).toBe("/pdfjs/6.5.438/");
    for (const key of ["cMapUrl", "standardFontDataUrl", "iccUrl", "wasmUrl"] as const) {
      expect(params[key]).toMatch(/^\/pdfjs\/6\.5\.438\/[a-z_]+\/$/);
    }
  });
});
