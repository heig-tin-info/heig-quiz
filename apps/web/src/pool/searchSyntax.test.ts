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
  it.each([
    ["keeps plain words as the free text", "  pointeurs   null ", { q: "pointeurs null" }],
    ["reads a tag with and without its hash", "tag:pointeurs tag:#memoire", { tags: ["pointeurs", "memoire"] }],
    ["lowercases a tag and never lists it twice", "tag:Memoire tag:memoire", { tags: ["memoire"] }],
    [
      "takes a quoted phrase whole, quotes stripped",
      '"null pointer" tag:"deux mots"',
      { q: "null pointer", tags: ["deux mots"] },
    ],
    ["reads the type ids", "type:mcq type:code", { types: ["mcq", "code"] }],
    ["leaves an unknown type as text", "type:essay", { types: [], q: "type:essay" }],
    ["drops a broken difficulty back to text", "difficulty:hard", { q: "difficulty:hard" }],
    ["is not a token without a value", "tag:", { tags: [], q: "tag:" }],
    ["intersects two version bounds", "version:>1 version:<5", { versionMin: 2, versionMax: 4 }],
  ])("%s", (_, line, expected) => {
    expect(parseSearch(line)).toMatchObject(expected);
  });

  // Every difficulty form, expanded into the list the API takes and clamped
  // to the 1…5 scale.
  it.each([
    ["difficulty:3", [3]],
    ["difficulty:>3", [4, 5]],
    ["difficulty:>=2", [2, 3, 4, 5]],
    ["difficulty:<3", [1, 2]],
    ["difficulty:<=2", [1, 2]],
    ["difficulty:2-4", [2, 3, 4]],
    ["difficulty:>=0", [1, 2, 3, 4, 5]],
  ])("expands %s", (line, difficulties) => {
    expect(parseSearch(line).difficulties).toEqual(difficulties);
  });

  it.each([
    ["version:v1", 1, 1],
    ["version:1", 1, 1],
    ["version:>1", 2, null],
    ["version:>=2", 2, null],
    ["version:<3", null, 2],
    ["version:2-4", 2, 4],
  ])("turns %s into bounds", (line, versionMin, versionMax) => {
    expect(parseSearch(line)).toMatchObject({ versionMin, versionMax });
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
});

describe("difficultyValues / versionBounds", () => {
  it("answers nothing for what it cannot read", () => {
    expect(difficultyValues("")).toEqual([]);
    expect(versionBounds("v")).toBe(null);
  });
});

describe("withoutToken", () => {
  it.each([
    ["takes one tag out and leaves the rest", "tag:a tag:b segfault", "tag", "a", "tag:b segfault"],
    ["takes a hashed tag out", "tag:#a segfault", "tag", "a", "segfault"],
    ["takes the whole range a removed value came from", "difficulty:>3 ptr", "difficulty", "4", "ptr"],
    ["keeps a range the value is not in", "difficulty:>3 ptr", "difficulty", "2", "difficulty:>3 ptr"],
    // The version chip is one filter: every version token goes at once.
    ["takes every version token at once", "version:>1 version:<5 ptr", "version", undefined, "ptr"],
    ["leaves a line with no such token untouched", "segfault", "type", "code", "segfault"],
  ] as const)("%s", (_, line, kind, value, expected) => {
    expect(withoutToken(line, kind, value)).toBe(expected);
  });
});

describe("completionAt", () => {
  it.each([
    ["opens on an empty tag token", "tag:", 4, { kind: "tag", prefix: "", hash: false }],
    ["carries what follows the colon, hash included", "tag:#poi", 8, { kind: "tag", prefix: "poi", hash: true }],
    ["carries a type prefix", "type:co", 7, { kind: "type", prefix: "co" }],
    // Only the token the caret is in.
    ["answers for the first token under the caret", "tag:a type:m", 5, { kind: "tag", prefix: "a" }],
    ["answers for the second token under the caret", "tag:a type:m", 12, { kind: "type", prefix: "m" }],
  ])("%s", (_, line, caret, expected) => {
    expect(completionAt(line, caret)).toMatchObject(expected);
  });

  it.each([
    ["free text", "pointeurs", 9],
    ["a finished token", "tag:a ", 6],
    ["a kind it does not complete", "difficulty:", 11],
  ])("stays shut on %s", (_, line, caret) => {
    expect(completionAt(line, caret)).toBe(null);
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

  it.each([
    ["keeps the hash the token was written with", "tag:#poi", 8, "tag:#pointeurs "],
    ["replaces the whole word when the caret sits in its middle", "tag:poXnteurs ptr", 6, "tag:pointeurs ptr"],
    ["does not double the space that is already there", "tag:poi ptr", 7, "tag:pointeurs ptr"],
  ])("%s", (_, line, caret, expected) => {
    expect(applyCompletion(line, completionAt(line, caret)!, "pointeurs").text).toBe(expected);
  });
});
