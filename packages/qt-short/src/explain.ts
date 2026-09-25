/**
 * The one-line sentence under an accepted answer of kind `number`, `date` or
 * `time` that says, from the values being typed, what the matcher accepts
 * (issue #97): "Accepts 9.81 ± 0.05 m/s². Unit required."
 *
 * Pure: no React, no locale lookup. The sentences are templates of the
 * editor's strings (`{var}`, filled by `fmt`), so the host translates them key
 * by key like every other entry. The arithmetic mirrors `@quiz/domain/short`
 * (`withinTolerance`, `matchDate`, `matchTime`) — a relative tolerance is a
 * FRACTION there (0.01 is 1 %), and a time window does not wrap past
 * midnight, so neither does the sentence.
 */
import { fmt, plural } from "@quiz/core/client";

import type { ShortMatcher } from "./schema.js";
import type { ShortEditorStringKey } from "./strings.js";

type Strings = Readonly<Record<ShortEditorStringKey, string>>;

/**
 * A number as a teacher typed it: `0.1 + 0.2` shows as 0.3, not as
 * 0.30000000000000004. Twelve significant digits is far more than a tolerance
 * ever carries and far fewer than the float noise.
 */
export function formatNumber(n: number): string {
  return String(Number(n.toPrecision(12)));
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HH_MM = /^(\d{2}):(\d{2})$/;

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * The sentence, or `null` when the matcher has no tolerance to explain
 * (`exact`, `regex`, `llm`) or its value is not a value yet (an empty date).
 */
export function explainMatcher(matcher: ShortMatcher, s: Strings): string | null {
  switch (matcher.kind) {
    case "number": {
      if (!Number.isFinite(matcher.value)) return null;
      const tolerance = Number.isFinite(matcher.tolerance) ? Math.max(0, matcher.tolerance) : 0;
      const unitText = matcher.unit?.trim() ?? "";
      const unit = unitText === "" ? "" : ` ${unitText}`;
      const value = formatNumber(matcher.value);
      let sentence: string;
      if (tolerance === 0) {
        sentence = fmt(s.explainNumberExact, { value, unit });
      } else if (matcher.toleranceMode === "rel") {
        const spread = Math.abs(matcher.value) * tolerance;
        sentence = fmt(s.explainNumberRel, {
          value,
          unit,
          tolerance: formatNumber(tolerance * 100),
          min: formatNumber(matcher.value - spread),
          max: formatNumber(matcher.value + spread),
        });
      } else {
        sentence = fmt(s.explainNumberAbs, { value, unit, tolerance: formatNumber(tolerance) });
      }
      if (unitText === "") return sentence;
      const note = fmt(matcher.unitRequired ? s.explainUnitRequired : s.explainUnitOptional, {
        unit: unitText,
      });
      return `${sentence} ${note}`;
    }
    case "date": {
      if (!ISO_DATE.test(matcher.value) || Number.isNaN(Date.parse(`${matcher.value}T00:00:00Z`))) {
        return null;
      }
      const n = Math.max(0, Math.trunc(matcher.toleranceDays || 0));
      if (n === 0) return fmt(s.explainDateExact, { value: matcher.value });
      return plural(s, "explainDateRange", n, {
        n,
        value: matcher.value,
        from: shiftDate(matcher.value, -n),
        to: shiftDate(matcher.value, n),
      });
    }
    case "time": {
      const hm = HH_MM.exec(matcher.value);
      if (hm === null) return null;
      const at = Number(hm[1]) * 60 + Number(hm[2]);
      if (at >= 24 * 60) return null;
      const n = Math.max(0, Math.trunc(matcher.toleranceMinutes || 0));
      if (n === 0) return fmt(s.explainTimeExact, { value: matcher.value });
      return plural(s, "explainTimeRange", n, {
        n,
        value: matcher.value,
        from: formatMinutes(Math.max(0, at - n)),
        to: formatMinutes(Math.min(24 * 60 - 1, at + n)),
      });
    }
    default:
      return null;
  }
}
