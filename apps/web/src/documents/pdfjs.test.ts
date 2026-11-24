import { describe, expect, it } from "vitest";

import { documentParams, PDFJS_ASSETS, RANGE_CHUNK } from "./pdfjs";

describe("how a PDF is fetched and read (the viewer's hardening)", () => {
  const params = documentParams("/app/api/courses/c/documents/d/file");

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

  it("takes every resource from our own origin", () => {
    expect(PDFJS_ASSETS).toBe("/pdfjs/");
    for (const key of ["cMapUrl", "standardFontDataUrl", "iccUrl", "wasmUrl"] as const) {
      expect(params[key]).toMatch(/^\/pdfjs\/[a-z_]+\/$/);
    }
  });
});
