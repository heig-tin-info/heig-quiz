import { BarChart3, CheckCheck, ChevronRight } from "lucide-react";
import { useId, type ReactNode } from "react";

import type { GradingConfidence, GradingSource } from "@quiz/contracts";

import { useT, type Dict } from "../i18n";
import { Button, Segmented, Switch, Tip } from "../ui";
import { ANY, type Any, type PrimaryAction, type StateFilter } from "./rows";
import type { GradingView } from "./view";

/** What each choice of the two filters means, one sentence each (issue #98): their tooltips. */
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

const SOURCE_WORDS: Record<GradingSource | Any, keyof Dict> = {
  [ANY]: "grading.filter.any",
  auto: "grading.filter.source.auto",
  llm: "grading.filter.source.llm",
  manual: "grading.filter.source.manual",
};

const CONFIDENCE_WORDS: Record<GradingConfidence | Any, keyof Dict> = {
  [ANY]: "grading.filter.any",
  high: "grading.filter.confidence.high",
  medium: "grading.filter.confidence.medium",
  low: "grading.filter.confidence.low",
};

/**
 * The row between the question and its answers (ADR-044): which answers
 * the table shows, whether names are shown, and the ONE primary action of
 * the screen at its end. The confidence control only exists while "AI" is
 * picked: only a model's proposals carry one.
 */
export function GradingToolbar({
  view,
  onView,
  toValidate,
  anonymise,
  onAnonymise,
  primary,
}: {
  view: GradingView;
  onView: (patch: Partial<GradingView>) => void;
  /** The answers of this question not validated yet (the steps' count); null before it lands. */
  toValidate: number | null;
  anonymise: boolean;
  onAnonymise: (on: boolean) => void;
  primary: ReactNode;
}) {
  const t = useT();
  const sourceId = useId();
  const confidenceId = useId();
  const caption = "text-[12.5px] text-fg-faint";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
      <Segmented<StateFilter>
        name="grading-state"
        label={t("grading.filter.state")}
        size="sm"
        value={view.stateFilter}
        options={[
          { value: "all", label: t("grading.filter.all") },
          {
            value: "todo",
            label:
              toValidate !== null && toValidate > 0
                ? t("grading.filter.todo", { n: toValidate })
                : t("grading.filter.proposed"),
          },
        ]}
        onChange={(stateFilter) => onView({ stateFilter })}
      />
      <span id={sourceId} className={caption}>
        {t("grading.filter.source")}
      </span>
      <Segmented<GradingSource | Any>
        name="grading-source"
        labelledBy={sourceId}
        size="sm"
        value={view.source}
        options={([ANY, "auto", "llm", "manual"] as const).map((value) => ({
          value,
          label: <span title={t(SOURCE_HELP[value])}>{t(SOURCE_WORDS[value])}</span>,
        }))}
        onChange={(source) => onView({ source })}
      />
      {view.source === "llm" ? (
        <>
          <span id={confidenceId} className={caption}>
            {t("grading.filter.confidence")}
          </span>
          <Segmented<GradingConfidence | Any>
            name="grading-confidence"
            labelledBy={confidenceId}
            size="sm"
            value={view.confidence}
            options={([ANY, "high", "medium", "low"] as const).map((value) => ({
              value,
              label: <span title={t(CONFIDENCE_HELP[value])}>{t(CONFIDENCE_WORDS[value])}</span>,
            }))}
            onChange={(confidence) => onView({ confidence })}
          />
        </>
      ) : null}
      <span className="flex-1" />
      <label className="flex items-center gap-2 text-[13px] font-medium text-fg-muted">
        <Switch checked={anonymise} onChange={onAnonymise} label={t("grading.anonymise")} />
        <span aria-hidden>{t("grading.anonymise")}</span>
      </label>
      {primary}
    </div>
  );
}

/**
 * The screen's one accent button, in the state `primaryAction` decided:
 * validate what is shown, then the next question, then the results. While
 * what is left cannot go in a batch it stays in place, disabled, and its
 * tooltip says why — a button that vanishes would move the row under the
 * teacher's pointer.
 */
export function PrimaryButton({
  action,
  busy,
  onValidate,
  onNext,
  onResults,
}: {
  action: PrimaryAction;
  busy: boolean;
  onValidate: (count: number) => void;
  onNext: () => void;
  onResults: () => void;
}) {
  const t = useT();
  switch (action.kind) {
    case "validate":
      return (
        <Button loading={busy} onClick={() => onValidate(action.count)}>
          <CheckCheck /> {t("grading.batch.action", { n: action.count })}
        </Button>
      );
    case "blocked":
      return (
        <Tip
          label={t(
            action.reason === "hidden" ? "grading.blocked.hidden" : "grading.blocked.byHand",
          )}
        >
          <span tabIndex={0} className="rounded-full">
            <Button disabled>
              <CheckCheck /> {t("grading.validate")}
            </Button>
          </span>
        </Tip>
      );
    case "next":
      return (
        <Button onClick={onNext}>
          {t("grading.nextItem")} <ChevronRight />
        </Button>
      );
    case "results":
      return (
        <Button onClick={onResults}>
          <BarChart3 /> {t("grading.openResults")}
        </Button>
      );
  }
}
