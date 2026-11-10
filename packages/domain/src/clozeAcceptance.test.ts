/**
 * Accepting a cloze answer at grading time (ADR-128): what "the same answer"
 * is, blank by blank, and the grade with an accepted set.
 */
import { describe, expect, it } from "vitest";

import {
  clozeAcceptedLabel,
  clozeAnswerIdentity,
  clozePart,
  clozePartIndex,
  gradeCloze,
  parseCloze,
  selectOptionOrder,
  type ClozeBlank,
} from "./cloze.js";

const parse = parseCloze("T {{int|integer}} · D {{=int|invalid|long}} · N {{#3:0.1}} · R {{/a+/}}");
const [text, select, number, regex] = parse.blanks as [ClozeBlank, ClozeBlank, ClozeBlank, ClozeBlank];

describe("clozeAnswerIdentity", () => {
  it("folds the case and the spaces of a text blank, as its matching does", () => {
    expect(clozeAnswerIdentity(text, "  Entier  Signé ", false)).toBe("entier signé");
    expect(clozeAnswerIdentity(text, "entier   signé", false)).toBe("entier signé");
  });

  it("keeps the case of a case-sensitive text blank", () => {
    expect(clozeAnswerIdentity(text, " Entier ", true)).toBe("Entier");
    expect(clozeAnswerIdentity(text, "entier", true)).not.toBe(clozeAnswerIdentity(text, "Entier", true));
  });

  it("is the canonical option of a dropdown, whatever its shuffle", () => {
    expect(clozeAnswerIdentity(select, "1", false)).toBe("1");
    // Two students, two orders: each picks "invalid" at a different position,
    // and the answer stored is the canonical one (ADR-097), so both have one
    // identity.
    if (select.kind !== "select") throw new Error("a dropdown expected");
    const options = select.options;
    const first = selectOptionOrder(select, 1, "item", true);
    const second = selectOptionOrder(select, 99, "item", true);
    const stored = (order: number[]) => String(order[order.findIndex((c) => options[c] === "invalid")]);
    expect(clozeAnswerIdentity(select, stored(first), false)).toBe("1");
    expect(clozeAnswerIdentity(select, stored(second), false)).toBe("1");
    expect(clozeAnswerIdentity(select, "7", false)).toBeNull();
    expect(clozeAnswerIdentity(select, "x", false)).toBeNull();
  });

  it("offers no identity to a number or a regex blank, nor to an empty one", () => {
    expect(clozeAnswerIdentity(number, "3", false)).toBeNull();
    expect(clozeAnswerIdentity(regex, "aaa", false)).toBeNull();
    expect(clozeAnswerIdentity(text, "   ", false)).toBeNull();
    expect(clozeAnswerIdentity(text, null, false)).toBeNull();
  });
});

describe("clozeAcceptedLabel", () => {
  it("names an option by its label and a text by itself", () => {
    expect(clozeAcceptedLabel(select, "1", false)).toBe("invalid");
    expect(clozeAcceptedLabel(text, "entier", false)).toBe("entier");
  });

  it("refuses what the blank cannot hold: an option gone, a text not in its normal form", () => {
    expect(clozeAcceptedLabel(select, "3", false)).toBeNull();
    expect(clozeAcceptedLabel(text, "Entier", false)).toBeNull();
    expect(clozeAcceptedLabel(number, "3", false)).toBeNull();
  });
});

describe("clozePart", () => {
  it("names a blank and reads it back", () => {
    expect(clozePart(2)).toBe("b2");
    expect(clozePartIndex("b2")).toBe(2);
    expect(clozePartIndex("2")).toBeNull();
  });
});

describe("gradeCloze with accepted answers", () => {
  it("counts an accepted answer right, marked as such", () => {
    const accepted = new Map([
      [0, new Set(["entier"])],
      [1, new Set(["1"])],
    ]);
    const graded = gradeCloze(parse, ["Entier", "1", "3", "b"], false, accepted);
    expect(graded.perBlank.map((b) => [b.ok, b.accepted])).toEqual([
      [true, true],
      [true, true],
      [true, undefined],
      [false, undefined],
    ]);
    expect(graded.earned).toBe(3);
  });

  it("leaves the key's own verdict unmarked, and grades as before without acceptances", () => {
    const plain = gradeCloze(parse, ["int", "0", null, null], false);
    expect(plain.perBlank.map((b) => [b.ok, b.accepted])).toEqual([
      [true, undefined],
      [true, undefined],
      [false, undefined],
      [false, undefined],
    ]);
    const withSame = gradeCloze(parse, ["int", "0", null, null], false, new Map([[0, new Set(["int"])]]));
    expect(withSame.perBlank[0]!.accepted).toBeUndefined();
  });

  it("matches by the case when the question is case-sensitive", () => {
    const accepted = new Map([[0, new Set(["Entier"])]]);
    expect(gradeCloze(parse, ["entier"], true, accepted).perBlank[0]!.ok).toBe(false);
    expect(gradeCloze(parse, [" Entier "], true, accepted).perBlank[0]!.ok).toBe(true);
  });
});
