import { describe, expect, it } from "vitest";

import { confirmsName } from "./typedName.js";

describe("confirmsName", () => {
  it("matches what a browser shows of the name (#886)", () => {
    expect(confirmsName("Labo22 keyence tracking-notused", "Labo22  keyence tracking-notused")).toBe(true);
    expect(confirmsName("Labo22 keyence tracking-notused", "Labo22 keyence tracking-notused")).toBe(true);
    expect(confirmsName("Labo22 keyence tracking-notused", "Labo22 keyence tracking‑notused")).toBe(true);
    expect(confirmsName("  Labo 22 ", "Labo 22")).toBe(true);
  });

  it("still refuses another name, a missing word and another case", () => {
    expect(confirmsName("Labo22 keyence", "Labo22 keyence tracking-notused")).toBe(false);
    expect(confirmsName("labo22", "Labo22")).toBe(false);
    expect(confirmsName("", "Labo22")).toBe(false);
  });
});
