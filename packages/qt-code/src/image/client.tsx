/**
 * The browser half of the `codeimage` question type, exported by
 * `@quiz/qt-code/client` beside `codeClient`. The three surfaces are
 * `React.lazy`, like `code`'s, so Monaco stays out of the initial bundle.
 */
import { lazy } from "react";

import type { QuestionTypeClient } from "@quiz/core/client";

import { editableSegments } from "../segments.js";
import type {
  CodeImageAnswer,
  CodeImageConfig,
  CodeImageDetails,
  CodeImageSolution,
  CodeImageStudent,
} from "./schema.js";

/** A framed grid: a picture made of cells. Inline SVG, like `CodeIcon`. */
export function CodeImageIcon({ className }: { className?: string }) {
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
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
      <path d="M9 9h6v6H9z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export const codeimageClient: QuestionTypeClient<
  CodeImageConfig,
  CodeImageAnswer,
  CodeImageStudent,
  CodeImageSolution,
  CodeImageDetails
> = {
  id: "codeimage",
  labelKey: "qt.codeimage.label",
  hintKey: "qt.codeimage.hint",
  Icon: CodeImageIcon,

  Editor: lazy(() => import("./Editor.js")),
  Player: lazy(() => import("./Player.js")),
  Review: lazy(() => import("./Review.js")),

  /** Empty, not seeded — `code`'s rule: an untouched question stays "not answered". */
  emptyAnswer() {
    return { regions: [] };
  },

  isAnswered(answer) {
    return answer !== null && answer.regions.some((r) => r.trim() !== "");
  },

  summarize(answer, student) {
    if (answer === null) return "—";
    const seeded = editableSegments(student.segments).map((s) => s.text);
    const written = answer.regions.filter((r, i) => r.trim() !== "" && r !== seeded[i]).length;
    return written === 0 ? "—" : `${written}/${seeded.length}`;
  },
};
