import { Eye } from "lucide-react";
import { useId } from "react";

import type { GradingConfidence, GradingSource } from "@quiz/contracts";

import { useT, type Dict } from "../i18n";
import { Button, Checkbox, Popover, Segmented, Select, Switch } from "../ui";
import type { GradingOrder } from "./labels";
import { ANSWER_PARTS, PART_LABELS, type ShownParts } from "./parts";
import { ANY, type Any, type StateFilter } from "./useGradingTraversal";

/**
 * What each choice of the two selects means, one sentence each (issue #98).
 * The line under the row says it for the CURRENT choice — visible, and
 * linked to its select by `aria-describedby`, so a screen reader hears it
 * too; nothing here lives only in a hover bubble.
 */
const SOURCE_HELP: Record<GradingSource | Any, keyof Dict> = {
  [ANY]: "grading.filter.source.help.any",
  auto: "grading.filter.source.help.auto",
  llm: "grading.filter.source.help.llm",
  manual: "grading.filter.source.help.manual",
};

const CONFIDENCE_HELP: Record<GradingConfidence | Any, keyof Dict> = {
  [ANY]: "grading.filter.confidence.help.any",
  low: "grading.filter.confidence.help.low",
  medium: "grading.filter.confidence.help.medium",
  high: "grading.filter.confidence.help.high",
};

/**
 * The filter row of the grading panel: the order of the traversal, the state
 * filter, who graded and with what confidence, the parts of an answer shown
 * (#109), and the names switch — with
 * the note that says the list is anonymous while it is. Every control is the
 * panel's state; this only draws it.
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
  parts,
  onParts,
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
  parts: ShownParts;
  onParts: (parts: ShownParts) => void;
}) {
  const t = useT();
  const sourceId = useId();
  const confidenceId = useId();
  const sourceHelpId = useId();
  const confidenceHelpId = useId();
  return (
    <div className="space-y-2">
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
        <span className="flex items-center gap-2">
          <label htmlFor={sourceId} className="text-[13px] font-medium text-fg-muted">
            {t("grading.filter.source")}
          </label>
          <Select
            id={sourceId}
            size="sm"
            width="w-48"
            value={source}
            aria-describedby={sourceHelpId}
            onChange={(e) => onSource(e.target.value as GradingSource | Any)}
          >
            <option value={ANY}>{t("grading.filter.any")}</option>
            <option value="auto">{t("grading.filter.source.auto")}</option>
            <option value="llm">{t("grading.filter.source.llm")}</option>
            <option value="manual">{t("grading.filter.source.manual")}</option>
          </Select>
        </span>
        <span className="flex items-center gap-2">
          <label htmlFor={confidenceId} className="text-[13px] font-medium text-fg-muted">
            {t("grading.filter.confidence")}
          </label>
          <Select
            id={confidenceId}
            size="sm"
            width="w-28"
            value={confidence}
            aria-describedby={confidenceHelpId}
            onChange={(e) => onConfidence(e.target.value as GradingConfidence | Any)}
          >
            <option value={ANY}>{t("grading.filter.any")}</option>
            <option value="low">{t("grading.filter.confidence.low")}</option>
            <option value="medium">{t("grading.filter.confidence.medium")}</option>
            <option value="high">{t("grading.filter.confidence.high")}</option>
          </Select>
        </span>
        <PartsMenu parts={parts} onParts={onParts} />
        <span className="flex-1" />
        <span className="flex items-center gap-2 text-[13px] font-medium text-fg-muted">
          <Switch checked={showNames} onChange={onShowNames} label={t("grading.showNames")} />
          {t("grading.showNames")}
        </span>
      </div>
      <p className="text-xs text-fg-muted">
        <span id={sourceHelpId}>{t(SOURCE_HELP[source])}</span>{" "}
        <span id={confidenceHelpId}>{t(CONFIDENCE_HELP[confidence])}</span>
      </p>
      {!showNames ? <p className="text-xs text-fg-faint">{t("grading.anonymousNote")}</p> : null}
    </div>
  );
}

/**
 * "Show": which parts of an open answer are drawn (#109), as a checkbox list
 * in a popover — a menu would close on the first tick, and a teacher
 * decluttering the screen usually unticks three things in a row. The
 * student's answer heads the list, ticked and disabled: it is what is
 * graded, and seeing it there says the rest can go without losing it.
 */
function PartsMenu({
  parts,
  onParts,
}: {
  parts: ShownParts;
  onParts: (parts: ShownParts) => void;
}) {
  const t = useT();
  const shown = ANSWER_PARTS.filter((p) => parts[p]).length;
  const all = shown === ANSWER_PARTS.length;
  return (
    <Popover
      label={t("grading.parts.label")}
      align="start"
      trigger={
        <Button variant="secondary" size="sm">
          <Eye />
          {all
            ? t("grading.parts.open")
            : t("grading.parts.openSome", { n: shown, total: ANSWER_PARTS.length })}
        </Button>
      }
    >
      <fieldset>
        <legend className="mb-2.5 text-[13px] font-semibold text-fg">
          {t("grading.parts.label")}
        </legend>
        <ul className="space-y-2.5">
          <li>
            <Checkbox label={t("grading.parts.answer")} checked disabled readOnly />
          </li>
          {ANSWER_PARTS.map((part) => (
            <li key={part}>
              <Checkbox
                label={t(PART_LABELS[part])}
                checked={parts[part]}
                onChange={(e) => onParts({ ...parts, [part]: e.target.checked })}
              />
            </li>
          ))}
        </ul>
      </fieldset>
    </Popover>
  );
}
