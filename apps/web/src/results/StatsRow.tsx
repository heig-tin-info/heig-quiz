import { isPassing } from "@quiz/domain";
import type { ResultRow, ResultsStats } from "@quiz/contracts";

import { useT } from "../i18n";
import { Stat } from "../ui";

/** One decimal, the way a Swiss grade is written. */
const g = (n: number) => n.toFixed(1);

/**
 * The four numbers F-RES-01 asks for, in the `Stat` primitive: mean, median,
 * standard deviation and the pass rate. The absent students are in them —
 * they hold a 1.0 (deviation W6-10) — or every class average would flatter
 * the teacher who reads it.
 */
export function StatsRow({ stats, rows }: { stats: ResultsStats; rows: ResultRow[] }) {
  const t = useT();
  const passing = rows.filter((r) => isPassing(r.grade)).length;
  const rate = rows.length === 0 ? 0 : Math.round((passing / rows.length) * 100);
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Stat
        label={t("results.stat.mean")}
        value={g(stats.mean)}
        hint={t("results.stat.students", { n: stats.count })}
      />
      <Stat label={t("results.stat.median")} value={g(stats.median)} />
      <Stat label={t("results.stat.stdev")} value={stats.stdev.toFixed(2)} />
      <Stat
        label={t("results.stat.passRate")}
        value={`${rate}%`}
        hint={`${passing} / ${rows.length}`}
      />
    </div>
  );
}
