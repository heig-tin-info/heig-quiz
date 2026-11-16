/**
 * A gradebook column's settings in the mean (F-GBOOK-02, -06, ADR-131): where
 * it counts, then its weight. The fields only — the matrix's column dialog
 * draws them, and so may any other screen that sets a column (an
 * evaluation's, a project's): they take the current settings and the
 * course's components, and hand every change back.
 *
 * Whether the column counts and where are ONE choice. On a course with
 * components of the mean: "Component", each component then "Out of the
 * mean"; a column that counts in no component — it then counts in no mean
 * (ADR-131 §4) — shows "No component" and says so beside the warning sign,
 * never by colour alone (N-A11Y-03). On a course without components: "Mean",
 * "In the mean" (the domain's one implicit component) or "Out of the mean".
 *
 * The weight is typed as text and handed back as a number (`WeightField`),
 * NaN while it is not one: the caller checks it with `GradebookWeight`, the
 * route's own schema (invariant 7).
 */
import { TriangleAlert } from "lucide-react";
import { useId, useState } from "react";

import type { GradebookColumnPatch, GradebookCourseComponent } from "@quiz/contracts";

import { useT } from "../i18n";
import { Field, numberOf, Select } from "../ui";

/** A column's settings in the mean: its stored `counts` flag, its component (null for none) and its weight. */
export interface ColumnSettings {
  counts: boolean;
  componentId: string | null;
  weight: number;
}

/** The choice's value for "Out of the mean", and for "In the mean" without components; a component's is its id (a uuid), and none made is "". */
const OUT = "out";
const IN = "in";

/**
 * The write that takes `before` to `after`, or null when nothing changed.
 * Counting again, or in another component, sends `counts: true` and the
 * component when it changed (never one on a course without components);
 * "Out of the mean" sends `{ counts: false }` alone, the stored component
 * kept for the day the column counts again.
 */
export function settingsPatch(before: ColumnSettings, after: ColumnSettings): GradebookColumnPatch | null {
  const patch: GradebookColumnPatch = {};
  if (after.weight !== before.weight) patch.weight = after.weight;
  if (after.counts !== before.counts) patch.counts = after.counts;
  if (after.counts && after.componentId !== before.componentId) {
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
  /** The course's components of the mean, in their order; none: in the mean or out of it. */
  components: readonly Pick<GradebookCourseComponent, "id" | "name">[];
  onChange: (next: ColumnSettings) => void;
}) {
  const t = useT();
  const hasComponents = components.length > 0;
  const choice = !value.counts ? OUT : !hasComponents ? IN : (value.componentId ?? "");
  return (
    <>
      <div className="space-y-1.5">
        <Select
          label={t(hasComponents ? "gbook.settings.component" : "gbook.settings.mean")}
          value={choice}
          autoFocus
          onChange={(e) => {
            const picked = e.target.value;
            onChange(
              picked === OUT
                ? { ...value, counts: false }
                : picked === IN
                  ? { ...value, counts: true }
                  : { ...value, counts: true, componentId: picked },
            );
          }}
        >
          {/* Only drawn while no choice is made: a column that counts in no component. */}
          {choice === "" ? (
            <option value="" disabled>
              {t("gbook.settings.none")}
            </option>
          ) : null}
          {hasComponents ? (
            components.map((component) => (
              <option key={component.id} value={component.id}>
                {component.name}
              </option>
            ))
          ) : (
            <option value={IN}>{t("gbook.settings.in")}</option>
          )}
          <option value={OUT}>{t("gbook.settings.out")}</option>
        </Select>
        {choice === "" ? (
          <p className="flex items-start gap-1.5 text-[13px] text-fg-muted">
            <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
            {t("gbook.noComponent.help")}
          </p>
        ) : null}
      </div>
      <WeightField
        hint={t("gbook.weight.hint")}
        defaultValue={value.weight}
        onChange={(weight) => onChange({ ...value, weight })}
      />
    </>
  );
}

/**
 * A weight, a whole percentage typed as text: the label, the field three
 * digits wide, then its rule at the dialog's full width (under the field, so
 * a sentence beside a narrow input never wraps word by word), read with it.
 * It owns the text and hands back a number, NaN while it is not one.
 */
export function WeightField({
  hint,
  defaultValue,
  onChange,
  autoFocus,
}: {
  hint: string;
  defaultValue: number;
  onChange: (weight: number) => void;
  autoFocus?: boolean;
}) {
  const t = useT();
  const hintId = useId();
  const [text, setText] = useState(String(defaultValue));
  return (
    <div className="space-y-1.5">
      <Field
        label={t("gbook.weight.label")}
        inputMode="numeric"
        value={text}
        aria-describedby={hintId}
        autoFocus={autoFocus}
        onChange={(e) => {
          setText(e.target.value);
          onChange(numberOf(e.target.value));
        }}
        width="w-28"
      />
      <p id={hintId} className="text-[13px] text-fg-muted">
        {hint}
      </p>
    </div>
  );
}
