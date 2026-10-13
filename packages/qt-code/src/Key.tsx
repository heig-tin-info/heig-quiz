/**
 * The program answer key of the debrief (ADR-033, ADR-109), `code`'s and
 * `codeimage`'s alike: the reference solution beside the host's test-case
 * bars, under the statement and above the answer groups (a code image's
 * accuracy buckets).
 *
 * The reference is drawn whole — the template's locked text around its
 * pieces, as the student's editor showed them — and, hidden, it is the code
 * the class started from in its place, named as such: the reveal fills in
 * the regions the students wrote. A program with no template to start from
 * keeps a hatched block, named too, so it never reads as an empty field.
 *
 * Staff only (`QuestionTypeClient.Key`): never mounted on a student surface.
 */
import type { KeyProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import { CORRECTION_SCALE, cx, KeyFigure, KeyHatch } from "@quiz/ui";

import { referenceProgram } from "./reference.js";
import type { ProgramStudent } from "./schema.js";
import { KEY_STRINGS } from "./strings.js";

/** The code block's padding and type, per density. */
const CODE = {
  wall: "p-5 text-[clamp(14px,1.25vw,19px)]",
  page: "p-4 text-xs",
} as const;

type ProgramKeyProps = KeyProps<ProgramStudent, { referenceSolution: string }> & {
  strings?: StringOverrides<keyof typeof KEY_STRINGS>;
};

export function ProgramKey({
  student,
  solution,
  revealed,
  density,
  stats,
  prompt,
  rows,
  cases,
  strings,
}: ProgramKeyProps) {
  const s = resolveStrings(KEY_STRINGS, strings);
  const scale = CORRECTION_SCALE[density];
  const text = solution?.referenceSolution;
  const reference = typeof text === "string" && text.trim() !== "" ? text : null;
  const segments = student.segments;
  const whole = (body: string) => (Array.isArray(segments) ? referenceProgram(segments, body) : null);
  // The raw reference when the template cannot hold it: never nothing.
  const key = reference === null ? null : (whole(reference) ?? reference);
  const start = whole("");
  const shown = revealed ? key : start?.trim() ? start : null;
  const label = revealed ? s.reference : shown === null ? s.hidden : s.start;
  return (
    <>
      {prompt}
      {key === null && cases === null ? null : (
        <div className={scale.program}>
          {key === null ? null : (
            <KeyFigure density={density} caption={label}>
              {shown === null ? (
                // Hidden with nothing to start from: a hatched block of a fixed height.
                <KeyHatch className="h-40" />
              ) : (
                <pre
                  // A focusable scroll region: it runs past the screen edge on a
                  // phone, and a keyboard cannot reach into a container that
                  // holds nothing focusable (W10).
                  tabIndex={0}
                  role="region"
                  aria-label={label}
                  className={cx(
                    "overflow-x-auto rounded-card border border-line font-mono leading-relaxed",
                    CODE[density],
                    revealed ? "bg-surface" : "bg-surface-2",
                  )}
                >
                  {shown}
                </pre>
              )}
            </KeyFigure>
          )}
          {cases}
        </div>
      )}
      {/* The blanks alone say nothing the head does not: a row of them needs groups. */}
      {stats.distribution.length > 0 ? rows : null}
    </>
  );
}
