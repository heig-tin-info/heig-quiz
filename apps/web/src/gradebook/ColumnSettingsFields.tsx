/**
 * A gradebook column's settings in the mean (F-GBOOK-02, -06, ADR-131): where
 * it counts, then its weight. The fields only — the matrix's column dialog
 * draws them, and so may any other screen that sets a column (an
 * evaluation's, a project's): they take the current settings and the
 * course's components, and hand every change back.
 *
 * On a course with components of the mean, whether the column counts and
 * the component it counts in are ONE choice, "Counts in": each component,
 * then "Does not count". A column that counts in no component — it then
 * counts in no mean (ADR-131 §4) — shows no choice made, and says so beside
 * the warning sign, never by colour alone (N-A11Y-03). On a course without
 * components the choice is not drawn: whether a column counts stays the
 * matrix's quick menu item, and the fields are the weight alone.
 *
 * The weight is typed as text (a comma is a decimal point, so "2,5" is
 * refused rather than read as 25) and handed back as a number, NaN while it
 * is not one: the caller checks it with `GradebookWeight`, the route's own
 * schema (invariant 7).
 */
import { TriangleAlert } from "lucide-react";
import { useState } from "react";

import type { GradebookColumnPatch } from "@quiz/contracts";

import { useT } from "../i18n";
import { Field, Select } from "../ui";

/** Parses what a person typed in a number field: a comma is a decimal point; anything else is NaN. */
export const numberOf = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text.trim().replace(",", ".")));

/** A column's settings in the mean: its stored `counts` flag, its component (null for none) and its weight. */
export interface ColumnSettings {
  counts: boolean;
  componentId: string | null;
  weight: number;
}

/** A component as the choice names it. */
export interface ComponentChoice {
  id: string;
  name: string;
}

/** The choice's value for "Does not count"; a component's is its id (a uuid), and none made is "". */
const OUT = "out";

/**
 * The write that takes `before` to `after`, or null when nothing changed.
 * Choosing a component sends `{ counts: true, componentId }`; "Does not
 * count" sends `{ counts: false }` alone, the stored component kept for the
 * day the column counts again.
 */
export function settingsPatch(before: ColumnSettings, after: ColumnSettings): GradebookColumnPatch | null {
  const patch: GradebookColumnPatch = {};
  if (after.weight !== before.weight) patch.weight = after.weight;
  if (!after.counts && before.counts) patch.counts = false;
  if (after.counts && (!before.counts || after.componentId !== before.componentId)) {
    patch.counts = true;
    patch.componentId = after.componentId;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

export function ColumnSettingsFields({
  value,
  components,
  onChange,
}: {
  value: ColumnSettings;
  /** The course's components of the mean, in their order; none: the weight alone. */
  components: readonly ComponentChoice[];
  onChange: (next: ColumnSettings) => void;
}) {
  const t = useT();
  const [weightText, setWeightText] = useState(String(value.weight));
  const counting = components.length > 0;
  const choice = !value.counts ? OUT : (value.componentId ?? "");
  return (
    <>
      {counting ? (
        <div className="space-y-1.5">
          <Select
            label={t("gbook.settings.countsIn")}
            value={choice}
            autoFocus
            onChange={(e) => {
              const picked = e.target.value;
              onChange(picked === OUT ? { ...value, counts: false } : { ...value, counts: true, componentId: picked });
            }}
          >
            {/* Only drawn while no choice is made: a column that counts in no component. */}
            {choice === "" ? (
              <option value="" disabled>
                {t("gbook.settings.choose")}
              </option>
            ) : null}
            {components.map((component) => (
              <option key={component.id} value={component.id}>
                {component.name}
              </option>
            ))}
            <option value={OUT}>{t("gbook.settings.out")}</option>
          </Select>
          {choice === "" ? (
            <p className="flex items-start gap-1.5 text-[13px] text-fg-muted">
              <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
              {t("gbook.noComponent.help")}
            </p>
          ) : null}
        </div>
      ) : null}
      {/* The rule above the field, not under it: the field is three digits wide, and the sentence would wrap word by word. */}
      <p className="text-sm text-fg-muted">{t(counting ? "gbook.weight.componentHint" : "gbook.weight.hint")}</p>
      <Field
        label={t("gbook.weight.label")}
        inputMode="numeric"
        value={weightText}
        onChange={(e) => {
          setWeightText(e.target.value);
          onChange({ ...value, weight: numberOf(e.target.value) });
        }}
        autoFocus={!counting}
        width="w-28"
      />
    </>
  );
}
