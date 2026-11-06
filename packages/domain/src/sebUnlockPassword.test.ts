import { describe, expect, it } from "vitest";

import { SEB_UNLOCK_DIGITS, SEB_UNLOCK_LETTERS, drawSebUnlockPassword, isSebUnlockPassword } from "./sebUnlockPassword.js";

describe("the SEB unlock password", () => {
  it("leaves out the characters a reader confuses", () => {
    for (const c of "ilo") expect(SEB_UNLOCK_LETTERS).not.toContain(c);
    for (const c of "01") expect(SEB_UNLOCK_DIGITS).not.toContain(c);
    expect(SEB_UNLOCK_LETTERS).toHaveLength(23);
    expect(SEB_UNLOCK_DIGITS).toHaveLength(8);
  });

  it("is three letters then three digits, each drawn from its alphabet", () => {
    const draws = [2, 3, 4, 0, 1, 2];
    expect(drawSebUnlockPassword(() => draws.shift()!)).toBe("cde234");
    expect(drawSebUnlockPassword((n) => n - 1)).toBe("zzz999");
    expect(drawSebUnlockPassword(() => 0)).toBe("aaa222");
  });

  it("asks for a bound the size of each alphabet", () => {
    const bounds: number[] = [];
    drawSebUnlockPassword((n) => (bounds.push(n), 0));
    expect(bounds).toEqual([23, 23, 23, 8, 8, 8]);
  });

  it("recognizes its own format only", () => {
    expect(isSebUnlockPassword("cde234")).toBe(true);
    for (const bad of ["cdi234", "cde204", "CDE234", "cde2345", "cd234", "234cde", ""]) {
      expect(isSebUnlockPassword(bad)).toBe(false);
    }
  });
});
