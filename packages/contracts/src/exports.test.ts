/**
 * The paper variants' contracts (ADR-148): what the routes take and what
 * the records and the sheet read, round-tripped and refused at their bounds.
 */
import { describe, expect, it } from "vitest";

import { PaperPdfQuery, PaperVariantQuery, PaperVariantRef, PaperVariantsBody, PaperVariantsState } from "./exports.js";
import { PaperAttemptBody, PaperItemsQuery } from "./paper.js";

describe("paper variants (ADR-148)", () => {
  it("names a variant by its number and letter, 1 to 26", () => {
    const ref = { number: 3, letter: "C", of: 4 };
    expect(PaperVariantRef.parse(JSON.parse(JSON.stringify(ref)))).toEqual(ref);
    expect(PaperVariantRef.safeParse({ ...ref, letter: "c" }).success).toBe(false);
    expect(PaperVariantRef.safeParse({ ...ref, number: 27 }).success).toBe(false);
    const state = { count: 26, varies: true, locked: "paper_copy" };
    expect(PaperVariantsState.parse(state)).toEqual(state);
    expect(PaperVariantsState.safeParse({ ...state, locked: "printed" }).success).toBe(false);
    expect(PaperVariantsBody.safeParse({ count: 0 }).success).toBe(false);
    expect(PaperVariantsBody.safeParse({ count: 1.5 }).success).toBe(false);
  });

  it("reads `?variant=` from a query string: a number, `all` for a PDF only, 1 by default", () => {
    expect(PaperVariantQuery.parse({})).toEqual({ variant: 1 });
    expect(PaperVariantQuery.parse({ variant: "4" })).toEqual({ variant: 4 });
    expect(PaperVariantQuery.safeParse({ variant: "all" }).success).toBe(false);
    expect(PaperPdfQuery.parse({ variant: "all" })).toEqual({ variant: "all" });
    expect(PaperPdfQuery.parse({ variant: "26" })).toEqual({ variant: 26 });
    expect(PaperPdfQuery.safeParse({ variant: "27" }).success).toBe(false);
    expect(PaperItemsQuery.parse({ user: "6f1c0f6e-7e2b-4c7e-9d38-2f9a1c3b5d70" })).not.toHaveProperty("variant");
    expect(PaperItemsQuery.parse({ user: "6f1c0f6e-7e2b-4c7e-9d38-2f9a1c3b5d70", variant: "2" }).variant).toBe(2);
  });

  it("takes a paper copy's variant as an optional number", () => {
    const body = { userId: "6f1c0f6e-7e2b-4c7e-9d38-2f9a1c3b5d70", examDate: "2026-11-26", answers: {} };
    expect(PaperAttemptBody.parse(body)).not.toHaveProperty("variant");
    expect(PaperAttemptBody.parse({ ...body, variant: 2 }).variant).toBe(2);
    expect(PaperAttemptBody.safeParse({ ...body, variant: 0 }).success).toBe(false);
  });
});
