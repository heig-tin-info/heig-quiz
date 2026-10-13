import { formatGrade, gradeBand, gradeLetter, type GradeBand } from "@quiz/domain";

import { useT } from "./i18n";
import { cx, Tip } from "./ui";

/** Red below the pass mark, orange just above it, the ink otherwise. */
export const GRADE_BAND_TONE: Record<GradeBand, "danger" | "warning" | undefined> = {
  fail: "danger",
  borderline: "warning",
  pass: undefined,
};

const TONE_TEXT = { danger: "text-danger", warning: "text-warning" } as const;

/**
 * A Swiss grade as every screen writes it: one decimal, coloured by its band
 * (`gradeBand`), and its ECTS label ("Satisfactory (D)") on hover. The same
 * for the teacher and for the student: seeing that a 3.5 is a fail is the
 * point. The label is also in the text for a screen reader, since the Tip's
 * bubble is aria-hidden and a colour says nothing to it. `neutral` drops
 * the band's colour, for a grade that is only indicative.
 */
export function Grade({ value, neutral = false }: { value: number; neutral?: boolean }) {
  const t = useT();
  const label = t(`grade.letter.${gradeLetter(value)}`);
  // An indicative grade (practice that does not count, #803) keeps the ink: no band says "fail" there.
  const tone = neutral ? undefined : GRADE_BAND_TONE[gradeBand(value)];
  return (
    <Tip label={label}>
      <span className={tone ? TONE_TEXT[tone] : undefined}>
        {formatGrade(value)}
        <span className="sr-only"> ({label})</span>
      </span>
    </Tip>
  );
}
