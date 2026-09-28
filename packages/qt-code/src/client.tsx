/**
 * `@quiz/qt-code/client` — the browser half of the `code` question type.
 *
 * The three surfaces are `React.lazy`, so Monaco (and this package's markup)
 * stay out of the initial bundle (N-PERF-05). The icon is inline SVG rather
 * than a `lucide-react` import: a package must not drag a second icon set into
 * the app's bundle to draw one glyph.
 */
import { lazy } from "react";

import type { QuestionTypeClient } from "@quiz/core/client";
import { typeIcon } from "@quiz/ui";
import { isCodeAnswered } from "./schema.js";

import type { CodeAnswer, CodeConfig, CodeDetails, CodeSolution, CodeStudent } from "./schema.js";
/*
 * Two VALUES escape to the host, and only these two: the list of languages the
 * browser runner ships, and nothing else from `schema.ts`. `apps/web` decides
 * where a run executes (`src/runner/index.ts`) and needs the same list the
 * editor offers the teacher — one list, not two that drift (ADR-015).
 */
export { RUNNO_LANGUAGES } from "./schema.js";

const CodeIcon = typeIcon(<path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />);

export const codeClient: QuestionTypeClient<
  CodeConfig,
  CodeAnswer,
  CodeStudent,
  CodeSolution,
  CodeDetails
> = {
  id: "code",
  labelKey: "qt.code.label",
  hintKey: "qt.code.hint",
  Icon: CodeIcon,

  Editor: lazy(() => import("./Editor.js")),
  Player: lazy(() => import("./Player.js")),
  Review: lazy(() => import("./Review.js")),

  /**
   * Empty, not seeded: the player displays the template's editable text when a
   * region is missing, so an untouched question stays "not answered" in the
   * progress segments instead of looking done from the first render.
   */
  emptyAnswer() {
    return { regions: [] };
  },

  isAnswered: isCodeAnswered,
};

/*
 * The reference solution read as regions (docs/spec/04 §4.7) — the pure rule
 * behind the editor's "try" button. A plain function, so it costs the bundle
 * nothing and stays out of the lazy chunks.
 */
export { referenceRegions } from "./reference.js";
export type { CodeAnswer, CodeConfig, CodeDetails, CodeRuntime, CodeStudent } from "./schema.js";
/*
 * The three surfaces are deliberately NOT re-exported here: a static
 * `export ... from "./Editor.js"` would pull them (and Monaco's loader) back
 * into whatever imports this module, undoing the `lazy` above. A host that
 * genuinely needs one imports the file directly.
 */
export type { CodeEditorProps } from "./Editor.js";
export type { CodeRunOptions, CodeRunStage } from "./Player.js";
export { EDITOR_STRINGS, PLAYER_STRINGS, REVIEW_STRINGS } from "./strings.js";
/** The program half both player views share: what a browser request is built from. */
export type { ProgramConfig, ProgramStudent } from "./schema.js";

/*
 * `codeimage` (docs/spec/04 §4.9, ADR-021): the variant of `code` judged by a
 * picture. Its client entry, its dictionaries (only what a picture adds — the
 * program half reads `code`'s), the one case of its run and the pure pixel
 * rules the host and the mocks read.
 */
export { codeimageClient } from "./image/client.js";
export { IMAGE_CASE } from "./image/schema.js";
export type {
  CodeImageAnswer,
  CodeImageConfig,
  CodeImageDetails,
  CodeImageStudent,
  ImageSpec,
} from "./image/schema.js";
export { encodeImage } from "./image/pixels.js";
export type { CodeImageEditorProps } from "./image/Editor.js";
export { IMAGE_EDITOR_STRINGS, IMAGE_PLAYER_STRINGS, IMAGE_REVIEW_STRINGS } from "./image/strings.js";
