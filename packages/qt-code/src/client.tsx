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

import { initialRegions } from "./segments.js";
import type { CodeAnswer, CodeConfig, CodeDetails, CodeSolution, CodeStudent } from "./schema.js";
/*
 * Two VALUES escape to the host, and only these two: the list of languages the
 * browser runner ships, and nothing else from `schema.ts`. `apps/web` decides
 * where a run executes (`src/runner/index.ts`) and needs the same list the
 * editor offers the teacher — one list, not two that drift (ADR-015).
 */
export { RUNNO_LANGUAGES } from "./schema.js";

function CodeIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
    </svg>
  );
}

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

  isAnswered(answer) {
    return answer !== null && answer.regions.some((r) => r.trim() !== "");
  },

  summarize(answer, student) {
    if (answer === null) return "—";
    const last = answer.lastRun;
    if (last !== undefined && last !== null) return `${last.passed}/${last.total}`;
    const seeded = initialRegions(student.segments);
    const written = answer.regions.filter((r, i) => r.trim() !== "" && r !== seeded[i]).length;
    return written === 0 ? "—" : `${written}/${seeded.length}`;
  },
};

export { CodeIcon };
export type {
  CodeAnswer,
  CodeCase,
  CodeConfig,
  CodeDetails,
  CodeLimits,
  CodeRuntime,
  CodeSegment,
  CodeSolution,
  CodeStudent,
} from "./schema.js";
/*
 * The three surfaces are deliberately NOT re-exported here: a static
 * `export ... from "./Editor.js"` would pull them (and Monaco's loader) back
 * into whatever imports this module, undoing the `lazy` above. A host that
 * genuinely needs one imports the file directly.
 */
export type { CodeEditorProps } from "./Editor.js";
export type { CodePlayerProps, CodeRunOptions, CodeRunStage } from "./Player.js";
export type { CodeReviewProps } from "./Review.js";
export type { CodeAreaProps } from "./MonacoHost.js";
export {
  EDITOR_STRINGS,
  PLAYER_STRINGS,
  REVIEW_STRINGS,
  withStrings,
  type CodeEditorStrings,
  type CodePlayerStrings,
  type CodeReviewStrings,
} from "./strings.js";
