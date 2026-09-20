import { describe, expect, it } from "vitest";

import { parseRosterCsv, parseTimeBonus, rosterFromRows } from "./roster.js";

const ok = (r: ReturnType<typeof parseRosterCsv>) => {
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.rows;
};
const errs = (r: ReturnType<typeof parseRosterCsv>) => {
  if (r.ok) throw new Error("expected: errors");
  return r.errors;
};

describe("parseRosterCsv (AU-13..16)", () => {
  it("parses a comma CSV with e-mail normalization", () => {
    expect(ok(parseRosterCsv("nom,prenom,email\nDupont,Marie, Marie.DUPONT@heig-vd.ch \n"))).toEqual([
      { nom: "Dupont", prenom: "Marie", email: "marie.dupont@heig-vd.ch", timeBonusPercent: 0 },
    ]);
  });

  it("detects the semicolon separator and free column order", () => {
    expect(ok(parseRosterCsv("email;nom;prenom\na@b.ch;Martin;Luc"))).toEqual([
      { nom: "Martin", prenom: "Luc", email: "a@b.ch", timeBonusPercent: 0 },
    ]);
  });

  it("ignores BOM and empty lines", () => {
    expect(ok(parseRosterCsv("﻿nom,prenom,email\n\nDupont,Marie,a@b.ch\n\n"))).toHaveLength(1);
  });

  it("rejects an intra-file duplicate with both lines cited", () => {
    const e = errs(parseRosterCsv("nom,prenom,email\nA,B,a@b.ch\nC,D,A@B.CH"));
    expect(e[0]?.line).toBe(3);
    expect(e[0]?.message).toMatch(/line 2/);
  });

  it("rejects invalid e-mail and missing fields (atomic import)", () => {
    const e = errs(parseRosterCsv("nom,prenom,email\nA,,a@b.ch\nB,C,pas-un-email"));
    expect(e).toHaveLength(2);
  });

  it("rejects a file without data", () => {
    expect(errs(parseRosterCsv("nom,prenom,email\n"))[0]?.message).toMatch(/No data/);
    expect(errs(parseRosterCsv(""))[0]?.message).toMatch(/Empty/);
  });
});

describe("rosterFromRows, permissive identification (Excel)", () => {
  it("real HEIG layout: accents, E-mail, stray columns", () => {
    const rows = [
      ["Nom", "Prénom", "Formation", "Mode de formation", "E-mail"],
      ["Baschiera", "Michele", "EEM", "PT", "michele.baschiera@heig-vd.ch"],
      ["Cornuz", "Aurélien", "EN", "EE", "aurelien.cornuz@heig-vd.ch"],
    ];
    expect(ok(rosterFromRows(rows))).toEqual([
      { nom: "Baschiera", prenom: "Michele", email: "michele.baschiera@heig-vd.ch", timeBonusPercent: 0 },
      { nom: "Cornuz", prenom: "Aurélien", email: "aurelien.cornuz@heig-vd.ch", timeBonusPercent: 0 },
    ]);
  });

  it("English aliases and header not on the first line (title above)", () => {
    const rows = [
      ["Liste des étudiants — Info2", "", ""],
      [],
      ["First name", "Last Name", "E-Mail Address"],
      ["Ada", "Lovelace", "ada@heig-vd.ch"],
    ];
    expect(ok(rosterFromRows(rows))).toEqual([
      { nom: "Lovelace", prenom: "Ada", email: "ada@heig-vd.ch", timeBonusPercent: 0 },
    ]);
  });

  it("headerless: e-mail column detected by content, order last name then first name", () => {
    const rows = [
      ["Dupont", "Marie", "marie@heig-vd.ch"],
      ["Martin", "Luc", "luc@heig-vd.ch"],
    ];
    expect(ok(rosterFromRows(rows))).toEqual([
      { nom: "Dupont", prenom: "Marie", email: "marie@heig-vd.ch", timeBonusPercent: 0 },
      { nom: "Martin", prenom: "Luc", email: "luc@heig-vd.ch", timeBonusPercent: 0 },
    ]);
  });

  it("numeric and empty cells tolerated, empty rows ignored", () => {
    const rows = [
      ["nom", "prenom", "email", "note"],
      ["Dupont", "Marie", "marie@heig-vd.ch", 42],
      [null, null, null, null],
    ];
    expect(ok(rosterFromRows(rows))).toHaveLength(1);
  });

  it("fails explicitly when nothing is identifiable", () => {
    const e = errs(rosterFromRows([["a", "b"], ["c", "d"]]));
    expect(e[0]?.message).toMatch(/Could not identify/);
  });

  it("reported line numbers are those of the original document", () => {
    const rows = [
      ["Titre", "", ""],
      ["nom", "prenom", "email"],
      ["Dupont", "Marie", "pas-un-email"],
    ];
    expect(errs(rosterFromRows(rows))[0]?.line).toBe(3);
  });
});

/*
 * Extra time (F-ORG-07). The column is optional: a sheet without it imports
 * exactly as before, with a bonus of zero on every row.
 */
describe("extra time column", () => {
  it("reads it under its French, English and short headers", () => {
    for (const header of ["bonus", "Temps supplémentaire", "Extra time", "temps supp."]) {
      const parse = rosterFromRows([
        ["nom", "prenom", "email", header],
        ["Rochat", "Léa", "lea.rochat@heig-vd.ch", "25"],
      ]);
      expect(ok(parse)[0]).toEqual({
        nom: "Rochat",
        prenom: "Léa",
        email: "lea.rochat@heig-vd.ch",
        timeBonusPercent: 25,
      });
    }
  });

  it("accepts the spellings a teacher actually types", () => {
    expect(parseTimeBonus("25")).toBe(25);
    expect(parseTimeBonus("25 %")).toBe(25);
    expect(parseTimeBonus("33,5")).toBe(34);
    // A fraction of one is a third of extra time written as a ratio.
    expect(parseTimeBonus("0.25")).toBe(25);
    expect(parseTimeBonus("")).toBe(0);
    expect(parseTimeBonus(null)).toBe(0);
  });

  it("rejects what it cannot read, rather than importing a wrong bonus", () => {
    expect(parseTimeBonus("beaucoup")).toBeNull();
    expect(parseTimeBonus("-5")).toBeNull();
    expect(parseTimeBonus("900")).toBeNull();
    const parse = rosterFromRows([
      ["nom", "prenom", "email", "bonus"],
      ["Rochat", "Léa", "lea.rochat@heig-vd.ch", "beaucoup"],
    ]);
    expect(parse.ok).toBe(false);
  });

  it("defaults to zero when the sheet carries no such column", () => {
    const parse = rosterFromRows([
      ["nom", "prenom", "email"],
      ["Rochat", "Léa", "lea.rochat@heig-vd.ch"],
    ]);
    expect(ok(parse)[0]!.timeBonusPercent).toBe(0);
  });
});
