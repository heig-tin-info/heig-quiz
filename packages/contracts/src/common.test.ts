import { describe, expect, it } from "vitest";
import { z } from "zod";

import { BoolFlag, IntList, StringList, ZodIssueLite, issuesOf, pageOf } from "./common.js";

const Row = z.object({ id: z.string() });

describe("pageOf", () => {
  it("accepts a page and its cursor", () => {
    const Page = pageOf(Row);
    expect(Page.parse({ items: [{ id: "a" }], nextCursor: "a" })).toEqual({
      items: [{ id: "a" }],
      nextCursor: "a",
    });
  });

  it("reads a null cursor as the last page", () => {
    expect(pageOf(Row).parse({ items: [], nextCursor: null }).nextCursor).toBeNull();
  });

  it("requires the cursor to be present, so 'last page' is never an accident", () => {
    expect(pageOf(Row).safeParse({ items: [] }).success).toBe(false);
  });

  it("validates the items with the schema it was given", () => {
    expect(pageOf(Row).safeParse({ items: [{ id: 1 }], nextCursor: null }).success).toBe(false);
  });
});

describe("StringList", () => {
  it("reads one occurrence, several occurrences and a comma-separated one alike", () => {
    expect(StringList.parse("a")).toEqual(["a"]);
    expect(StringList.parse(["a", "b"])).toEqual(["a", "b"]);
    expect(StringList.parse("a, b")).toEqual(["a", "b"]);
  });
});

describe("IntList", () => {
  it("reads the numeric filters in the same three shapes", () => {
    expect(IntList.parse("1,2")).toEqual([1, 2]);
    expect(IntList.parse(["3"])).toEqual([3]);
    expect(IntList.parse([4])).toEqual([4]);
  });
});

describe("BoolFlag", () => {
  it("is true for 1, true and the boolean, false for everything else", () => {
    expect(BoolFlag.parse("1")).toBe(true);
    expect(BoolFlag.parse("true")).toBe(true);
    expect(BoolFlag.parse(true)).toBe(true);
    expect(BoolFlag.parse("0")).toBe(false);
    expect(BoolFlag.parse("yes")).toBe(false);
    expect(BoolFlag.parse(false)).toBe(false);
  });
});

describe("issuesOf", () => {
  it("reduces a zod error to what the editor underlines", () => {
    const error = z.object({ a: z.object({ b: z.string() }) }).safeParse({ a: { b: 1 } }).error!;
    const issues = issuesOf(error);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toEqual(["a", "b"]);
    expect(z.array(ZodIssueLite).safeParse(issues).success).toBe(true);
  });

  it("collapses anything that is not a zod error to one pathless issue", () => {
    expect(issuesOf(new Error("boom"))).toEqual([{ path: [], code: "invalid", message: "boom" }]);
    expect(issuesOf("boom")).toEqual([{ path: [], code: "invalid", message: "boom" }]);
  });
});
