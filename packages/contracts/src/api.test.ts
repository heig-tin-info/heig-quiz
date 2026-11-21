import { describe, expect, it } from "vitest";

import { LOCALES } from "@quiz/domain";

import { MePatch } from "./api.js";

describe("MePatch", () => {
  it("takes every interface language of the registry, and none other (ADR-140)", () => {
    for (const locale of [...LOCALES, null]) expect(MePatch.safeParse({ locale }).success, String(locale)).toBe(true);
    for (const locale of ["it", "de-CH", "DE"]) expect(MePatch.safeParse({ locale }).success, locale).toBe(false);
  });
});
