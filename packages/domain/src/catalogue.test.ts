import { describe, expect, it } from "vitest";

import { catalogueTerms } from "./catalogue.js";
import { foldText } from "./concepts.js";

describe("foldText", () => {
  it("drops case, accents and ligatures", () => {
    expect(foldText("Résistance des Matériaux, Nœud")).toBe("resistance des materiaux, noeud");
  });
});

describe("catalogueTerms", () => {
  it("keeps the words worth matching, folded, with the key a concept of that name has", () => {
    expect(catalogueTerms("Intégrales des fonctions")).toEqual([
      { folded: "integrales", key: "integrale" },
      { folded: "fonctions", key: "fonction" },
    ]);
  });

  it("takes a short query whole rather than matching everything", () => {
    expect(catalogueTerms("IA")).toEqual([{ folded: "ia", key: "ia" }]);
    expect(catalogueTerms("  ")).toEqual([]);
  });

  it("bounds the query", () => {
    expect(catalogueTerms("alpha ".repeat(40)).length).toBeLessThanOrEqual(2);
    expect(catalogueTerms("a".repeat(500))[0]!.folded).toHaveLength(100);
  });
});

describe("foldText ligatures", () => {
  it("spells the ligatures out, in both cases", () => {
    expect(foldText("Œuvre Æsir Straße")).toBe("oeuvre aesir strasse");
  });
});
