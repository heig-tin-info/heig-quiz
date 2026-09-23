/**
 * Answer distribution of one `mcq` item, for the teacher's item view.
 *
 * The counting rule is `@quiz/domain/stats#mcqDistribution`; this component
 * only draws it. It is the one `Stats` of the MVP (PLAN-MVP §8 WP2).
 */
import type { StatsProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import { mcqDistribution } from "@quiz/domain/stats";
import type { McqAnswer, McqStudent } from "./schema.js";
import { mcqStatsStrings, type McqStatsStringKey } from "./strings.js";
import { choiceLetter } from "./ui.js";
import { helpClass } from "@quiz/ui";

type McqStatsProps = StatsProps<McqStudent, McqAnswer> & {
  strings?: StringOverrides<McqStatsStringKey>;
};

export function McqStats({ student, answers, strings }: McqStatsProps) {
  const s = resolveStrings(mcqStatsStrings, strings);
  const counts = mcqDistribution(answers, student.choices.length);
  const total = answers.length;
  // The display order is the student's, the counts are canonical.
  const rows = student.choices.map((choice, position) => ({
    id: choice.id,
    label: choiceLetter(position),
    text: choice.text,
    count: counts[choice.id] ?? 0,
  }));
  const top = Math.max(1, ...rows.map((r) => r.count));

  if (total === 0) return <p className={helpClass}>{s.noAnswers}</p>;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[13px] font-medium text-fg">{s.title}</h3>
      <ul className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center gap-2 text-sm">
            <span className="w-5 shrink-0 text-center text-[13px] text-fg-faint">{row.label}</span>
            <span className="min-w-0 flex-1 truncate text-fg">{row.text}</span>
            <span className="h-2 w-32 shrink-0 overflow-hidden rounded-full bg-surface-3">
              <span
                className="block h-full rounded-full bg-accent"
                style={{ width: `${Math.round((row.count / top) * 100)}%` }}
              />
            </span>
            <span className="w-10 shrink-0 text-right tabular-nums text-fg-muted">{row.count}</span>
          </li>
        ))}
      </ul>
      <p className={helpClass}>
        {total} {s.respondents}
      </p>
    </section>
  );
}
