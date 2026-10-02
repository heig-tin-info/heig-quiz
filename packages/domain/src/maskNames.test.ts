import { describe, expect, it } from "vitest";

import { MASK, maskNames } from "./maskNames.js";

const alice = { givenName: "Alice", familyName: "Müller", email: "alice.muller@heig-vd.ch" };
const jp = { givenName: "Jean-Pierre", familyName: "Le Gall", email: "jp@example.ch" };

describe("maskNames", () => {
  it("masks a name wherever it is typed, ignoring case and accents", () => {
    expect(maskNames("Réponse d'alice MULLER : la pile.", [alice])).toBe(`Réponse d'${MASK} ${MASK} : la pile.`);
    expect(maskNames("Signé Müller", [alice])).toBe(`Signé ${MASK}`);
  });

  it("masks an e-mail address before its parts, so no piece of it is left", () => {
    expect(maskNames("contact: Alice.Muller@heig-vd.ch", [alice])).toBe(`contact: ${MASK}`);
  });

  it("masks whole words only", () => {
    expect(maskNames("Alicette et Mullerin", [alice])).toBe("Alicette et Mullerin");
  });

  it("masks a compound name whole, but not one of its short parts alone", () => {
    expect(maskNames("Jean-Pierre Le Gall a écrit le code", [jp])).toBe(`${MASK}-${MASK} ${MASK} ${MASK} a écrit le code`);
    expect(maskNames("Le Gall seul, et le code", [jp])).toBe(`${MASK} ${MASK} seul, et le code`);
  });

  it("masks a whole name of short parts, in either order, though neither part alone", () => {
    const wu = { givenName: "Li", familyName: "Wu", email: "" };
    expect(maskNames("Je suis Li Wu, ou WU-Li, ou wu li.", [wu])).toBe(
      `Je suis ${MASK} ${MASK}, ou ${MASK}-${MASK}, ou ${MASK} ${MASK}.`,
    );
    expect(maskNames("Li seul, et Wu seul.", [wu])).toBe("Li seul, et Wu seul.");
    // Two words of one name, not across a sentence.
    expect(maskNames("Wu. Li", [wu])).toBe("Wu. Li");
  });

  it("masks a name that is also a word: a lost word costs less than a leaked name", () => {
    const pascal = { givenName: "Pascal", familyName: "Roy", email: "" };
    expect(maskNames("En Pascal, une boucle", [pascal])).toBe(`En ${MASK}, une boucle`);
  });

  it("leaves a text alone when nobody is given", () => {
    expect(maskNames("Alice", [])).toBe("Alice");
  });

  it("masks a person known by one name only", () => {
    expect(maskNames("Signé Prince", [{ givenName: "Prince", familyName: "", email: "" }])).toBe(`Signé ${MASK}`);
  });
});
