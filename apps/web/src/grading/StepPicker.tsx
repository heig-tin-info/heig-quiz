import { Check, ChevronDown, GraduationCap, Search } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";

import { fuzzyFilter } from "../fuzzy";
import { useT } from "../i18n";
import { Badge, ComboboxOption, cx, inputClass, inputSize, useCombobox, Z } from "../ui";
import type { GradingOrder } from "./labels";
import { stepStatus, type Step } from "./useGradingTraversal";

const WORDS = {
  question: {
    pick: "grading.steps.pickQuestion",
    filter: "grading.steps.filterQuestion",
    list: "grading.steps.listQuestion",
  },
  student: {
    pick: "grading.steps.pickStudent",
    filter: "grading.steps.filterStudent",
    list: "grading.steps.listStudent",
  },
} as const;

/**
 * The step level of the traversal (#107): "Question 5 of 8" is a button, and
 * it opens the list of every step — each question, or each student — with
 * what it still asks for. A filter field on top, because stepping through
 * thirty students one chevron at a time to reach the one a student asked
 * about is the whole complaint.
 *
 * The chevrons beside it still walk one step at a time; this is the jump.
 * It is the ARIA combobox of `useCombobox` (virtual focus, arrows wrap,
 * Enter picks, Escape closes and gives the focus back to the button), in a
 * panel of its own rather than under a field that is always there: the
 * header has one line to spare, not two.
 */
export function StepPicker({
  order,
  steps,
  index,
  title,
  onJump,
}: {
  order: GradingOrder;
  steps: Step[];
  index: number;
  /** "Question 5 of 8", the button's own text. */
  title: string;
  onJump: (index: number) => void;
}) {
  const t = useT();
  const words = WORDS[order];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const button = useRef<HTMLButtonElement>(null);

  const shown = useMemo(
    () =>
      fuzzyFilter(
        query,
        steps.map((step, at) => ({ step, at })),
        (row) => row.step.label,
      ),
    [steps, query],
  );

  const close = (refocus: boolean) => {
    setOpen(false);
    setQuery("");
    if (refocus) button.current?.focus();
  };

  const combo = useCombobox({
    count: shown.length,
    query,
    onPick: (i) => {
      const row = shown[i];
      if (row) onJump(row.at);
      close(true);
    },
    state: [open, (next) => (next ? setOpen(true) : close(false))],
  });

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
      return;
    }
    combo.inputProps.onKeyDown(e);
  };

  return (
    // Anchored on the button from `sm`; on a phone on the header card (which
    // is `relative`), full width, because a 320 px panel hung from a button
    // 80 px in runs off a 390 px screen.
    <div className="sm:relative">
      <button
        ref={button}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        // While open, a press here must not blur the field first: the blur
        // would close the panel and this click would open it straight again.
        onMouseDown={(e) => {
          if (open) e.preventDefault();
        }}
        onClick={() => (open ? close(true) : setOpen(true))}
        className="-mx-2 inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-base font-bold tabular-nums tracking-tight transition-colors hover:bg-surface-2"
      >
        <span>{title}</span>
        <ChevronDown className="size-4 text-fg-faint" aria-hidden />
      </button>

      {open ? (
        <div
          // A press anywhere in the panel keeps the focus in the field: the
          // blur is what closes it, and a click on the padding is not a leave.
          onMouseDown={(e) => {
            if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
          }}
          className={cx(
            "menu-panel absolute inset-x-3 top-14 rounded-menu sm:inset-x-auto sm:left-0 sm:top-full sm:mt-2 sm:w-80 border border-line bg-surface p-2 shadow-popover",
            Z.popover,
          )}
        >
          <label className="relative block">
            <span className="sr-only">{t(words.pick)}</span>
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-faint"
              aria-hidden
            />
            <input
              id={combo.inputId}
              autoFocus
              value={query}
              {...combo.inputProps}
              onKeyDown={onKeyDown}
              // Closed at once rather than after the combobox's grace delay:
              // the rows keep the focus in the field on a press, so a blur
              // is always a real leave, and a delayed close could land on a
              // panel opened again in the meantime.
              onBlur={() => {
                if (open) close(false);
              }}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={t(words.filter)}
              className={cx(inputClass, inputSize.md, "w-full pl-8")}
            />
          </label>
          <div
            {...combo.listProps}
            aria-label={t(words.list)}
            className="mt-2 max-h-80 overflow-y-auto"
          >
            {shown.length === 0 ? (
              <p className="px-2.5 py-2 text-[13px] text-fg-faint">
                {t("grading.steps.none", { q: query.trim() })}
              </p>
            ) : (
              shown.map(({ step, at }, i) => (
                <ComboboxOption
                  key={step.key}
                  combobox={combo}
                  index={i}
                  className="flex items-center gap-2"
                >
                  <span className="flex w-4 shrink-0 justify-center">
                    {at === index ? (
                      <>
                        <Check className="size-3.5" aria-hidden />
                        <span className="sr-only">{t("grading.steps.current")}</span>
                      </>
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{step.label}</span>
                  {step.staff ? (
                    <>
                      <GraduationCap className="size-3.5 shrink-0 text-fg-faint" aria-hidden />
                      <span className="sr-only">{t("roster.status.staff")}</span>
                    </>
                  ) : null}
                  <StepBadge step={step} />
                </ComboboxOption>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** What a step still asks for; nothing while its summary has not landed. */
function StepBadge({ step }: { step: Step }) {
  const t = useT();
  if (!step.state) return null;
  const status = stepStatus(step.state);
  if (status === "toValidate") {
    return <Badge tone="amber">{t("grading.steps.toValidate", { n: step.state.proposed })}</Badge>;
  }
  if (status === "done") return <Badge tone="green">{t("grading.steps.done")}</Badge>;
  const ungraded = step.state.total - step.state.validated - step.state.proposed;
  return <Badge tone="zinc">{t("grading.steps.ungraded", { n: ungraded })}</Badge>;
}
