/*
 * The editor of ONE `{{…}}` blank, as a card anchored under its chip.
 *
 * A hole is an atom: there is nothing to type into the chip, and the raw body
 * that used to be typed into a one-line bar (`free|libre`, `=a|b|c`,
 * `#3.14:0.01`, a weighted regex) is a grammar, not a value. A teacher testing the
 * cloze type read the bar as a password field. So the shape is asked for
 * instead: what kind of blank, which answers, which of them are right.
 *
 * It never writes the body by hand. `parseBlankBody` fills the fields and
 * `formatBlank` writes them back — both from `@quiz/domain`, the very
 * functions the grader reads a hole with — so a body this card saves cannot
 * mean something else to the grader than what it showed. The escaping of `|`,
 * `}`, `*` and the head characters lives there too, once.
 */
import { formatBlank, parseBlankBody, type ClozeBlank } from "@quiz/domain";
import { Plus, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "../i18n";
import { Button, cx, IconButton, inputClass, useLayer, Z } from "../ui";

export type BlankMode = "any" | "select" | "number" | "regex";

/** One row of the answer list, in both list modes. */
interface Answer {
  text: string;
  correct: boolean;
}

export interface BlankPopoverProps {
  /** Viewport rectangle of the chip this card belongs to. */
  anchor: { top: number; bottom: number; left: number };
  /** The body as stored, or "" for a hole that was just typed. */
  body: string;
  onApply: (body: string) => void;
  onCancel: () => void;
}

/** What the fields hold, whichever mode is showing. */
interface Draft {
  mode: BlankMode;
  answers: Answer[];
  value: string;
  tolerance: string;
  relative: boolean;
  pattern: string;
  flags: string;
  weight: string;
}

const EMPTY: Draft = {
  mode: "any",
  answers: [{ text: "", correct: true }],
  value: "",
  tolerance: "",
  relative: false,
  pattern: "",
  flags: "",
  weight: "1",
};

/** The card's fields, read out of an existing body through the domain parser. */
export function draftFromBody(body: string): Draft {
  const blank = parseBlankBody(body);
  if (typeof blank === "string") return EMPTY;
  const weight = String(blank.weight);
  switch (blank.kind) {
    case "text":
      return { ...EMPTY, weight, mode: "any", answers: blank.answers.map((text) => ({ text, correct: true })) };
    case "select":
      return {
        ...EMPTY,
        weight,
        mode: "select",
        answers: blank.options.map((text, i) => ({ text, correct: blank.correct.includes(i) })),
      };
    case "number":
      return {
        ...EMPTY,
        weight,
        mode: "number",
        value: String(blank.value),
        tolerance: blank.tolerance === 0 ? "" : String(round6(blank.mode === "rel" ? blank.tolerance * 100 : blank.tolerance)),
        relative: blank.mode === "rel",
      };
    case "regex":
      return { ...EMPTY, weight, mode: "regex", pattern: blank.pattern, flags: blank.flags };
  }
}

/** 0.05 × 100 is 5.000000000000001; the card must show `5`. */
function round6(n: number): number {
  return Number(n.toFixed(6));
}

/**
 * The body this draft stands for, or `null` when it is not a blank yet (no
 * answer, no value, no pattern, nothing ticked).
 *
 * The blank is BUILT and then formatted, never concatenated: the one path from
 * the card to the text goes through `formatBlank`.
 */
export function bodyFromDraft(draft: Draft): string | null {
  const weight = Number(draft.weight.replace(",", "."));
  const w = Number.isFinite(weight) && weight > 0 ? weight : 1;
  const blank = blankFromDraft(draft, w);
  if (blank === null) return null;
  const body = formatBlank(blank);
  /*
   * And READ BACK. `formatBlank` escapes what it can, but a regex holding `}}`
   * is not expressible as a hole at all — escaping inside a pattern would
   * change the expression, not protect it — so the card refuses that body
   * rather than writing one the grader reads differently.
   */
  const reparsed = parseBlankBody(body, blank.index);
  return JSON.stringify(reparsed) === JSON.stringify(blank) ? body : null;
}

function blankFromDraft(draft: Draft, weight: number): ClozeBlank | null {
  const index = 0;
  if (draft.mode === "number") {
    const value = Number(draft.value.replace(",", "."));
    if (draft.value.trim() === "" || !Number.isFinite(value)) return null;
    const raw = Number(draft.tolerance.replace(",", "."));
    const tolerance = draft.tolerance.trim() === "" || !Number.isFinite(raw) || raw < 0 ? 0 : raw;
    return {
      index,
      weight,
      kind: "number",
      value,
      tolerance: draft.relative && tolerance > 0 ? tolerance / 100 : tolerance,
      mode: draft.relative && tolerance > 0 ? "rel" : "abs",
    };
  }
  if (draft.mode === "regex") {
    if (draft.pattern === "") return null;
    return { index, weight, kind: "regex", pattern: draft.pattern, flags: draft.flags };
  }
  const answers = draft.answers.map((a) => ({ ...a, text: a.text.trim() })).filter((a) => a.text !== "");
  if (answers.length === 0) return null;
  if (draft.mode === "select") {
    const correct = answers.flatMap((a, i) => (a.correct ? [i] : []));
    if (correct.length === 0) return null;
    return { index, weight, kind: "select", options: answers.map((a) => a.text), correct };
  }
  return { index, weight, kind: "text", answers: answers.map((a) => a.text) };
}

export function BlankPopover({ anchor, body, onApply, onCancel }: BlankPopoverProps) {
  const t = useT();
  const [draft, setDraft] = useState<Draft>(() => draftFromBody(body));
  const panel = useRef<HTMLDivElement>(null);
  const group = useId();
  const next = bodyFromDraft(draft);

  useLayer(panel, onCancel, { trap: false });

  /*
   * A click OUTSIDE applies what is there, when there is something: the card
   * is not a dialog the teacher owes an answer to, it is the chip opened up,
   * and clicking back into the sentence must leave the blank as it reads.
   * Nothing valid yet and the click is a cancel — which, on a chip `{{` had
   * just made, removes it (`cancelHole` in RichText).
   */
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (panel.current?.contains(e.target as Node)) return;
      if (next === null) onCancel();
      else onApply(next);
    };
    // The mousedown that OPENED the card must not close it again.
    const id = window.setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
    };
  }, [next, onApply, onCancel]);

  const patch = (over: Partial<Draft>) => setDraft((d) => ({ ...d, ...over }));
  const setAnswer = (i: number, over: Partial<Answer>) =>
    patch({ answers: draft.answers.map((a, j) => (i === j ? { ...a, ...over } : a)) });
  const addAnswer = () => patch({ answers: [...draft.answers, { text: "", correct: false }] });
  const list = draft.mode === "any" || draft.mode === "select";

  /*
   * Under the chip, clamped to the viewport. `position: fixed` from the
   * chip's own rectangle, like `Menu`: the field can sit inside a table cell
   * with `overflow: hidden`, which would clip a card in the flow.
   */
  const width = 320;
  const left = Math.min(Math.max(8, anchor.left), Math.max(8, window.innerWidth - width - 8));
  const below = window.innerHeight - anchor.bottom > 260;

  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={t("md.blank.title")}
      tabIndex={-1}
      className={cx(
        "fixed flex w-80 max-w-[calc(100vw-1rem)] flex-col gap-2.5 rounded-menu border border-line bg-surface p-3 shadow-overlay focus:outline-none",
        Z.popover,
      )}
      style={below ? { top: anchor.bottom + 6, left } : { bottom: window.innerHeight - anchor.top + 6, left }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div
        role="radiogroup"
        aria-label={t("md.blank.mode")}
        className="inline-flex gap-0.5 self-start rounded-full bg-surface-3 p-0.75"
      >
        {(["any", "select", "number", "regex"] as const).map((mode) => (
          <label
            key={mode}
            className={cx(
              "inline-flex h-6 items-center justify-center rounded-full px-2.5 text-xs font-medium transition-colors has-focus-visible:ring-2 has-focus-visible:ring-accent/50",
              draft.mode === mode
                ? "bg-surface text-fg ring-1 ring-line-strong/70"
                : "cursor-pointer text-fg-muted hover:text-fg",
            )}
          >
            <input
              type="radio"
              name={`${group}-mode`}
              className="sr-only"
              checked={draft.mode === mode}
              onChange={() => patch({ mode })}
            />
            {t(`md.blank.mode.${mode}` as "md.blank.mode.any")}
          </label>
        ))}
      </div>

      {list ? (
        <ul className="flex flex-col gap-1">
          {draft.answers.map((answer, i) => (
            <li key={i} className="flex items-center gap-1.5">
              {draft.mode === "select" ? (
                <input
                  type="checkbox"
                  className="size-4 shrink-0 accent-accent"
                  aria-label={t("md.blank.correct")}
                  checked={answer.correct}
                  onChange={(e) => setAnswer(i, { correct: e.target.checked })}
                />
              ) : null}
              <input
                autoFocus={i === 0}
                value={answer.text}
                aria-label={t("md.blank.answer", { n: i + 1 })}
                className={cx(inputClass, "h-7 min-w-0 grow py-0 text-[13px]")}
                onChange={(e) => setAnswer(i, { text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    // Enter in the LAST row adds one, which is how a list of
                    // alternatives is written without reaching for the mouse.
                    if (i === draft.answers.length - 1) addAnswer();
                    else if (next !== null) onApply(next);
                  }
                }}
              />
              <IconButton
                size="sm"
                label={t("md.blank.remove")}
                disabled={draft.answers.length === 1}
                onClick={() => patch({ answers: draft.answers.filter((_, j) => j !== i) })}
              >
                <X />
              </IconButton>
            </li>
          ))}
          <li>
            <Button size="sm" variant="ghost" onClick={addAnswer}>
              <Plus />
              {t("md.blank.add")}
            </Button>
          </li>
        </ul>
      ) : null}

      {draft.mode === "number" ? (
        <div className="flex flex-wrap items-end gap-2">
          <NumberField
            label={t("md.blank.value")}
            value={draft.value}
            onChange={(value) => patch({ value })}
            autoFocus
          />
          <NumberField
            label={t("md.blank.tolerance")}
            value={draft.tolerance}
            onChange={(tolerance) => patch({ tolerance })}
          />
          <div
            role="radiogroup"
            aria-label={t("md.blank.toleranceMode")}
            className="inline-flex h-7 gap-0.5 rounded-full bg-surface-3 p-0.75"
          >
            {[
              { rel: false, label: t("md.blank.absolute") },
              { rel: true, label: "%" },
            ].map((option) => (
              <label
                key={String(option.rel)}
                className={cx(
                  "inline-flex items-center justify-center rounded-full px-2.5 text-xs font-medium transition-colors has-focus-visible:ring-2 has-focus-visible:ring-accent/50",
                  draft.relative === option.rel
                    ? "bg-surface text-fg ring-1 ring-line-strong/70"
                    : "cursor-pointer text-fg-muted hover:text-fg",
                )}
              >
                <input
                  type="radio"
                  name={`${group}-tol`}
                  className="sr-only"
                  checked={draft.relative === option.rel}
                  onChange={() => patch({ relative: option.rel })}
                />
                {option.label}
              </label>
            ))}
          </div>
        </div>
      ) : null}

      {draft.mode === "regex" ? (
        <div className="flex items-end gap-2">
          <label className="flex min-w-0 grow flex-col gap-1 text-xs font-medium text-fg-muted">
            {t("md.blank.pattern")}
            <input
              autoFocus
              value={draft.pattern}
              className={cx(inputClass, "h-7 w-full py-0 font-mono text-[13px]")}
              onChange={(e) => patch({ pattern: e.target.value })}
            />
          </label>
          <label className="flex w-16 shrink-0 flex-col gap-1 text-xs font-medium text-fg-muted">
            {t("md.blank.flags")}
            <input
              value={draft.flags}
              className={cx(inputClass, "h-7 w-full py-0 font-mono text-[13px]")}
              onChange={(e) => patch({ flags: e.target.value })}
            />
          </label>
        </div>
      ) : null}

      <div className="flex items-center gap-2 border-t border-line pt-2">
        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
          {t("md.blank.weight")}
          <input
            inputMode="decimal"
            value={draft.weight}
            className={cx(inputClass, "h-7 w-14 py-0 text-center text-[13px] tabular-nums")}
            onChange={(e) => patch({ weight: e.target.value })}
          />
        </label>
        <span className="grow" />
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button size="sm" variant="secondary" disabled={next === null} onClick={() => next !== null && onApply(next)}>
          {t("common.save")}
        </Button>
      </div>
    </div>,
    document.body,
  );
}

function NumberField({
  label,
  value,
  onChange,
  autoFocus = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <label className="flex w-24 flex-col gap-1 text-xs font-medium text-fg-muted">
      {label}
      <input
        autoFocus={autoFocus}
        inputMode="decimal"
        value={value}
        className={cx(inputClass, "h-7 w-full py-0 text-[13px] tabular-nums")}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
