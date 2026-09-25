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
import { decodeImage, imageStringIssue } from "./pixels.js";

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

/**
 * A captured picture: the compact pixels AND the size and palette they were
 * captured under. The dimensions travel with the pixels because the pixel
 * COUNT alone cannot tell a 4 × 3 target from a 3 × 4 one — both are twelve
 * characters — and reading one as the other would compare the wrong cells.
 */
export const ImageTarget = ImageSpec.extend({ pixels: z.string().max(MAX_IMAGE_CHARS) });
export type ImageTarget = z.infer<typeof ImageTarget>;

/** A target from a spec and its encoded pixels, the shape "Use as target" writes. */
export const makeTarget = (spec: ImageSpec, pixels: string): ImageTarget => ({
  width: spec.width,
  height: spec.height,
  palette: spec.palette,
  pixels,
});

/** Whether a target was captured under exactly this image's size and palette. */
export const targetFits = (target: ImageTarget, image: ImageSpec): boolean =>
  target.width === image.width && target.height === image.height && target.palette === image.palette;

/**
 * The gate of USE: what a config must be to be previewed, tried and graded.
 * It deliberately says nothing about whether the target fits the image —
 * see {@link codeimagePublicationIssues}.
 */
export const CodeImageConfig = z.object({
  configVersion: z.literal(CODEIMAGE_CONFIG_VERSION),
  ...programFields,
  limits: CodeImageLimits.default(DEFAULT_IMAGE_LIMITS),
  image: ImageSpec,
  /**
   * The picture the program must draw, captured by the teacher with "Use as
   * target" from a run of the reference solution — or written by hand in a
   * canonical file. `null` in a fresh draft, and STALE once the teacher
   * changes the size or the palette (its own dimensions no longer match
   * `image`): both are usable (the try that captures a new one needs them to
   * be), and both read as "no target" everywhere a target is compared. Only
   * publication requires a fitting one.
   */
  target: ImageTarget.nullable().default(null),
});
export type CodeImageConfig = z.infer<typeof CodeImageConfig>;

/**
 * What publication requires beyond the schema (`publicationIssues` of the
 * contract, decision D16): a target with exactly one valid pixel per cell of
 * the CURRENT image. Not a schema refinement, because the schema also gates
 * `POST /questions/:id/try` — the one route that lets a teacher capture the
 * first target, or a new one after a resize.
 */
export function codeimagePublicationIssues(
  config: Pick<CodeImageConfig, "target" | "image">,
): { path: string[]; message: string }[] {
  const { target, image } = config;
  if (target === null) return [{ path: ["target"], message: "codeimage.target_missing" }];
  if (!targetFits(target, image)) return [{ path: ["target"], message: "codeimage.target_size" }];
  const issue = imageStringIssue(target.pixels, image);
  return issue === null ? [] : [{ path: ["target"], message: `codeimage.${issue}` }];
}

/**
 * The target as pixels, or `null` when there is none that fits the image —
 * an empty target, or one left stale by a change of size or palette. The
 * ONE reading of a stored target: the grader, the player, the review and
 * the editor all compare against this, so a stale target is never indexed
 * as if it matched.
 */
export function targetPixels(config: Pick<CodeImageConfig, "target" | "image">): Int16Array | null {
  const { target, image } = config;
  if (target === null || !targetFits(target, image)) return null;
  if (imageStringIssue(target.pixels, image) !== null) return null;
  return decodeImage(target.pixels, image.palette, image.width * image.height);
}

/** The student's answer: the editable regions, exactly as `code` stores them. */
export const CodeImageAnswer = z.object({ regions: CodeAnswer.shape.regions });
export type CodeImageAnswer = z.infer<typeof CodeImageAnswer>;

/**
 * Whether the answer holds something (issue #89): the ONE predicate behind
 * both `isAnswered` hooks, server and client, so the student's list and the
 * teacher's grid can never disagree about it.
 */
export function isCodeImageAnswered(answer: CodeImageAnswer): boolean {
  return answer.regions.some((region) => region.trim() !== "");
}

/**
 * What a student receives: the program half every program question shares,
 * the image's dimensions and palette, and the TARGET — which is published on
 * purpose, like a visible case: drawing it is the exercise. The reference
 * solution, `compileArgs` and the extra files' bytes stay behind.
 */
export const CodeImageStudent = z.object({
  ...programStudentFields,
  image: ImageSpec,
  target: ImageTarget.nullable(),
});
export type CodeImageStudent = z.infer<typeof CodeImageStudent>;

export const CodeImageSolution = z.object({
  referenceSolution: z.string(),
  image: ImageSpec,
  target: ImageTarget.nullable(),
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
    // A new question runs the student's trials in the browser, as for `code`
    // (`emptyCodeConfig`); a stored config keeps the zod default.
    runtime: "runno",
    cooldown: "fixed",
    template: "",
    files: [],
    action: "run",
    compileArgs: "",
    limits: DEFAULT_IMAGE_LIMITS,
    runsPerMinute: 10,
    referenceSolution: "",
    image: DEFAULT_IMAGE,
    target: null,
  };
}

