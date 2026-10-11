/**
 * The `math` review: the answer as the parser read it, the verdict — and
 * "not readable" with its reason when the answer never reached the key —
 * then the accepted answers once the feedback policy shows them. It parses
 * nothing: the echo and the reason are what the server stored in the
 * details.
 */
import type { ReviewProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings, showsSection } from "@quiz/core/client";
import { type BadgeTone, caption, markdown, ReviewPrompt, ScoreHeader, Verdict } from "@quiz/ui";

import { MathEcho } from "./MathEcho.js";
import type { MathAnswer, MathDetails, MathSolution, MathStudent } from "./schema.js";
import { mathReviewStrings, type MathReviewStringKey } from "./strings.js";

type MathReviewProps = ReviewProps<MathStudent, MathAnswer, MathSolution, MathDetails> & {
  strings?: StringOverrides<MathReviewStringKey>;
};

export function MathReview({ student, answer, solution, details, points, maxPoints, sections, strings, renderMarkdown }: MathReviewProps) {
  const s = resolveStrings(mathReviewStrings, strings);
  const given = answer?.latex.trim() ?? "";
  const verdict: { tone: BadgeTone; label: string } | null =
    details === null || given === ""
      ? null
      : details.status === "invalid"
        ? { tone: "danger", label: s.notReadable }
        : details.fraction >= 1
          ? { tone: "success", label: s.accepted }
          : details.fraction > 0
            ? { tone: "warning", label: s.partially }
            : { tone: "danger", label: s.rejected };

  return (
    <div className="flex flex-col gap-3">
      <ReviewPrompt prompt={student.prompt} sections={sections} renderMarkdown={renderMarkdown} />

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium text-fg">{s.yourAnswer}</span>
        {given === "" ? (
          <span className={caption}>{s.noAnswer}</span>
        ) : (
          <code className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[13px] text-fg">{given}</code>
        )}
        {verdict ? <Verdict tone={verdict.tone}>{verdict.label}</Verdict> : null}
      </div>

      {given !== "" && details ? (
        <MathEcho
          reading={details.problem ? { problem: details.problem } : details.latex !== null ? { latex: details.latex } : null}
          symbols={student.symbols}
          strings={s}
          renderMarkdown={renderMarkdown}
        />
      ) : null}

      {typeof details?.matchedIndex === "number" ? (
        <p className={caption}>
          {s.matchedBy} #{details.matchedIndex + 1}
        </p>
      ) : null}

      {solution !== null && solution.answers.length > 0 && showsSection(sections, "solution") ? (
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-medium text-fg">{s.expected}</span>
          <ul className="flex flex-wrap gap-1.5">
            {solution.answers.map((expected, i) => (
              <li key={`${expected.value}-${i}`} className="rounded-full border border-line bg-surface px-2 py-0.5 text-xs text-fg-muted">
                {markdown(renderMarkdown, `$${expected.value}$`)}
                {expected.points < 1 ? <span className="ml-1 tabular-nums">({expected.points})</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ScoreHeader label={s.score} points={points} maxPoints={maxPoints} />
    </div>
  );
}
