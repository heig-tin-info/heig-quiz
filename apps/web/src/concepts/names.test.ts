import { describe, expect, it } from "vitest";

import type { Concept } from "@quiz/contracts";

import { conceptName, conceptSide } from "./names";

/*
 * A concept is two-language data (ADR-081): French and English. A reader of
 * a translated interface language reads its English side, and its French
 * one when the English is missing (ADR-140 §6).
 */
const concept = (fr: string | null, en: string | null): Concept => ({
  id: "00000000-0000-4000-8000-00000000000a",
  status: "proposed",
  mergedInto: null,
  labels: { fr, en },
  qualifiers: { fr: fr === null ? "" : "mémoire", en: en === null ? "" : "memory" },
  descriptions: { fr: "La position d'un octet.", en: "" },
  aliases: [],
  broader: [],
  related: [],
  createdBy: null,
  createdAt: "2026-10-01T08:00:00.000Z",
});

describe("a concept for a German reader", () => {
  it("reads the English side", () => {
    expect(conceptName(concept("Adresse", "Address"), "de")).toBe("Address (memory)");
    expect(conceptSide(concept("Adresse", "Address"), "de").lang).toBe("en");
  });

  it("reads the French side when the English is missing, and the other description when its own is empty", () => {
    const side = conceptSide(concept("Adresse", null), "de");
    expect(side).toEqual({ lang: "fr", label: "Adresse", qualifier: "mémoire", description: "La position d'un octet." });
  });
});
