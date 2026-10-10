import { describe, expect, it } from "vitest";

import { badge, buttonClass, controlSize, cx, inputClass, inputSize, textareaClass } from "./styles.js";

describe("cx", () => {
  it("joins the truthy parts and skips the rest", () => {
    expect(cx("a", false, null, undefined, "", "b")).toBe("a b");
  });
});

describe("buttonClass", () => {
  it("defaults to the primary medium pill", () => {
    const classes = buttonClass().split(" ");
    expect(classes).toContain("rounded-control");
    expect(classes).toContain("bg-accent");
    expect(classes).toContain("h-8.5");
  });

  it("draws danger-quiet in red ink on the surface, never a red fill", () => {
    const classes = buttonClass("danger-quiet").split(" ");
    expect(classes).toContain("text-danger");
    expect(classes).toContain("bg-surface");
    expect(classes).not.toContain("bg-danger");
  });

  it("appends the caller's extra classes last", () => {
    expect(buttonClass("ghost", "sm", "ml-auto").endsWith(" ml-auto")).toBe(true);
  });
});

describe("badge", () => {
  it("wears the tone's soft fill", () => {
    expect(badge("success")).toContain("bg-success-soft text-success");
    expect(badge()).toContain("bg-surface-3 text-fg-muted");
  });
});

describe("inputClass", () => {
  it("carries no height, width or vertical padding: inputSize and the caller give them", () => {
    expect(inputClass).not.toMatch(/(^| )(h|w|py)-/);
  });
});

describe("the control scale", () => {
  it("has the three heights of ADR-094: 28, 34 and 40 px", () => {
    expect(controlSize.sm.height).toBe("h-7");
    expect(controlSize.md.height).toBe("h-8.5");
    expect(controlSize.lg.height).toBe("h-10");
  });

  it("is the one table a button, a field and a chip read", () => {
    for (const size of ["sm", "md", "lg"] as const) {
      const { height, px, text } = controlSize[size];
      expect(buttonClass("primary", size)).toContain(`${height} ${px} ${text}`);
      expect(inputSize[size]).toBe(`${height} ${px} ${text}`);
    }
  });

  it("makes every single-line control a pill and a multi-line field a soft square", () => {
    expect(inputClass).toContain("rounded-control");
    expect(buttonClass()).toContain("rounded-control");
    expect(textareaClass).toContain("rounded-field");
    expect(textareaClass).not.toContain("rounded-control");
  });
});

describe("tokens", () => {
  it("never carries a dark: variant or a raw radius", () => {
    for (const cls of [inputClass, textareaClass, buttonClass(), buttonClass("secondary", "lg"), badge()]) {
      expect(cls).not.toMatch(/\bdark:/);
      expect(cls).not.toMatch(/\brounded-(xl|lg|md)\b/);
    }
  });
});
