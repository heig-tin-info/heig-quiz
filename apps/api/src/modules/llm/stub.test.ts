import { describe, expect, it } from "vitest";

import { StubLlm, stubGrade } from "./stub.js";

const RUBRIC =
  "- **2 pts** : la pile a une taille bornée et chaque appel y empile un cadre.\n" +
  "- **1 pt** : le dépassement touche une page non allouée (page de garde).\n" +
  "- **1 pt** : le noyau envoie `SIGSEGV`, le programme s'arrête.";

const grade = (answer: string, maxPoints = 4) =>
  stubGrade({ statement: "Pourquoi une récursion infinie plante-t-elle ?", form: "free text", rubric: RUBRIC, answer, maxPoints });

describe("the stub LLM grader", () => {
  it("gives full marks, with high confidence, to an answer that covers the rubric", () => {
    const out = grade(
      "Chaque appel empile un cadre ; la pile a une taille bornée. Le dépassement touche la " +
        "page de garde, non allouée, et le noyau envoie SIGSEGV : le programme s'arrête.",
    );
    expect(out).toMatchObject({ points: 4, confidence: "high" });
    expect(out.justification).toMatch(/^Development stub, not a model: /);
  });

  it("gives part of the points, with medium confidence, to a partial answer", () => {
    const out = grade(
      "Chaque appel récursif empile des données sur la pile, dont la taille est limitée. " +
        "Au bout d'un moment elle déborde et le programme plante.",
    );
    expect(out.confidence).toBe("medium");
    expect(out.points).toBeGreaterThan(0);
    expect(out.points).toBeLessThan(4);
  });

  it("is unsure of a few words, and sure of an answer beside the point", () => {
    expect(grade("Stack overflow.")).toMatchObject({ points: 0, confidence: "low" });
    expect(
      grade(
        "Le compilateur détecte la boucle infinie et refuse de générer l'exécutable, " +
          "d'où l'erreur au lancement.",
      ),
    ).toMatchObject({ points: 0, confidence: "high" });
  });

  it("never names the rubric's terms nor counts them in its justification", () => {
    const out = grade("Chaque appel empile un cadre sur la pile, dont la taille est bornée.");
    expect(out.justification).not.toMatch(/\d/);
    for (const term of ["taille", "chaque", "empile", "cadre", "sigsegv", "garde"]) {
      expect(out.justification.toLowerCase()).not.toContain(term);
    }
  });

  it("stays on the item's scale, in quarter points", () => {
    const out = grade("Chaque appel empile un cadre sur la pile.", 1);
    expect(out.points).toBeGreaterThanOrEqual(0);
    expect(out.points).toBeLessThanOrEqual(1);
    expect(out.points * 4).toBe(Math.round(out.points * 4));
  });

  it("falls back on the model answer when the rubric is empty", () => {
    const out = stubGrade({ statement: "Q", form: "free text", rubric: "", reference: "garbage collector", answer: "garbage collector", maxPoints: 1 });
    expect(out.points).toBe(1);
  });

  it("is deterministic", async () => {
    const llm = new StubLlm();
    const req = { statement: "Q", form: "free text", rubric: RUBRIC, answer: "Stack overflow.", maxPoints: 4 };
    expect(await llm.grade(req, null)).toEqual(await llm.grade(req, null));
  });
});
