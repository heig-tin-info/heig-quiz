import { formatGrade, gradeBand, gradeLetter, type GradeBand } from "@quiz/domain";

import { useT } from "./i18n";
import { cx, Tip } from "./ui";

/** Red below the pass mark, orange just above it, the ink around it otherwise. */
export const GRADE_BAND_TEXT: Record<GradeBand, string> = {
  fail: "text-danger",
  borderline: "text-warning",
  pass: "",
};

/**
 * A Swiss grade as every screen writes it: one decimal, coloured by its band
 * (`gradeBand`), and its ECTS label ("Satisfactory (D)") on hover. The same
 * for the teacher and for the student: seeing that a 3.5 is a fail is the
 * point. The label is also in the text for a screen reader, since the Tip's
 * bubble is aria-hidden and a colour says nothing to it.
 */
export function Grade({ value }: { value: number }) {
  const t = useT();
  const label = t(`grade.letter.${gradeLetter(value)}`);
  return (
    <Tip label={label}>
      <span className={GRADE_BAND_TEXT[gradeBand(value)]}>
        {formatGrade(value)}
        <span className="sr-only"> ({label})</span>
      </span>
    </Tip>
  );
}
