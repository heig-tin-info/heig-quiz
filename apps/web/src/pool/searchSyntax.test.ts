import { describe, expect, it } from "vitest";

import {
  applyCompletion,
  typingKindAt,
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
    ["reads a course word, the last one winning", "course:PRG1 ptr course:\"Programmation 2\"", { q: "ptr", courseWord: "Programmation 2" }],
    ["reads a concept word after its hash", "#pointeurs #Mémoire", { conceptWords: ["pointeurs", "Mémoire"] }],
    [
      "reads the tags' spelling as concept words",
      "tag:pointeurs tag:#memoire",
      { conceptWords: ["pointeurs", "memoire"] },
    ],
    ["never lists a word twice whatever its case", "#Memoire tag:memoire", { conceptWords: ["Memoire"] }],
    [
      "takes a quoted phrase whole, quotes stripped",
      '"null pointer" #"deux mots" tag:"trois mots ici"',
      { q: "null pointer", conceptWords: ["deux mots", "trois mots ici"] },
    ],
    ["is not a concept with a bare hash", "# x", { conceptWords: [], q: "# x" }],
    ["leaves concept: as free text", "concept:boucle", { conceptWords: [], q: "concept:boucle" }],
    ["reads the type ids", "type:mcq type:code", { types: ["mcq", "code"] }],
    ["leaves an unknown type as text", "type:essay", { types: [], q: "type:essay" }],
    ["drops a broken difficulty back to text", "difficulty:hard", { q: "difficulty:hard" }],
    ["is not a token without a value", "tag:", { conceptWords: [], q: "tag:" }],
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
    const parsed = parseSearch("#pointeurs type:code difficulty:>=4 version:>1 segfault");
    expect(parsed).toEqual({
      q: "segfault",
      conceptWords: ["pointeurs"],
      courseWord: null,
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
    ["takes the course token out", "course:PRG1 segfault", "course", undefined, "segfault"],
    ["takes one concept word out and leaves the rest", "#a #b segfault", "concept", "a", "#b segfault"],
    ["takes a word out whatever its spelling", "tag:#A tag:b #\"a\" segfault", "concept", "a", "tag:b segfault"],
    ["takes every concept word at once", "#a tag:b ptr", "concept", undefined, "ptr"],
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
    ["opens on a bare hash", "#", 1, { kind: "concept", prefix: "" }],
    ["carries what follows the hash", "ptr #poi", 8, { kind: "concept", prefix: "poi", start: 5 }],
    ["opens on the tags' spelling", "tag:", 4, { kind: "concept", prefix: "" }],
    ["carries what follows the colon, hash left out", "tag:#poi", 8, { kind: "concept", prefix: "poi", start: 5 }],
    ["carries a type prefix", "type:co", 7, { kind: "type", prefix: "co" }],
    // Only the token the caret is in.
    ["answers for the first token under the caret", "#a type:m", 2, { kind: "concept", prefix: "a" }],
    ["answers for the second token under the caret", "#a type:m", 9, { kind: "type", prefix: "m" }],
  ])("%s", (_, line, caret, expected) => {
    expect(completionAt(line, caret)).toMatchObject(expected);
  });

  it.each([
    ["free text", "pointeurs", 9],
    ["a finished token", "#a ", 3],
    ["a hash after a type", "type:#", 6],
    ["a kind it does not complete", "difficulty:", 11],
  ])("stays shut on %s", (_, line, caret) => {
    expect(completionAt(line, caret)).toBe(null);
  });
});

describe("applyCompletion", () => {
  it("replaces the value, adds one space and puts the caret after it", () => {
    const at = completionAt("#poi", 4)!;
    expect(applyCompletion("#poi", at, "Pointeur")).toEqual({
      text: "#Pointeur ",
      caret: 10,
    });
  });

  it("quotes a name of several words", () => {
    const at = completionAt("#adr", 4)!;
    expect(applyCompletion("#adr", at, "Adresse (mémoire)").text).toBe('#"Adresse (mémoire)" ');
    expect(parseSearch('#"Adresse (mémoire)" ').conceptWords).toEqual(["Adresse (mémoire)"]);
  });

  it.each([
    ["keeps the hash the token was written with", "tag:#poi", 8, "tag:#pointeurs "],
    ["replaces the whole word when the caret sits in its middle", "tag:poXnteurs ptr", 6, "tag:pointeurs ptr"],
    ["does not double the space that is already there", "tag:poi ptr", 7, "tag:pointeurs ptr"],
  ])("%s", (_, line, caret, expected) => {
    expect(applyCompletion(line, completionAt(line, caret)!, "pointeurs").text).toBe(expected);
  });
});

describe("typingKindAt", () => {
  it.each([
    ["a concept word", "ptr #poin", "concept"],
    ["a course word", "ptr course:PR", "course"],
    ["an open quoted course name", 'course:"Prog', "course"],
    ["an open quoted course name of two words", 'course:"Programmation 2', "course"],
    ["nothing once the word is closed by a space", "course:PR ", null],
    ["nothing once the quote is closed", 'course:"Prog 2"', null],
    ["nothing for free text", "ptr", null],
  ] as const)("reads %s", (_, line, kind) => {
    expect(typingKindAt(line, line.length)).toBe(kind);
  });
});
