import { describe, expect, it } from "vitest";

import {
  FOLD_FROM,
  FOLD_TO,
  addressDomain,
  addressesInTenant,
  matchesEveryWord,
  searchWords,
  tenantOf,
} from "./studentSearch.js";

describe("searchWords", () => {
  it("folds case and accents and splits on blanks", () => {
    expect(searchWords("  Léa   ROCHAT ")).toEqual(["lea", "rochat"]);
  });

  it("searches nothing under three characters, blanks and accents aside", () => {
    expect(searchWords("Lé")).toEqual([]);
    expect(searchWords("  a b ")).toEqual([]);
    expect(searchWords("é̀̂")).toEqual([]);
    expect(searchWords("   ")).toEqual([]);
    expect(searchWords("a bc")).toEqual(["a", "bc"]);
  });
});

describe("matchesEveryWord", () => {
  const lea = ["Léa", "Rochat", "lea.rochat@heig-vd.ch"];

  it("matches every word in any order, without case or accents", () => {
    expect(matchesEveryWord(searchWords("rochat lea"), lea)).toBe(true);
    expect(matchesEveryWord(searchWords("LÉA"), lea)).toBe(true);
    expect(matchesEveryWord(searchWords("roch"), lea)).toBe(true);
    expect(matchesEveryWord(searchWords("lea.rochat@heig"), lea)).toBe(true);
  });

  it("needs every word", () => {
    expect(matchesEveryWord(searchWords("lea dubois"), lea)).toBe(false);
  });

  it("tolerates no typo", () => {
    expect(matchesEveryWord(searchWords("rochta"), lea)).toBe(false);
  });

  it("matches nothing without words", () => {
    expect(matchesEveryWord([], lea)).toBe(false);
  });
});

describe("the tenant", () => {
  it("is the domains of the institutional addresses, once each", () => {
    expect(tenantOf(["a@heig-vd.ch", "B@HEIG-VD.CH", "c@hes-so.ch", "broken"])).toEqual(["heig-vd.ch", "hes-so.ch"]);
  });

  it("is empty without an institutional address", () => {
    expect(tenantOf([])).toEqual([]);
  });

  it("admits an address by its exact domain, never a subdomain", () => {
    expect(addressesInTenant(["a@heig-vd.ch", "b@mail.heig-vd.ch", "c@hefr.ch"], ["heig-vd.ch"])).toEqual(["a@heig-vd.ch"]);
  });

  it("reads the domain after the last @", () => {
    expect(addressDomain("x@y@HEIG-VD.ch")).toBe("heig-vd.ch");
    expect(addressDomain("@heig-vd.ch")).toBeNull();
    expect(addressDomain("nobody@")).toBeNull();
  });
});

describe("the SQL fold table", () => {
  // Its behaviour is checked against Postgres, in `studentSearch.db.test.ts`.
  it("has a counterpart for every letter, the combining marks last, deleted", () => {
    expect([...FOLD_TO].length).toBeLessThan([...FOLD_FROM].length);
    expect([...FOLD_FROM].slice([...FOLD_TO].length).every((c) => /\p{M}/u.test(c))).toBe(true);
  });
});
