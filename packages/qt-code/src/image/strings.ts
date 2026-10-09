/**
 * UI strings of the `codeimage` surfaces, English by default — the same
 * pattern as `../strings.ts` (the host translates key by key, `{var}`
 * templates, a `<key>.one` sibling for a count of one).
 *
 * Only what a PICTURE adds lives here. The program half — the statement,
 * the regions, the Run button, the reference solution — reads `code`'s own
 * dictionaries, so a sentence both types say is written and translated once;
 * the few `code` sentences that speak of cases are re-worded below under the
 * same key, and the image dictionary wins.
 */
import {
  EDITOR_STRINGS,
  GRADING_STRINGS,
  PLAYER_STRINGS,
  REVIEW_STRINGS,
  type CodeEditorStrings,
  type CodeGradingStrings,
  type CodePlayerStrings,
  type CodeReviewStrings,
} from "../strings.js";
import type { ProgramEditorStrings } from "../ProgramEditor.js";
import type { ProgramPlayerStrings } from "../ProgramPlayer.js";
import type { ProgramReviewStrings } from "../ProgramReview.js";

export const IMAGE_EDITOR_STRINGS = {
  /** Re-worded for a picture: the reference draws the target, it checks no case. */
  referenceSolutionHint:
    "Your own answer, in the student's editor. The button below runs it and draws its image, which you can then use as the target. Students see it when the evaluation shows the expected answer.",
  imageSection: "Image",
  imageHint:
    "The program prints width × height integers on its standard output, separated by spaces, tabs or newlines, row by row from the top left. They are the pixels.",
  width: "Width",
  height: "Height",
  sizeHint: "From {min} to {max} cells per side.",
  palette: "Palette",
  paletteBw: "Black and white (0–1)",
  paletteColor16: "16 colours (0–15)",
  paletteGray256: "Grey levels (0–255)",
  target: "Target",
  targetHint: "What the student must draw. It is shown to the student beside their own image.",
  targetEmpty: "No target yet: try the reference solution, then use its image as the target.",
  targetInvalid:
    "The target no longer fits the size or the palette. Try the reference solution again and use its image.",
  referenceImage: "The reference solution's image",
  useAsTarget: "Use as target",
  targetSet: "This image is the target.",
  tryMatch: "{matching} of {total} pixels match the current target.",
  tryDrawn: "The reference solution drew its image.",
  tryIncomplete:
    "The image has invalid or missing pixels, so it cannot be the target. Fix the reference solution and try again.",
  tryStale: "The size or the palette changed since this run. Try the reference solution again.",
};

export type ImageEditorStrings = typeof IMAGE_EDITOR_STRINGS;

export const IMAGE_PLAYER_STRINGS = {
  imageSection: "Image",
  view: "View",
  viewTarget: "Target",
  viewComputed: "Computed",
  viewDiff: "Difference",
  layout: "Layout",
  layoutSingle: "Single",
  layoutSplit: "Side by side",
  targetImage: "Target image",
  computedImage: "Your image",
  diffImage: "Difference with the target",
  notRunYet: "Run your program to see its image.",
  noTarget: "No target has been set for this question yet.",
  pixelScore: "{matching} / {total} pixels correct ({percent} %)",
  diffOk: "Correct",
  diffWrong: "Wrong",
  legend: "Colours",
  warningExtra: "{count} values after the last pixel were ignored.",
  "warningExtra.one": "1 value after the last pixel was ignored.",
  warningMissing: "The output stopped {count} pixels short of the image.",
  "warningMissing.one": "The output stopped 1 pixel short of the image.",
  warningInvalid:
    "{count} values are not integers of the palette's range; they are drawn hatched and count as wrong.",
  "warningInvalid.one":
    "1 value is not an integer of the palette's range; it is drawn hatched and counts as wrong.",
  endTimedOut: "The program ran out of time. The image shows what it printed before.",
  endOutOfMemory: "The program ran out of memory. The image shows what it printed before.",
  endCrashed: "The program crashed. The image shows what it printed before.",
  endTruncated: "The output was cut at the size limit.",
};

export type ImagePlayerStrings = typeof IMAGE_PLAYER_STRINGS;

export const IMAGE_REVIEW_STRINGS = {
  noImage: "The program printed no image.",
};

export type ImageReviewStrings = typeof IMAGE_REVIEW_STRINGS;

/** Everything the editor reads: `code`'s program half, its try row, and the above. */
export type CodeImageEditorStrings = ProgramEditorStrings &
  Pick<
    CodeEditorStrings,
    | "tryReference"
    | "trying"
    | "tryUnavailable"
    | "tryCompileFailed"
    | "tryRegionsMismatch"
    | "advanced"
  > &
  ImageEditorStrings;

export type CodeImagePlayerStrings = ProgramPlayerStrings &
  Pick<CodePlayerStrings, "loadingRuntime"> &
  ImagePlayerStrings;

export type CodeImageReviewStrings = ProgramReviewStrings &
  Pick<CodeReviewStrings, "runnerError" | "notAnswered"> &
  ImageReviewStrings;

/** The complete English defaults of each surface: `code`'s, then the image's on top. */
export const CODEIMAGE_EDITOR_DEFAULTS: CodeImageEditorStrings = {
  ...EDITOR_STRINGS,
  ...IMAGE_EDITOR_STRINGS,
};
export const CODEIMAGE_PLAYER_DEFAULTS: CodeImagePlayerStrings = {
  ...PLAYER_STRINGS,
  ...IMAGE_PLAYER_STRINGS,
};
export const CODEIMAGE_REVIEW_DEFAULTS: CodeImageReviewStrings = {
  ...REVIEW_STRINGS,
  ...IMAGE_REVIEW_STRINGS,
};

/** What the grading table's picture column adds to `code`'s program column (ADR-044). */
export const IMAGE_GRADING_STRINGS = {
  column: "Picture · program",
  /** The accessible name of a student's thumbnail, and of the key's. */
  picture: "The picture the program draws",
  target: "The target picture",
  noPicture: "No picture",
};

export type ImageGradingStrings = typeof IMAGE_GRADING_STRINGS;

export type CodeImageGradingStrings = CodeGradingStrings & ImageGradingStrings;

export const CODEIMAGE_GRADING_DEFAULTS: CodeImageGradingStrings = {
  ...GRADING_STRINGS,
  ...IMAGE_GRADING_STRINGS,
};
