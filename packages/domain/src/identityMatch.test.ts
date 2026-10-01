import { describe, expect, it } from "vitest";

import { decideMatch, type MatchHolder, type MatchInput } from "./identityMatch.js";

const holder = (id: string, swissEduId: string | null = null, eligible = true): MatchHolder => ({
  id,
  swissEduId,
  eligible,
});

const base: MatchInput = { swissEduId: null, bySwissEduId: [], addresses: [], addressNeedsNoSwissEduId: false };

describe("decideMatch", () => {
  it("matches one account by swiss_edu_id, and refuses two", () => {
    expect(decideMatch({ ...base, swissEduId: "e", bySwissEduId: [holder("a", "e")] })).toEqual({
      kind: "match",
      id: "a",
      key: "swiss_edu_id",
    });
    expect(decideMatch({ ...base, swissEduId: "e", bySwissEduId: [holder("b", "e"), holder("a", "e")] })).toEqual({
      kind: "ambiguous",
      key: "swiss_edu_id",
      candidates: ["a", "b"],
    });
  });

  it("finds nothing without a holder", () => {
    expect(decideMatch({ ...base, swissEduId: "e", addresses: [{ email: "x", institutional: false, holders: [] }] })).toEqual({
      kind: "none",
    });
  });

  it("matches a private address held by one eligible account only", () => {
    const one = { email: "x", institutional: false, holders: [holder("a")] };
    expect(decideMatch({ ...base, addresses: [one] })).toEqual({ kind: "match", id: "a", key: "private_address" });
  });

  it("counts every holder of a private address, eligible or not, for its uniqueness", () => {
    // Another account holds it: not unique, the eligible one is doubtful.
    const shared = { email: "x", institutional: false, holders: [holder("a"), holder("q", null, false)] };
    expect(decideMatch({ ...base, addresses: [shared] })).toEqual({
      kind: "ambiguous",
      key: "private_address",
      candidates: ["a"],
    });
    // Two eligible holders, one with another swiss_edu_id, one without.
    const two = { email: "x", institutional: false, holders: [holder("a", "other"), holder("b")] };
    expect(decideMatch({ ...base, swissEduId: "mine", addresses: [two], addressNeedsNoSwissEduId: true })).toEqual({
      kind: "ambiguous",
      key: "private_address",
      candidates: ["a", "b"],
    });
    // A holder not eligible alone: nothing to match.
    const foreign = { email: "x", institutional: false, holders: [holder("q", null, false)] };
    expect(decideMatch({ ...base, addresses: [foreign] })).toEqual({ kind: "none" });
  });

  it("accepts an institutional address whoever else holds it", () => {
    const inst = { email: "x", institutional: true, holders: [holder("a"), holder("q", null, false)] };
    expect(decideMatch({ ...base, addresses: [inst] })).toEqual({ kind: "match", id: "a", key: "institutional_address" });
  });

  it("never matches by address an account of another swiss_edu_id", () => {
    const addr = { email: "x", institutional: true, holders: [holder("a", "other")] };
    expect(decideMatch({ ...base, swissEduId: "mine", addresses: [addr] })).toMatchObject({ kind: "ambiguous" });
    // The same swiss_edu_id is fine for the import...
    const same = { email: "x", institutional: true, holders: [holder("a", "mine")] };
    expect(decideMatch({ ...base, swissEduId: "mine", addresses: [same] })).toMatchObject({ kind: "match" });
  });

  it("adopts by address only an account without a swiss_edu_id when told so", () => {
    const addr = { email: "x", institutional: true, holders: [holder("a", "theirs")] };
    for (const swissEduId of [null, "mine"]) {
      expect(decideMatch({ ...base, swissEduId, addresses: [addr], addressNeedsNoSwissEduId: true })).toMatchObject({
        kind: "ambiguous",
        candidates: ["a"],
      });
    }
  });

  it("refuses two accounts reached by two addresses", () => {
    const addresses = [
      { email: "x", institutional: true, holders: [holder("a")] },
      { email: "y", institutional: false, holders: [holder("b")] },
    ];
    expect(decideMatch({ ...base, addresses })).toEqual({
      kind: "ambiguous",
      key: "institutional_address",
      candidates: ["a", "b"],
    });
  });
});
