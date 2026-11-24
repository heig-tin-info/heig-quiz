import { describe, expect, it } from "vitest";

import {
  canZoom,
  initialViewState,
  MARKDOWN_ZOOMS,
  MAX_QUERY,
  parsePageInput,
  PDF_ZOOMS,
  readViewState,
  sameViewState,
  zoomStep,
} from "./viewState";

describe("the zoom ladder", () => {
  it("steps to the next rung, from a rung or from between two (fit-width lands anywhere)", () => {
    expect(zoomStep(PDF_ZOOMS, 1, 1)).toBe(1.1);
    expect(zoomStep(PDF_ZOOMS, 1, -1)).toBe(0.85);
    expect(zoomStep(PDF_ZOOMS, 1.37, 1)).toBe(1.5);
    expect(zoomStep(PDF_ZOOMS, 1.37, -1)).toBe(1.25);
    // Within a hair of a rung counts as on it.
    expect(zoomStep(PDF_ZOOMS, 1.0004, 1)).toBe(1.1);
  });

  it("stops at both ends", () => {
    expect(zoomStep(PDF_ZOOMS, 3, 1)).toBe(3);
    expect(zoomStep(PDF_ZOOMS, 0.5, -1)).toBe(0.5);
    expect(zoomStep(PDF_ZOOMS, 0.3, -1)).toBe(0.5);
    expect(canZoom(PDF_ZOOMS, 3, 1)).toBe(false);
    expect(canZoom(PDF_ZOOMS, 3, -1)).toBe(true);
    expect(canZoom(PDF_ZOOMS, 0.48, -1)).toBe(false);
    expect(canZoom(MARKDOWN_ZOOMS, 1, 1)).toBe(true);
    expect(canZoom(MARKDOWN_ZOOMS, 0.85, -1)).toBe(false);
    expect(zoomStep(MARKDOWN_ZOOMS, 1, 1)).toBe(1.15);
  });
});

describe("the page field", () => {
  it("takes a whole number, clamped to the document", () => {
    expect(parsePageInput("4", 12)).toBe(4);
    expect(parsePageInput(" 7 ", 12)).toBe(7);
    expect(parsePageInput("0", 12)).toBe(1);
    expect(parsePageInput("99", 12)).toBe(12);
    expect(parsePageInput("012", 12)).toBe(12);
  });

  it("refuses anything else, and a document without pages", () => {
    for (const text of ["", " ", "abc", "3.5", "-2", "1e3", "4a"]) expect(parsePageInput(text, 12)).toBeNull();
    expect(parsePageInput("1", 0)).toBeNull();
  });
});

describe("the kept state", () => {
  it("starts from the defaults", () => {
    expect(initialViewState("pdf")).toEqual({ kind: "pdf", location: null, scale: "page-width", query: "", outline: false });
    expect(initialViewState("markdown")).toEqual({ kind: "markdown", anchor: null, zoom: 1, query: "", outline: false });
  });

  it("reads back a state it wrote, through JSON", () => {
    const pdf = { kind: "pdf", location: { pageNumber: 5, top: 612.5, left: 24 }, scale: 1.5, query: "gain", outline: true } as const;
    const md = { kind: "markdown", anchor: { block: 13, fraction: -0.25 }, zoom: 1.3, query: "résistance", outline: false } as const;
    expect(readViewState("pdf", JSON.parse(JSON.stringify(pdf)))).toEqual(pdf);
    expect(readViewState("markdown", JSON.parse(JSON.stringify(md)))).toEqual(md);
  });

  it("never trusts its shape", () => {
    expect(readViewState("pdf", null)).toEqual(initialViewState("pdf"));
    expect(readViewState("pdf", "garbage")).toEqual(initialViewState("pdf"));
    expect(readViewState("pdf", [1, 2])).toEqual(initialViewState("pdf"));
    // Another kind's state is ignored entirely.
    expect(readViewState("pdf", { kind: "markdown", zoom: 1.5, query: "x" })).toEqual(initialViewState("pdf"));
    expect(
      readViewState("pdf", {
        kind: "pdf",
        location: { pageNumber: "2", top: 1 },
        scale: "huge",
        query: 42,
        outline: "yes",
      }),
    ).toEqual(initialViewState("pdf"));
    expect(readViewState("pdf", { kind: "pdf", location: { pageNumber: 0 } }).kind).toBe("pdf");
    expect(readViewState("pdf", { kind: "pdf", location: { pageNumber: 0 } })).toMatchObject({ location: null });
    expect(readViewState("markdown", { kind: "markdown", anchor: { block: -1, fraction: 0 }, zoom: Number.NaN })).toEqual(
      initialViewState("markdown"),
    );
  });

  it("clamps what is out of range", () => {
    expect(readViewState("pdf", { kind: "pdf", scale: 40 })).toMatchObject({ scale: 3 });
    expect(readViewState("pdf", { kind: "pdf", scale: 0.01 })).toMatchObject({ scale: 0.5 });
    expect(readViewState("pdf", { kind: "pdf", location: { pageNumber: 3.7, top: "1", left: Infinity } })).toMatchObject({
      location: { pageNumber: 3, top: null, left: null },
    });
    expect(readViewState("markdown", { kind: "markdown", zoom: 9, anchor: { block: 2.5, fraction: 7 } })).toMatchObject({
      zoom: 1.75,
      anchor: { block: 2, fraction: 1 },
    });
    expect(readViewState("markdown", { kind: "markdown", query: "x".repeat(500) }).query).toHaveLength(MAX_QUERY);
  });

  it("compares two states", () => {
    const a = readViewState("pdf", { kind: "pdf", query: "a" });
    expect(sameViewState(a, readViewState("pdf", { kind: "pdf", query: "a" }))).toBe(true);
    expect(sameViewState(a, { ...a, outline: true })).toBe(false);
  });
});
