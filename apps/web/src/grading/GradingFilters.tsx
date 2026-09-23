import type { GradingConfidence, GradingSource } from "@quiz/contracts";

import { useT } from "../i18n";
import { Segmented, Select, Switch } from "../ui";
import type { GradingOrder } from "./labels";
import { ANY, type Any, type StateFilter } from "./useGradingTraversal";

/**
 * The filter row of the grading panel: the order of the traversal, the state
 * filter, source and confidence, and the names switch — with the note that
 * says the list is anonymous while it is. Every control is the panel's state;
 * this only draws it.
 */
export function GradingFilters({
  order,
  onOrder,
  stateFilter,
  onStateFilter,
  source,
  onSource,
  confidence,
  onConfidence,
  showNames,
  onShowNames,
}: {
  order: GradingOrder;
  onOrder: (order: GradingOrder) => void;
  stateFilter: StateFilter;
  onStateFilter: (filter: StateFilter) => void;
  source: GradingSource | Any;
  onSource: (source: GradingSource | Any) => void;
  confidence: GradingConfidence | Any;
  onConfidence: (confidence: GradingConfidence | Any) => void;
  showNames: boolean;
  onShowNames: (show: boolean) => void;
}) {
  const t = useT();
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <Segmented
          name="grading-order"
          value={order}
          options={[
            { value: "question", label: t("grading.order.byQuestion") },
            { value: "student", label: t("grading.order.byStudent") },
          ]}
          onChange={onOrder}
        />
        <Segmented
          name="grading-state"
          value={stateFilter}
          options={[
            { value: "all", label: t("grading.filter.all") },
            { value: "proposed", label: t("grading.filter.proposed") },
            { value: "validated", label: t("grading.filter.validated") },
          ]}
          onChange={(v) => onStateFilter(v as StateFilter)}
        />
        <Select
          aria-label={t("grading.filter.source")}
          size="sm"
          width="w-36"
          value={source}
          onChange={(e) => onSource(e.target.value as GradingSource | Any)}
        >
          <option value={ANY}>{t("grading.filter.source")}</option>
          <option value="auto">{t("grading.source.auto")}</option>
          <option value="llm">{t("grading.source.llm")}</option>
          <option value="manual">{t("grading.source.manual")}</option>
        </Select>
        <Select
          aria-label={t("grading.filter.confidence")}
          size="sm"
          width="w-40"
          value={confidence}
          onChange={(e) => onConfidence(e.target.value as GradingConfidence | Any)}
        >
          <option value={ANY}>{t("grading.filter.confidence")}</option>
          <option value="low">{t("grading.confidence.low")}</option>
          <option value="medium">{t("grading.confidence.medium")}</option>
          <option value="high">{t("grading.confidence.high")}</option>
        </Select>
        <span className="flex-1" />
        <span className="flex items-center gap-2 text-[13px] font-medium text-fg-muted">
          <Switch checked={showNames} onChange={onShowNames} label={t("grading.showNames")} />
          {t("grading.showNames")}
        </span>
      </div>
      {!showNames ? (
        <p className="-mt-3 text-xs text-fg-faint">{t("grading.anonymousNote")}</p>
      ) : null}
    </>
  );
}
