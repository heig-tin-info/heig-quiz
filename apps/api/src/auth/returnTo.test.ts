import { describe, expect, it } from "vitest";

import { returnToOf, safeReturnTo } from "./returnTo.js";

describe("safeReturnTo", () => {
  it("keeps a same-origin path, with its query and fragment", () => {
    expect(safeReturnTo("/p/ABC123")).toBe("/p/ABC123");
    expect(safeReturnTo("/courses/42?tab=results#top")).toBe("/courses/42?tab=results#top");
    expect(safeReturnTo("/")).toBe("/");
  });

  it("refuses anything that leaves the origin", () => {
    for (const raw of [
      "//evil.example",
      "https://evil.example",
      "evil.example",
      "/\\evil.example",
      "/\\\\evil.example",
      "/..//evil.example",
      "/.//evil.example",
    ]) {
      expect(safeReturnTo(raw), raw).toBe("/");
    }
  });

  it("refuses the tab, newline and whitespace a browser strips", () => {
    // `/\t/evil.example` is `//evil.example` once the browser drops the tab.
    for (const raw of ["/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "/ /x", "/\x00"]) {
      expect(safeReturnTo(raw), JSON.stringify(raw)).toBe("/");
    }
  });

  it("leaves an encoded tab encoded, hence a mere path", () => {
    expect(safeReturnTo("/%09/evil.example")).toBe("/%09/evil.example");
  });

  it("falls back to the home page on a non-string", () => {
    expect(safeReturnTo(undefined)).toBe("/");
    expect(safeReturnTo(["/p/ABC123"])).toBe("/");
  });
});

describe("returnToOf", () => {
  it("prefers ?next= over ?returnTo=, and validates either", () => {
    expect(returnToOf({ next: "/p/ABC123", returnTo: "/home" })).toBe("/p/ABC123");
    expect(returnToOf({ returnTo: "//evil.example" })).toBe("/");
  });
});
