import { describe, expect, it } from "vitest";
import { compareOutput } from "./compareOutput.js";

describe("compareOutput", () => {
  it("folds CRLF on both sides", () => {
    expect(compareOutput("6\r\n", "6\n")).toBe(true);
  });

  it("trims trailing whitespace and trailing newlines by default", () => {
    expect(compareOutput("6\n", "6   \n\n\n")).toBe(true);
    expect(compareOutput("6\n", "6   \n\n\n", { trimTrailing: false })).toBe(false);
    expect(compareOutput("a\nb", "a  \nb")).toBe(true);
  });

  it("is case-sensitive unless asked otherwise", () => {
    expect(compareOutput("OK", "ok")).toBe(false);
    expect(compareOutput("OK", "ok", { ignoreCase: true })).toBe(true);
  });

  it("keeps a leading difference significant", () => {
    expect(compareOutput("6", " 6")).toBe(false);
  });

  it("compares numbers token by token when a numeric mode is set", () => {
    const abs = { numeric: { epsilon: 0.01, mode: "abs" as const } };
    expect(compareOutput("3.14159", "3.14", abs)).toBe(true);
    expect(compareOutput("3.14159", "3.1", abs)).toBe(false);
    expect(compareOutput("1 2 3", "1  2   3", abs)).toBe(true);
    expect(compareOutput("1 2", "1 2 3", abs)).toBe(false);
  });

  it("uses a relative epsilon when asked", () => {
    const rel = { numeric: { epsilon: 0.01, mode: "rel" as const } };
    expect(compareOutput("1000", "1005", rel)).toBe(true);
    expect(compareOutput("1000", "1020", rel)).toBe(false);
  });

  it("falls back to string equality for non-numeric tokens", () => {
    const abs = { numeric: { epsilon: 1, mode: "abs" as const } };
    expect(compareOutput("total 6", "total 6.5", abs)).toBe(true);
    expect(compareOutput("total 6", "somme 6", abs)).toBe(false);
    expect(compareOutput("", "", abs)).toBe(true);
  });

  it("treats an explicit null numeric option as strict equality", () => {
    expect(compareOutput("6", "6.0", { numeric: null })).toBe(false);
  });
});
