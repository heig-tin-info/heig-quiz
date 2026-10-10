import type { PoolQuestionStats } from "@quiz/contracts";
import { QUESTION_STATS_MIN_N } from "@quiz/domain";

import { useT } from "../i18n";
import { Spinner, Switch } from "../ui";
import type { QuestionFilters } from "./filters";
import { TextInput } from "@quiz/ui";

/**
 * The pool's statistics query as the filter sheet reads it: still loading,
 * failed, or answered. The TanStack result fits it as it is.
 */
export interface StatsOffer {
  isPending: boolean;
  isError: boolean;
  data?: PoolQuestionStats | undefined;
}

/** One bound: a bare number field, its name in `aria-label` (the row's label is shared by two). */
function Bound({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: number | null;
  min?: number;
  onChange: (next: number | null) => void;
}) {
  return (
    <TextInput
      type="number"
      inputMode="numeric"
      step={1}
      min={min}
      aria-label={label}
       size="sm" className="w-20 text-right tabular-nums"
      value={value ?? ""}
      onChange={(e) => {
        const next = e.target.value === "" ? null : Math.round(Number(e.target.value));
        onChange(next === null || Number.isFinite(next) ? next : null);
      }}
    />
  );
}

/** A labelled range: "Success rate [ 20 ] – [ 60 ] %". */
function Range({
  label,
  unit,
  min,
  max,
  floor,
  onChange,
}: {
  label: string;
  unit: string;
  min: number | null;
  max: number | null;
  /** The smallest value that means something; none for a signed rate. */
  floor?: number;
  onChange: (min: number | null, max: number | null) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="min-w-0 flex-1 text-sm">{label}</span>
      <div className="flex items-center gap-1.5">
        <Bound
          label={t("pool.filter.min", { label })}
          value={min}
          min={floor}
          onChange={(next) => onChange(next, max)}
        />
        <span aria-hidden className="text-fg-faint">
          –
        </span>
        <Bound
          label={t("pool.filter.max", { label })}
          value={max}
          min={floor}
          onChange={(next) => onChange(min, next)}
        />
        <span className="w-4 text-sm text-fg-muted">{unit}</span>
      </div>
    </div>
  );
}

/**
 * The statistics block of the pool's filter sheet (F-STAT-03): a success-rate
 * range, a median-time range when some question has a time, and whether the
 * questions WITHOUT the figure stay in the list (they leave it by default).
 *
 * Two plain number pairs, not sliders: a teacher who asks for "under 40 %"
 * types 40, and a slider over a signed rate has no natural left end. The
 * rate is in whole percent as the panel shows it; the time in seconds, the
 * unit the panel's shortest figures are read in.
 */
export function StatsFilterFields({
  offer,
  filters,
  onChange,
}: {
  offer: StatsOffer;
  filters: QuestionFilters;
  onChange: (patch: Partial<QuestionFilters>) => void;
}) {
  const t = useT();
  const items = offer.data?.items ?? [];
  // A question may have its rate long before its time (ADR-039): the time
  // range shows once one question has a time.
  const withTime = items.some((s) => s.time !== null);
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-[13px] font-medium">{t("pool.filter.stats")}</legend>
      {offer.isPending ? (
        <Spinner className="py-2" />
      ) : offer.isError ? (
        <p className="text-sm text-fg-muted">{t("pool.filter.statsError")}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-fg-muted">
          {t("pool.filter.statsNone", { n: QUESTION_STATS_MIN_N })}
        </p>
      ) : (
        <>
          <Range
            label={t("pool.filter.rate")}
            unit="%"
            min={filters.rateMin}
            max={filters.rateMax}
            onChange={(rateMin, rateMax) => onChange({ rateMin, rateMax })}
          />
          {withTime ? (
            <Range
              label={t("pool.filter.medianTime")}
              unit={t("pool.filter.unit.seconds")}
              min={filters.timeMin}
              max={filters.timeMax}
              floor={0}
              onChange={(timeMin, timeMax) => onChange({ timeMin, timeMax })}
            />
          ) : null}
          <p className="text-xs leading-relaxed text-fg-faint">
            {t("pool.filter.statsHint", { n: QUESTION_STATS_MIN_N })}
          </p>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm">{t("pool.filter.withoutStats")}</span>
            <Switch
              label={t("pool.filter.withoutStats")}
              checked={filters.withoutStats}
              onChange={(withoutStats) => onChange({ withoutStats })}
            />
          </div>
        </>
      )}
    </fieldset>
  );
}
