import { describe, expect, it } from "vitest";

import {
  FOLD_FROM,
  FOLD_TO,
  addressDomain,
  addressesInTenant,
  foldForSearch,
  matchesEveryWord,
  searchWords,
  tenantOf,
} from "./studentSearch.js";

/** What Postgres's `translate(lower(x), FROM, TO)` does, with a C collation's `lower`. */
function sqlFold(text: string): string {
  const from = [...FOLD_FROM];
  const to = [...FOLD_TO];
  return [...text.replace(/[A-Z]/g, (c) => c.toLowerCase())]
    .map((ch) => {
      const i = from.indexOf(ch);
      return i === -1 ? ch : (to[i] ?? "");
    })
    .join("");
}

describe("searchWords", () => {
  it("folds case and accents and splits on blanks", () => {
    expect(searchWords("  Léa   ROCHAT ")).toEqual(["lea", "rochat"]);
  });

  it("searches nothing under three characters", () => {
    expect(searchWords("Lé")).toEqual([]);
    expect(searchWords("  a b ")).toEqual(["a", "b"]);
    expect(searchWords("   ")).toEqual([]);
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

describe("the SQL fold", () => {
  it("has a counterpart for every letter, the combining marks last", () => {
    expect([...FOLD_TO].length).toBeLessThan([...FOLD_FROM].length);
    expect([...FOLD_FROM].slice([...FOLD_TO].length).every((c) => /\p{M}/u.test(c))).toBe(true);
  });

  it("folds as foldForSearch does, composed or decomposed", () => {
    for (const name of ["Léa Rochat", "CHLOÉ MONNIER", "Øystein Ærø", "Zoë Çelik", "Łukasz Dvořák", "Lé́a"]) {
      expect(sqlFold(name)).toBe(foldForSearch(name));
    }
  });
});
