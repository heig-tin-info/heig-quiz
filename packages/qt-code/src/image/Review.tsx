/**
 * The feedback view of a `codeimage` answer: the score, the compiler's
 * refusal when there was one, and the picture the graded run printed beside
 * the target — the same panel, toggles and all, as the player's.
 *
 * Nothing here is hidden from a student: the image is their own output, the
 * target was on their screen during the attempt, and the reference solution
 * only arrives when the feedback policy sends the key.
 */
import { useMemo, useState } from "react";

import { resolveStrings } from "@quiz/core/client";
import type { MarkdownRenderer, ReviewProps } from "@quiz/core/client";
import { breakdownOf, hint, markdown } from "@quiz/ui";

import { CompileFailure, ReferenceSolutionCard, ScoreLine } from "../ProgramReview.js";
import { ImagePanel, type ImageLayout, type ImageView } from "./ImagePanel.js";
import { decodeImage } from "./pixels.js";
import {
  targetPixels,
  type CodeImageAnswer,
  type CodeImageDetails,
  type CodeImageSolution,
  type CodeImageStudent,
} from "./schema.js";
import {
  CODEIMAGE_PLAYER_DEFAULTS,
  CODEIMAGE_REVIEW_DEFAULTS,
  type CodeImagePlayerStrings,
  type CodeImageReviewStrings,
} from "./strings.js";

interface CodeImageReviewProps
  extends ReviewProps<CodeImageStudent, CodeImageAnswer, CodeImageSolution, CodeImageDetails> {
  /**
   * The review's own sentences, and — for the image panel it shares with the
   * player — the player's: one wording of "Target", "Difference", … for both.
   */
  strings?: Partial<CodeImageReviewStrings & CodeImagePlayerStrings> | undefined;
  renderMarkdown?: MarkdownRenderer | undefined;
}

export function CodeImageReview({
  student,
  answer,
  solution,
  details,
  points,
  maxPoints,
  strings,
  renderMarkdown,
}: CodeImageReviewProps) {
  const s = resolveStrings(
    { ...CODEIMAGE_PLAYER_DEFAULTS, ...CODEIMAGE_REVIEW_DEFAULTS },
    strings,
  );
  const [view, setView] = useState<ImageView>("diff");
  const [layout, setLayout] = useState<ImageLayout>("split");

  const spec = student.image;
  const count = spec.width * spec.height;
  const breakdown = breakdownOf(details, "warnings");
  const target = useMemo(() => targetPixels({ target: student.target, image: spec }), [student.target, spec]);
  const computed = useMemo(
    () =>
      breakdown === null || breakdown.image === null
        ? null
        : decodeImage(breakdown.image, spec.palette, count),
    [breakdown, spec.palette, count],
  );

  const statement = (
    <div className="whitespace-pre-wrap text-sm text-fg">
      {markdown(renderMarkdown, student.prompt)}
    </div>
  );

  if (breakdown === null) {
    return (
      <div className="flex flex-col gap-3">
        {statement}
        <p className={hint}>{answer === null ? s.notAnswered : s.runnerError}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {statement}
      <ScoreLine points={points} maxPoints={maxPoints} runner={breakdown.runner} s={s} />
      <CompileFailure compile={breakdown.compile} s={s} />
      {breakdown.reason === "empty" ? <p className={hint}>{s.notAnswered}</p> : null}
      {computed === null && breakdown.reason !== "empty" && breakdown.compile?.ok !== false ? (
        <p className={hint}>{s.noImage}</p>
      ) : null}
      <ImagePanel
        spec={spec}
        target={target}
        computed={computed}
        view={view}
        onView={setView}
        layout={layout}
        onLayout={setLayout}
        s={s}
        emptyLabel={s.noImage}
      />
      <ReferenceSolutionCard solution={solution} s={s} />
    </div>
  );
}

export default CodeImageReview;
