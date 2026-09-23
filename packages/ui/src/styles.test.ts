import { describe, expect, it } from "vitest";

import { badge, button, buttonClass, cx, input, inputClass, inputSm } from "./styles.js";

describe("cx", () => {
  it("joins the truthy parts and skips the rest", () => {
    expect(cx("a", false, null, undefined, "", "b")).toBe("a b");
  });
});

describe("button", () => {
  it("defaults to the primary medium pill", () => {
    const classes = button().split(" ");
    expect(classes).toContain("rounded-full");
    expect(classes).toContain("bg-accent");
    expect(classes).toContain("h-8.5");
  });

  it("appends the caller's extra classes last", () => {
    expect(button("ghost", "sm", "ml-auto").endsWith(" ml-auto")).toBe(true);
  });
});

describe("badge", () => {
  it("wears the tone's soft fill", () => {
    expect(badge("success")).toContain("bg-success-soft text-success");
    expect(badge()).toContain("bg-surface-3 text-fg-muted");
  });
});

describe("tokens", () => {
  it("never carries a dark: variant or a raw radius", () => {
    for (const cls of [input, inputSm, button(), badge(), inputClass, buttonClass]) {
      expect(cls).not.toMatch(/\bdark:/);
      expect(cls).not.toMatch(/\brounded-(xl|lg|md)\b/);
    }
  });
});
