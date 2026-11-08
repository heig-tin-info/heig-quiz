import { describe, expect, it } from "vitest";

import { maskHiddenCases } from "./cases.js";

describe("maskHiddenCases", () => {
  const visible = { name: "shown", visible: true, points: 1, ok: true, input: "i1", stdout: "o1", expected: "e1" };
  const hidden = { name: "secret", visible: false, points: 2, ok: false, input: "i2", stdout: "o2", expected: "e2" };
  const cases = [visible, hidden];

  it("keeps a hidden case's verdict alone, its name masked", () => {
    const [, masked] = maskHiddenCases(cases, false, () => ({}));
    expect(Object.keys(masked!).sort()).toEqual(["name", "ok", "points", "visible"]);
    expect(masked).toEqual({ name: "#2", visible: false, points: 2, ok: false });
  });

  it("keeps a hidden case's name when the policy opens the names", () => {
    expect(maskHiddenCases(cases, true, () => ({}))[1]!.name).toBe("secret");
  });

  it("passes a visible case through as the same object", () => {
    expect(maskHiddenCases(cases, false, () => ({}))[0]).toBe(visible);
  });

  it("lets no coarse field turn a hidden case visible or rename it", () => {
    const leak = (() => ({ visible: true, name: "leak" })) as unknown as () => object;
    const [, masked] = maskHiddenCases(cases, false, leak);
    expect(masked).toMatchObject({ name: "#2", visible: false });
  });
});
