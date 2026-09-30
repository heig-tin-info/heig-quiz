import { useState } from "react";

import {
  currentOrNextSemester,
  nextSemester,
  semesterMonths,
  semesterOfRange,
  type Semester,
} from "@quiz/domain";

import { useT, type TFunction } from "./i18n";
import { ErrorText, Field, FieldLabel, ToggleChip } from "./ui";

/**
 * The period of a classroom as the forms edit it (F-ORG-03, #156): a free
 * label, and a first and last month (`YYYY-MM`, both or neither — "" in the
 * inputs means none). The body sent to the API is {@link periodBody}.
 */
export interface PeriodDraft {
  period: string;
  periodStart: string;
  periodEnd: string;
}

/** The draft as the API takes it: an empty month is `null`. */
export function periodBody(d: PeriodDraft) {
  return {
    period: d.period.trim(),
    periodStart: d.periodStart || null,
    periodEnd: d.periodEnd || null,
  };
}

/**
 * Whether the contract (`ClassroomCreate` / `ClassroomPatch`, the schemas the
 * API validates with) refused the months — half a period, a malformed month
 * or an end before the start.
 */
export function periodInvalid(parsed: {
  error?: { issues: { path: PropertyKey[] }[] } | undefined;
}): boolean {
  return (parsed.error?.issues ?? []).some(
    (i) => i.path[0] === "periodStart" || i.path[0] === "periodEnd",
  );
}

/** "Autumn 2026" / "Automne 2026": a preset's name, and the label it fills. */
export function semesterLabel(s: Semester, t: TFunction): string {
  return t(s.season === "autumn" ? "classrooms.autumn" : "classrooms.spring", { year: s.year });
}

/** The semester whose months the draft holds exactly, if any. */
function draftSemester(d: PeriodDraft): Semester | null {
  return d.periodStart && d.periodEnd
    ? semesterOfRange({ start: d.periodStart, end: d.periodEnd })
    : null;
}

/** The two presets: the current-or-next semester, and the one after it. */
function presetSemesters(today: Date): [Semester, Semester] {
  const first = currentOrNextSemester(today);
  return [first, nextSemester(first)];
}

/**
 * The draft of a new classroom: the first preset, label included — applied
 * once, as if clicked.
 */
export function newPeriodDraft(today: Date, t: TFunction): PeriodDraft {
  const [s] = presetSemesters(today);
  const { start, end } = semesterMonths(s);
  return { period: semesterLabel(s, t), periodStart: start, periodEnd: end };
}

/**
 * The dates of a classroom and its label, for the create and the edit
 * dialogs. Two presets — the current-or-next semester and the one after —
 * fill both months; a preset fills the LABEL too, but only while the label is
 * empty or still the previous preset's name, so a label the teacher typed is
 * never overwritten. "No dates" empties the months: the classroom is then
 * always in the sidebar, archiving is its only filter.
 *
 * The months and the presets read as ONE field ("Dates"), which keeps the
 * create dialog at three.
 */
export function PeriodFields({
  value,
  onChange,
  invalid,
}: {
  value: PeriodDraft;
  onChange: (next: PeriodDraft) => void;
  /** The months fail the contract (half a period, or end before start). */
  invalid: boolean;
}) {
  const t = useT();
  const [presets] = useState(() => presetSemesters(new Date()));
  // The name of the preset that last wrote the label: while the label still
  // says that, the next preset may replace it. Seeded from the months the
  // dialog opens with, so an edit behaves like a creation.
  const [presetLabel, setPresetLabel] = useState(() => {
    const s = draftSemester(value);
    return s ? semesterLabel(s, t) : "";
  });
  const shown = draftSemester(value);
  const apply = (s: Semester) => {
    const label = semesterLabel(s, t);
    const { start, end } = semesterMonths(s);
    const keepLabel = value.period.trim() !== "" && value.period !== presetLabel;
    onChange({ period: keepLabel ? value.period : label, periodStart: start, periodEnd: end });
    setPresetLabel(label);
  };
  const undated = value.periodStart === "" && value.periodEnd === "";

  return (
    <>
      <fieldset className="space-y-2">
        <legend className="mb-1.5">
          <FieldLabel>{t("classrooms.dates")}</FieldLabel>
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={t("classrooms.firstMonth")}
            type="month"
            fullWidth
            placeholder="2026-09"
            value={value.periodStart}
            aria-invalid={invalid || undefined}
            onChange={(e) => onChange({ ...value, periodStart: e.target.value })}
          />
          <Field
            label={t("classrooms.lastMonth")}
            type="month"
            fullWidth
            placeholder="2027-01"
            value={value.periodEnd}
            aria-invalid={invalid || undefined}
            onChange={(e) => onChange({ ...value, periodEnd: e.target.value })}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {presets.map((s) => (
            <ToggleChip
              key={`${s.season}-${s.year}`}
              label={semesterLabel(s, t)}
              pressed={shown?.season === s.season && shown.year === s.year}
              onToggle={() => apply(s)}
            />
          ))}
          <ToggleChip
            label={t("classrooms.noDates")}
            pressed={undated}
            onToggle={() => onChange({ ...value, periodStart: "", periodEnd: "" })}
          />
        </div>
        {invalid ? (
          <ErrorText>{t("classrooms.datesInvalid")}</ErrorText>
        ) : undated ? null : (
          <p className="text-xs text-fg-faint">{t("classrooms.datesHint")}</p>
        )}
      </fieldset>
      <Field
        label={t("classrooms.period")}
        fullWidth
        placeholder={t("classrooms.periodPlaceholder")}
        value={value.period}
        onChange={(e) => onChange({ ...value, period: e.target.value })}
      />
    </>
  );
}
