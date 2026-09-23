/**
 * The `codeimage` question type: schemas (docs/spec/04 §4.9, ADR-021).
 *
 * A `codeimage` question is a `code` question judged by a picture instead of
 * test cases: the program prints `width × height` integers on stdout, read
 * row-major, and they are the pixels of an image the student compares with
 * the teacher's target. Everything about the PROGRAM — language, template,
 * locked regions, reference solution, runtime, limits — is `code`'s own,
 * spread from `programFields`; this file only adds what a picture needs.
 *
 * Images travel as COMPACT STRINGS (`./pixels.ts`): one hex digit per pixel
 * for `bw` and `color16`, two for `gray256`. A 128 × 128 target is 16 KiB (32
 * in grey) of text in the config rather than a 16 384-entry JSON array.
 */
import { z } from "zod";

import {
  CodeAnswer,
  CodeLimits,
  DEFAULT_LIMITS,
  programFields,
  programStudentFields,
} from "../schema.js";
import { imageStringIssue } from "./pixels.js";

/**
 * Bumped when the shape below changes; stored in `question_versions.config_version`.
 * Independent of `code`'s: the two types evolve separately.
 */
export const CODEIMAGE_CONFIG_VERSION = 1;

/**
 * The one case of a `codeimage` run: empty stdin, no command line. Shared by
 * the server's request and the browser's, so both runners see the same run.
 */
export const IMAGE_CASE = "image";

/** The smallest and the largest side of an image, in cells. */
export const IMAGE_MIN_SIDE = 3;
export const IMAGE_MAX_SIDE = 128;

/**
 * The three palettes, by the range of values a pixel may take:
 * `bw` 0..1 (0 black, 1 white), `color16` 0..15 (the pastel CGA colours of
 * `PASTEL_16`), `gray256` 0..255 (grey levels, 0 black).
 */
export const PALETTES = ["bw", "color16", "gray256"] as const;
export const Palette = z.enum(PALETTES);
export type Palette = z.infer<typeof Palette>;

export const ImageSpec = z.object({
  width: z.number().int().min(IMAGE_MIN_SIDE).max(IMAGE_MAX_SIDE),
  height: z.number().int().min(IMAGE_MIN_SIDE).max(IMAGE_MAX_SIDE),
  palette: Palette,
});
export type ImageSpec = z.infer<typeof ImageSpec>;

export const DEFAULT_IMAGE: ImageSpec = { width: 16, height: 16, palette: "bw" };

/**
 * `code`'s limits with a larger output budget: a 128 × 128 grey image written
 * as `"255 "` is 64 KiB on its own, exactly `code`'s default, and one newline
 * per row puts it over. 128 KiB holds the largest image with room to spare.
 */
export const DEFAULT_IMAGE_LIMITS: CodeLimits = { ...DEFAULT_LIMITS, outputKb: 128 };
export const CodeImageLimits = CodeLimits.extend({
  outputKb: z.number().int().min(1).max(256).default(DEFAULT_IMAGE_LIMITS.outputKb),
});

/** Room for the largest target: two characters per pixel of a 128 × 128 image. */
const MAX_IMAGE_CHARS = 2 * IMAGE_MAX_SIDE * IMAGE_MAX_SIDE;

export const CodeImageConfig = z
  .object({
    configVersion: z.literal(CODEIMAGE_CONFIG_VERSION),
    ...programFields,
    limits: CodeImageLimits.default(DEFAULT_IMAGE_LIMITS),
    image: ImageSpec,
    /**
     * The picture the program must draw, captured by the teacher with "Use as
     * target" from a run of the reference solution — or written by hand in a
     * canonical file. Empty in a fresh draft (decision D16); publication
     * refuses it until it holds exactly one valid pixel per cell.
     */
    target: z.string().max(MAX_IMAGE_CHARS),
  })
  .superRefine((config, ctx) => {
    if (config.target === "") {
      ctx.addIssue({ code: "custom", message: "codeimage.target_missing", path: ["target"] });
      return;
    }
    const issue = imageStringIssue(config.target, config.image);
    if (issue !== null) {
      ctx.addIssue({ code: "custom", message: `codeimage.${issue}`, path: ["target"] });
    }
  });
export type CodeImageConfig = z.infer<typeof CodeImageConfig>;

/** The student's answer: the editable regions, exactly as `code` stores them. */
export const CodeImageAnswer = z.object({ regions: CodeAnswer.shape.regions });
export type CodeImageAnswer = z.infer<typeof CodeImageAnswer>;

/**
 * What a student receives: the program half every program question shares,
 * the image's dimensions and palette, and the TARGET — which is published on
 * purpose, like a visible case: drawing it is the exercise. The reference
 * solution, `compileArgs` and the extra files' bytes stay behind.
 */
export const CodeImageStudent = z.object({
  ...programStudentFields,
  image: ImageSpec,
  target: z.string(),
});
export type CodeImageStudent = z.infer<typeof CodeImageStudent>;

export const CodeImageSolution = z.object({
  referenceSolution: z.string(),
  image: ImageSpec,
  target: z.string(),
});
export type CodeImageSolution = z.infer<typeof CodeImageSolution>;

/**
 * Something a student should know about their output that the picture does
 * not say by itself. `extra`: tokens after the last pixel, ignored.
 * `missing`: the output stopped before the last pixel. `invalid`: tokens that
 * are not an integer of the palette's range.
 */
export const ImageWarning = z.object({
  code: z.enum(["extra", "missing", "invalid"]),
  count: z.number().int().min(1),
});
export type ImageWarning = z.infer<typeof ImageWarning>;

/** How the one run ended, beside the image it printed. */
export const RunEnd = z.object({
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  oom: z.boolean(),
  truncated: z.boolean(),
  ms: z.number(),
});
export type RunEnd = z.infer<typeof RunEnd>;

export const CodeImageDetails = z.object({
  runner: z.enum(["ok", "unavailable", "busy", "error"]),
  compile: z.object({ ok: z.boolean(), stderr: z.string().max(4000), ms: z.number() }).nullable(),
  /** `null` when the program never ran (no answer, a compile failure). */
  run: RunEnd.nullable(),
  /**
   * The image the program printed, in the compact encoding with `x` for an
   * invalid or missing pixel; `null` when it never ran. It is the student's
   * OWN output, never the key — and it is what "Use as target" reads when
   * the answer graded is the teacher's reference.
   */
  image: z.string().nullable(),
  /**
   * Cells equal to the target. Not `correct`: that key is on the blind strip
   * of a student's grading breakdown (`FORBIDDEN_DETAIL_KEYS`), which would
   * take the score's own numerator out of the review.
   */
  matching: z.number().int(),
  pixelCount: z.number().int(),
  warnings: z.array(ImageWarning),
  /** sha256 of the source the runner compiled; `null` when none was assembled. */
  sourceSha256: z.string().length(64).nullable(),
  /** Machine reason when nothing was graded, e.g. `empty` or `template_region_mismatch`. */
  reason: z.string().optional(),
});
export type CodeImageDetails = z.infer<typeof CodeImageDetails>;

/**
 * A fresh draft: the shape, the defaults and no content (decision D16) — an
 * empty prompt and an empty target, which publication refuses. `c`, like
 * `code`, because the editor needs a syntax to colour.
 */
export function emptyCodeImageConfig(): CodeImageConfig {
  return {
    configVersion: CODEIMAGE_CONFIG_VERSION,
    prompt: "",
    language: "c",
    runtime: "backend",
    template: "",
    files: [],
    action: "run",
    compileArgs: "",
    limits: DEFAULT_IMAGE_LIMITS,
    runsPerMinute: 10,
    referenceSolution: "",
    image: DEFAULT_IMAGE,
    target: "",
  };
}

