/**
 * The pixel rules (docs/spec/04 §4.9): ONE parser for the grader and the
 * player, so every rule of the reading is pinned here.
 */
import { describe, expect, it } from "vitest";

import {
  charsPerPixel,
  countCorrect,
  decodeImage,
  encodeImage,
  imageStringIssue,
  INVALID,
  parseImageOutput,
  PASTEL_16,
  pixelColor,
  warningsOf,
} from "./pixels.js";
import type { ImageSpec } from "./schema.js";

const bw3: ImageSpec = { width: 3, height: 3, palette: "bw" };

describe("parseImageOutput", () => {
  it("reads width × height integers row-major, whatever whitespace separates them", () => {
    const parsed = parseImageOutput("1 0\t1\n0 1 0\r\n\n1  0 1", bw3);
    expect([...parsed.pixels]).toEqual([1, 0, 1, 0, 1, 0, 1, 0, 1]);
    expect(parsed).toMatchObject({ invalid: 0, missing: 0, extra: 0 });
  });

  it("does not care about line structure: one line or one value per line read the same", () => {
    const flat = parseImageOutput("1 1 1 0 0 0 1 1 1", bw3);
    const tall = parseImageOutput("1\n1\n1\n0\n0\n0\n1\n1\n1\n", bw3);
    expect([...flat.pixels]).toEqual([...tall.pixels]);
  });

  it("marks a non-integer token and an out-of-range value invalid, and counts them", () => {
    const parsed = parseImageOutput("1 x 2 -1 0.5 1e0 0 +1 007", { ...bw3, palette: "bw" });
    expect([...parsed.pixels]).toEqual([1, INVALID, INVALID, INVALID, INVALID, INVALID, 0, 1, INVALID]);
    expect(parsed.invalid).toBe(6);
  });

  it("accepts leading zeros and a plus sign inside the range", () => {
    const parsed = parseImageOutput("015 +3 00", { width: 3, height: 1, palette: "color16" } as ImageSpec);
    expect([...parsed.pixels]).toEqual([15, 3, 0]);
  });

  it("applies each palette's range", () => {
    const spec = (palette: ImageSpec["palette"]): ImageSpec => ({ width: 3, height: 1, palette });
    expect([...parseImageOutput("0 1 2", spec("bw")).pixels]).toEqual([0, 1, INVALID]);
    expect([...parseImageOutput("0 15 16", spec("color16")).pixels]).toEqual([0, 15, INVALID]);
    expect([...parseImageOutput("0 255 256", spec("gray256")).pixels]).toEqual([0, 255, INVALID]);
  });

  it("counts the pixels an output never reached as missing", () => {
    const parsed = parseImageOutput("1 0 1 0", bw3);
    expect(parsed.missing).toBe(5);
    expect([...parsed.pixels].slice(4)).toEqual([INVALID, INVALID, INVALID, INVALID, INVALID]);
  });

  it("ignores the tokens after the last pixel, and counts them", () => {
    const parsed = parseImageOutput("1 1 1 1 1 1 1 1 1 junk 2 3", bw3);
    expect(parsed.extra).toBe(3);
    expect(parsed.invalid).toBe(0);
  });

  it("reads an empty output as every pixel missing", () => {
    expect(parseImageOutput("", bw3).missing).toBe(9);
    expect(parseImageOutput("   \n\t", bw3).missing).toBe(9);
  });

  it("turns its counts into warnings, in the order a student fixes them", () => {
    expect(warningsOf(parseImageOutput("1 x 1", bw3))).toEqual([
      { code: "invalid", count: 1 },
      { code: "missing", count: 6 },
    ]);
    expect(warningsOf(parseImageOutput("1 1 1 1 1 1 1 1 1 1", bw3))).toEqual([
      { code: "extra", count: 1 },
    ]);
    expect(warningsOf(parseImageOutput("0 0 0 0 0 0 0 0 0", bw3))).toEqual([]);
  });

  it("reads a 128 × 128 grey image quickly enough to run on every click", () => {
    const spec: ImageSpec = { width: 128, height: 128, palette: "gray256" };
    const stdout = Array.from({ length: 128 }, () => Array(128).fill("255").join(" ")).join("\n");
    const started = performance.now();
    const parsed = parseImageOutput(stdout, spec);
    expect(performance.now() - started).toBeLessThan(500);
    expect(parsed.missing + parsed.invalid + parsed.extra).toBe(0);
  });
});

describe("the compact encoding", () => {
  it("writes one hex digit per pixel for bw and color16, two for gray256", () => {
    expect(charsPerPixel("bw")).toBe(1);
    expect(charsPerPixel("color16")).toBe(1);
    expect(charsPerPixel("gray256")).toBe(2);
    expect(encodeImage([1, 0, 1], "bw")).toBe("101");
    expect(encodeImage([0, 10, 15], "color16")).toBe("0af");
    expect(encodeImage([0, 7, 255], "gray256")).toBe("0007ff");
  });

  it("writes an invalid pixel as x, one per character of a pixel", () => {
    expect(encodeImage([1, INVALID, 0], "bw")).toBe("1x0");
    expect(encodeImage([INVALID, 16], "gray256")).toBe("xx10");
    expect(encodeImage([2], "bw")).toBe("x");
  });

  it("round-trips every palette", () => {
    const grey = Array.from({ length: 256 }, (_, i) => i);
    expect([...decodeImage(encodeImage(grey, "gray256"), "gray256", 256)]).toEqual(grey);
    const colors = Array.from({ length: 16 }, (_, i) => i);
    expect([...decodeImage(encodeImage(colors, "color16"), "color16", 16)]).toEqual(colors);
  });

  it("decodes anything unreadable to INVALID, never throwing", () => {
    expect([...decodeImage("1x", "bw", 4)]).toEqual([1, INVALID, INVALID, INVALID]);
    expect([...decodeImage("2A", "bw", 2)]).toEqual([INVALID, INVALID]);
    expect([...decodeImage("f", "color16", 1)]).toEqual([15]);
  });

  it("says why a string is not an image of a spec", () => {
    expect(imageStringIssue("101010101", bw3)).toBeNull();
    expect(imageStringIssue("10101010", bw3)).toBe("target_size");
    expect(imageStringIssue("1010101010", bw3)).toBe("target_size");
    expect(imageStringIssue("10101010x", bw3)).toBe("target_value");
    expect(imageStringIssue("101010102", bw3)).toBe("target_value");
  });
});

describe("countCorrect", () => {
  it("counts equal cells, and never an invalid one", () => {
    const target = Int16Array.from([1, 0, 1, 0]);
    expect(countCorrect(Int16Array.from([1, 0, 1, 0]), target)).toBe(4);
    expect(countCorrect(Int16Array.from([1, 1, INVALID, 0]), target)).toBe(2);
    expect(countCorrect(Int16Array.from([INVALID]), Int16Array.from([INVALID]))).toBe(0);
  });
});

describe("the palettes", () => {
  it("define sixteen pastel colours, once", () => {
    expect(PASTEL_16).toHaveLength(16);
    expect(new Set(PASTEL_16).size).toBe(16);
  });

  it("paint 0 black and 1 white in bw, and grey levels in gray256", () => {
    expect(pixelColor(0, "bw")).toBe("#000000");
    expect(pixelColor(1, "bw")).toBe("#ffffff");
    expect(pixelColor(128, "gray256")).toBe("rgb(128 128 128)");
    expect(pixelColor(12, "color16")).toBe(PASTEL_16[12]);
    expect(pixelColor(INVALID, "bw")).toBeNull();
    expect(pixelColor(16, "color16")).toBeNull();
  });
});
