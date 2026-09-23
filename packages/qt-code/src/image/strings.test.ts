/**
 * The image dictionaries sit ON TOP of `code`'s (the host spreads one over
 * the other, and the review spreads the player's too), so a key they share
 * silently replaces a `code` sentence. Only the deliberate re-wordings may.
 */
import { describe, expect, it } from "vitest";

import { EDITOR_STRINGS, PLAYER_STRINGS, REVIEW_STRINGS } from "../strings.js";
import { IMAGE_EDITOR_STRINGS, IMAGE_PLAYER_STRINGS, IMAGE_REVIEW_STRINGS } from "./strings.js";

const shared = (a: object, b: object): string[] =>
  Object.keys(a).filter((key) => Object.prototype.hasOwnProperty.call(b, key));

describe("the codeimage dictionaries", () => {
  it("replace a code sentence only where they mean to", () => {
    expect(shared(IMAGE_EDITOR_STRINGS, EDITOR_STRINGS)).toEqual(["referenceSolutionHint"]);
    expect(shared(IMAGE_PLAYER_STRINGS, PLAYER_STRINGS)).toEqual(["runHint"]);
    expect(shared(IMAGE_REVIEW_STRINGS, REVIEW_STRINGS)).toEqual([]);
  });

  it("do not collide between the player and the review, which the review merges", () => {
    expect(shared(IMAGE_PLAYER_STRINGS, REVIEW_STRINGS)).toEqual([]);
    expect(shared(IMAGE_PLAYER_STRINGS, IMAGE_REVIEW_STRINGS)).toEqual([]);
  });

  it("give every count-dependent sentence its singular", () => {
    for (const dict of [IMAGE_EDITOR_STRINGS, IMAGE_PLAYER_STRINGS, IMAGE_REVIEW_STRINGS]) {
      for (const key of Object.keys(dict)) {
        if (key.endsWith(".one")) expect(dict).toHaveProperty([key.slice(0, -4)]);
      }
    }
  });
});
