import { describe, expect, it } from "vitest";

import { dispositionOf, parseRange } from "./http.js";

describe("parseRange (RFC 9110 §14, one range)", () => {
  it("sends the whole file without a header, or with one it does not serve", () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange("items=0-9", 100)).toBeNull();
    expect(parseRange("bytes=", 100)).toBeNull();
    expect(parseRange("bytes=-", 100)).toBeNull();
    expect(parseRange("bytes=a-9", 100)).toBeNull();
    expect(parseRange("bytes=9-3", 100)).toBeNull();
    expect(parseRange("bytes=0-9,20-29", 100)).toBeNull();
  });

  it("reads a closed range, an open one and a suffix, clipped to the file", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange(" bytes=10-  ", 100)).toEqual({ start: 10, end: 99 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=99-99", 100)).toEqual({ start: 99, end: 99 });
  });

  it("refuses a range past the end and an empty suffix", () => {
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=100-200", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=-5", 0)).toBe("unsatisfiable");
  });
});

describe("dispositionOf", () => {
  it("quotes an ASCII fallback and carries the exact name", () => {
    expect(dispositionOf("attachment", 'Fiche "C" été.pdf')).toBe(
      "attachment; filename=\"Fiche _C_ _t_.pdf\"; filename*=UTF-8''Fiche%20%22C%22%20%C3%A9t%C3%A9.pdf",
    );
    expect(dispositionOf("attachment", "it's (1).md")).toBe("attachment; filename=\"it's (1).md\"; filename*=UTF-8''it%27s%20%281%29.md");
  });
});
