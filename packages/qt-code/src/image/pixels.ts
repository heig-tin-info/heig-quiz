/**
 * The pixel rules of a `codeimage` question (docs/spec/04 §4.9) — ONE module,
 * pure and shared: the grader reads a program's stdout with it on the
 * server, and the player reads the very same stdout with it in the browser,
 * so the picture a student sees and the picture they are graded on cannot
 * disagree.
 *
 * Three things live here:
 *
 * - {@link parseImageOutput}: stdout → pixels, with the warnings;
 * - the COMPACT encoding an image is stored and shipped in: one lowercase hex
 *   digit per pixel for `bw` and `color16`, two for `gray256`, and `x` (or
 *   `xx`) for a pixel that is invalid or missing;
 * - the palettes, including the pastel CGA sixteen, defined once.
 *
 * In memory an image is an `Int16Array` of `width × height` values, row-major,
 * with {@link INVALID} (-1) standing for a pixel that holds no palette value.
 */
import type { ImageSpec, ImageWarning, Palette } from "./schema.js";

/** The in-memory value of a pixel that holds no valid palette entry. */
export const INVALID = -1;

/** The largest value each palette accepts; the smallest is always 0. */
export const PALETTE_MAX: Record<Palette, number> = { bw: 1, color16: 15, gray256: 255 };

/** Characters one pixel takes in the compact encoding. */
export const charsPerPixel = (palette: Palette): number => (palette === "gray256" ? 2 : 1);

/**
 * The sixteen classic CGA/VGA colours, in their classic index order
 * (0 black, 1 blue, 2 green, 3 cyan, 4 red, 5 magenta, 6 brown, 7 light grey,
 * 8 dark grey, 9–13 their light versions, 14 yellow, 15 white), softened to
 * pastels: a 128 × 128 grid of saturated CGA reads as noise, and the same
 * picture in pastels still tells every index apart. Image content, not UI
 * chrome, so they are fixed colours and do not swap with the theme.
 */
export const PASTEL_16: readonly string[] = [
  "#34323a", // 0 black
  "#7b8ed8", // 1 blue
  "#7fbf8e", // 2 green
  "#78c2c6", // 3 cyan
  "#d98585", // 4 red
  "#c08bd0", // 5 magenta
  "#c9a07a", // 6 brown
  "#c9c7cd", // 7 light grey
  "#8b8993", // 8 dark grey
  "#adbdf4", // 9 light blue
  "#b6e5b3", // 10 light green
  "#aeeaee", // 11 light cyan
  "#f4b1b1", // 12 light red
  "#e6b5f0", // 13 light magenta
  "#f6e99a", // 14 yellow
  "#fbfaf7", // 15 white
];

/** The colour a pixel value paints, or `null` for an invalid pixel. */
export function pixelColor(value: number, palette: Palette): string | null {
  if (value < 0 || value > PALETTE_MAX[palette]) return null;
  switch (palette) {
    case "bw":
      return value === 0 ? "#000000" : "#ffffff";
    case "color16":
      return PASTEL_16[value] ?? null;
    case "gray256":
      return `rgb(${value} ${value} ${value})`;
  }
}

/** Pixels in an image of this spec. */
export const pixelCountOf = (spec: Pick<ImageSpec, "width" | "height">): number =>
  spec.width * spec.height;

// ---------------------------------------------------------------------------
// stdout → pixels
// ---------------------------------------------------------------------------

export interface ParsedImage {
  /** `width × height` values, row-major; {@link INVALID} where no value holds. */
  pixels: Int16Array;
  /** Tokens that were read but are not an integer of the palette's range. */
  invalid: number;
  /** Pixels the output never reached. */
  missing: number;
  /** Tokens after the last pixel: ignored, but worth a warning. */
  extra: number;
}

const INTEGER = /^[+-]?\d+$/;

/**
 * Reads a program's stdout as an image.
 *
 * The rule, in full: the output is split on any run of whitespace (spaces,
 * tabs, newlines); the first `width × height` tokens are the pixels, read
 * row-major. A token that is not an integer, or is outside the palette's
 * range, is an INVALID pixel. Pixels the output never reached are MISSING.
 * Tokens beyond the last pixel are ignored and counted as EXTRA. Invalid and
 * missing pixels are wrong whatever the target holds.
 */
export function parseImageOutput(stdout: string, spec: ImageSpec): ParsedImage {
  const count = pixelCountOf(spec);
  const max = PALETTE_MAX[spec.palette];
  const pixels = new Int16Array(count).fill(INVALID);
  let invalid = 0;
  let read = 0;
  let extra = 0;
  // A hand-rolled scanner rather than `split(/\s+/)`: a 256 KiB output of
  // tokens would otherwise allocate an array of all of them just to count
  // the ones past the end.
  const n = stdout.length;
  let i = 0;
  while (i < n) {
    while (i < n && isSpace(stdout.charCodeAt(i))) i += 1;
    if (i >= n) break;
    const start = i;
    while (i < n && !isSpace(stdout.charCodeAt(i))) i += 1;
    if (read >= count) {
      extra += 1;
      continue;
    }
    const token = stdout.slice(start, i);
    const value = INTEGER.test(token) ? Number(token) : Number.NaN;
    if (Number.isInteger(value) && value >= 0 && value <= max) pixels[read] = value;
    else invalid += 1;
    read += 1;
  }
  return { pixels, invalid, missing: count - read, extra };
}

/** Whitespace as a C `isspace` sees it, plus the form feed and vertical tab. */
function isSpace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13);
}

/** The warnings a parse deserves, in the order a student fixes them. */
export function warningsOf(parsed: ParsedImage): ImageWarning[] {
  const out: ImageWarning[] = [];
  if (parsed.invalid > 0) out.push({ code: "invalid", count: parsed.invalid });
  if (parsed.missing > 0) out.push({ code: "missing", count: parsed.missing });
  if (parsed.extra > 0) out.push({ code: "extra", count: parsed.extra });
  return out;
}

// ---------------------------------------------------------------------------
// The compact encoding
// ---------------------------------------------------------------------------

/** Pixels → the compact string; an invalid pixel becomes `x` (or `xx`). */
export function encodeImage(pixels: ArrayLike<number>, palette: Palette): string {
  const width = charsPerPixel(palette);
  const invalid = "x".repeat(width);
  let out = "";
  for (let i = 0; i < pixels.length; i += 1) {
    const value = pixels[i]!;
    out +=
      value < 0 || value > PALETTE_MAX[palette]
        ? invalid
        : value.toString(16).padStart(width, "0");
  }
  return out;
}

/**
 * The compact string → `count` pixels. Anything that is not a valid value —
 * an `x`, a stray character, a value out of range, the end of a short string
 * — decodes to {@link INVALID}; this never throws, because a stored image is
 * read by a player that must still draw what it can.
 */
export function decodeImage(encoded: string, palette: Palette, count: number): Int16Array {
  const width = charsPerPixel(palette);
  const max = PALETTE_MAX[palette];
  const pixels = new Int16Array(count).fill(INVALID);
  for (let i = 0; i < count; i += 1) {
    const chunk = encoded.slice(i * width, i * width + width);
    if (chunk.length !== width || !/^[0-9a-f]+$/.test(chunk)) continue;
    const value = parseInt(chunk, 16);
    if (value <= max) pixels[i] = value;
  }
  return pixels;
}

/**
 * Why a compact string is not a valid image of this spec, or `null` when it
 * is: exactly one valid pixel per cell, lowercase hex, nothing more. The
 * schema turns the answer into `codeimage.<reason>`.
 */
export function imageStringIssue(
  encoded: string,
  spec: ImageSpec,
): "target_size" | "target_value" | null {
  if (encoded.length !== pixelCountOf(spec) * charsPerPixel(spec.palette)) return "target_size";
  const pixels = decodeImage(encoded, spec.palette, pixelCountOf(spec));
  return pixels.includes(INVALID) ? "target_value" : null;
}

// ---------------------------------------------------------------------------
// Comparing
// ---------------------------------------------------------------------------

/**
 * How many cells of `computed` equal `target`. An invalid pixel is never
 * equal to anything — not even to an invalid target cell, which a published
 * question cannot hold anyway.
 */
export function countCorrect(computed: ArrayLike<number>, target: ArrayLike<number>): number {
  const n = Math.min(computed.length, target.length);
  let correct = 0;
  for (let i = 0; i < n; i += 1) {
    const value = computed[i]!;
    if (value !== INVALID && value === target[i]) correct += 1;
  }
  return correct;
}
