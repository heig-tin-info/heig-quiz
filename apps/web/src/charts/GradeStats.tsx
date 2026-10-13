import type { Description } from "@quiz/domain";

import { Grade } from "../Grade";
import { useT } from "../i18n";
import { Stat } from "../ui";

/**
 * The four numbers beside a grade histogram (`Summary`, F-RES-01): mean,
 * median, standard deviation and the pass rate, in the `Stat` primitive.
 * Who is counted is the caller's: the results count the class with its
 * absent students (they hold a 1.0, deviation W6-10) and never a teacher's
 * own test walk (ADR-018); a project's Grading tab counts its validated
 * repositories. `countLabel` names that count beside the mean ("24
 * students"); the pass rate is `passing` over `total`.
 */
export function GradeStats({
  description,
  countLabel,
  passing,
  total,
}: {
  description: Pick<Description, "mean" | "median" | "stdev">;
  countLabel: string;
  passing: number;
  total: number;
}) {
  const t = useT();
  const rate = total === 0 ? 0 : Math.round((passing / total) * 100);
  return (
    <>
      <Stat label={t("results.stat.mean")} value={<Grade value={description.mean} />} aside={countLabel} />
      <Stat label={t("results.stat.median")} value={<Grade value={description.median} />} />
      <Stat label={t("results.stat.stdev")} value={description.stdev.toFixed(2)} />
      <Stat label={t("results.stat.passRate")} value={`${rate}%`} aside={`${passing} / ${total}`} />
    </>
  );
}
