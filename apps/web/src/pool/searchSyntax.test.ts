import { describe, expect, it } from "vitest";

import {
  applyCompletion,
  completionAt,
  difficultyValues,
  parseSearch,
  versionBounds,
  withoutToken,
} from "./searchSyntax";

/*
 * The grammar of the pool's search box, value by value. It is the whole
 * specification of `searchSyntax.ts`: the screen only draws what these
 * functions return.
 */

describe("parseSearch", () => {
  it("keeps plain words as the free text", () => {
    expect(parseSearch("  pointeurs   null ").q).toBe("pointeurs null");
  });

  it("reads a tag with and without its hash", () => {
    expect(parseSearch("tag:pointeurs tag:#memoire").tags).toEqual(["pointeurs", "memoire"]);
  });

  it("lowercases a tag and never lists it twice", () => {
    expect(parseSearch("tag:Memoire tag:memoire").tags).toEqual(["memoire"]);
  });

  it("takes a quoted phrase whole, quotes stripped", () => {
    const parsed = parseSearch('"null pointer" tag:"deux mots"');
    expect(parsed.q).toBe("null pointer");
    expect(parsed.tags).toEqual(["deux mots"]);
  });

  it("reads the four type ids and leaves an unknown one as text", () => {
    expect(parseSearch("type:mcq type:code").types).toEqual(["mcq", "code"]);
    const unknown = parseSearch("type:essay");
    expect(unknown.types).toEqual([]);
    expect(unknown.q).toBe("type:essay");
  });

  it("expands every difficulty form into the list the API takes", () => {
    expect(parseSearch("difficulty:3").difficulties).toEqual([3]);
    expect(parseSearch("difficulty:>3").difficulties).toEqual([4, 5]);
    expect(parseSearch("difficulty:>=2").difficulties).toEqual([2, 3, 4, 5]);
    expect(parseSearch("difficulty:<3").difficulties).toEqual([1, 2]);
    expect(parseSearch("difficulty:<=2").difficulties).toEqual([1, 2]);
    expect(parseSearch("difficulty:2-4").difficulties).toEqual([2, 3, 4]);
  });

  it("clamps a difficulty to the 1…5 scale and drops a broken one", () => {
    expect(parseSearch("difficulty:>=0").difficulties).toEqual([1, 2, 3, 4, 5]);
    expect(parseSearch("difficulty:hard").q).toBe("difficulty:hard");
  });

  it("turns every version form into bounds", () => {
    expect(parseSearch("version:v1")).toMatchObject({ versionMin: 1, versionMax: 1 });
    expect(parseSearch("version:1")).toMatchObject({ versionMin: 1, versionMax: 1 });
    expect(parseSearch("version:>1")).toMatchObject({ versionMin: 2, versionMax: null });
    expect(parseSearch("version:>=2")).toMatchObject({ versionMin: 2, versionMax: null });
    expect(parseSearch("version:<3")).toMatchObject({ versionMin: null, versionMax: 2 });
    expect(parseSearch("version:2-4")).toMatchObject({ versionMin: 2, versionMax: 4 });
  });

  it("intersects two version bounds", () => {
    expect(parseSearch("version:>1 version:<5")).toMatchObject({ versionMin: 2, versionMax: 4 });
  });

  it("reads a whole line of filters and the words left over", () => {
    const parsed = parseSearch("tag:#pointeurs type:code difficulty:>=4 version:>1 segfault");
    expect(parsed).toEqual({
      q: "segfault",
      tags: ["pointeurs"],
      types: ["code"],
      difficulties: [4, 5],
      versionMin: 2,
      versionMax: null,
    });
  });

  it("is not a token without a value", () => {
    expect(parseSearch("tag:").tags).toEqual([]);
    expect(parseSearch("tag:").q).toBe("tag:");
  });
});

describe("difficultyValues / versionBounds", () => {
  it("answers nothing for what it cannot read", () => {
    expect(difficultyValues("")).toEqual([]);
    expect(versionBounds("v")).toBe(null);
  });
});

describe("withoutToken", () => {
  it("takes one tag out and leaves the rest of the line alone", () => {
    expect(withoutToken("tag:a tag:b segfault", "tag", "a")).toBe("tag:b segfault");
    expect(withoutToken("tag:#a segfault", "tag", "a")).toBe("segfault");
  });

  it("takes the whole range when a value it produced is removed", () => {
    expect(withoutToken("difficulty:>3 ptr", "difficulty", "4")).toBe("ptr");
    expect(withoutToken("difficulty:>3 ptr", "difficulty", "2")).toBe("difficulty:>3 ptr");
  });

  it("takes every version token at once, since the chip is one filter", () => {
    expect(withoutToken("version:>1 version:<5 ptr", "version")).toBe("ptr");
  });

  it("leaves a line with no such token untouched", () => {
    expect(withoutToken("segfault", "type", "code")).toBe("segfault");
  });
});

describe("completionAt", () => {
  it("opens on an empty tag token", () => {
    expect(completionAt("tag:", 4)).toMatchObject({ kind: "tag", prefix: "", hash: false });
  });

  it("carries what follows the colon, hash included", () => {
    expect(completionAt("tag:#poi", 8)).toMatchObject({ kind: "tag", prefix: "poi", hash: true });
    expect(completionAt("type:co", 7)).toMatchObject({ kind: "type", prefix: "co" });
  });

  it("stays shut on free text, on a finished token and on the other two kinds", () => {
    expect(completionAt("pointeurs", 9)).toBe(null);
    expect(completionAt("tag:a ", 6)).toBe(null);
    expect(completionAt("difficulty:", 11)).toBe(null);
  });

  it("only answers for the token the caret is in", () => {
    expect(completionAt("tag:a type:m", 5)).toMatchObject({ kind: "tag", prefix: "a" });
    expect(completionAt("tag:a type:m", 12)).toMatchObject({ kind: "type", prefix: "m" });
  });
});

describe("applyCompletion", () => {
  it("replaces the value, adds one space and puts the caret after it", () => {
    const at = completionAt("tag:poi", 7)!;
    expect(applyCompletion("tag:poi", at, "pointeurs")).toEqual({
      text: "tag:pointeurs ",
      caret: 14,
    });
  });

  it("keeps the hash the token was written with", () => {
    const at = completionAt("tag:#poi", 8)!;
    expect(applyCompletion("tag:#poi", at, "pointeurs").text).toBe("tag:#pointeurs ");
  });

  it("replaces the whole word when the caret sits in its middle", () => {
    const at = completionAt("tag:poXnteurs ptr", 6)!;
    expect(applyCompletion("tag:poXnteurs ptr", at, "pointeurs").text).toBe("tag:pointeurs ptr");
  });

  it("does not double the space that is already there", () => {
    const at = completionAt("tag:poi ptr", 7)!;
    expect(applyCompletion("tag:poi ptr", at, "pointeurs").text).toBe("tag:pointeurs ptr");
  });
});
