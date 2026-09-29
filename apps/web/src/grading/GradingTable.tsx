import { Check, GraduationCap, PencilLine, RefreshCcw } from "lucide-react";
import { useEffect, useRef } from "react";

import type { GradingColumn } from "@quiz/core/client";
import type { GradingEntry } from "@quiz/contracts";
import { formatPoints } from "@quiz/domain";
import { Dash, NoAnswer } from "@quiz/ui";

import { useT } from "../i18n";
import { Badge, Button, cx, IconButton, pressable, TableHead, T, Tip, type Column } from "../ui";
import type { SortColumn } from "./columns";
import { confidenceLabelShort, whoOf } from "./labels";
import { entryKey, EXPECTED, isMissing, rowAction, type Sort } from "./rows";
import { ExpectedGlyph, VerdictGlyph } from "./VerdictGlyph";

/**
 * The fill of a cell, set on every `<td>` rather than on the row: the first
 * columns are sticky, and a sticky cell with no fill of its own lets the
 * columns scrolling under it show through.
 */
const CELL = "border-t border-line bg-surface group-hover:bg-surface-2";
const SELECTED = "bg-surface-2";
/**
 * The expected row's `info-soft` is translucent in dark mode: it is laid as
 * a flat gradient over the opaque surface, so the sticky cells stay opaque.
 */
const EXPECTED_CELL =
  "bg-surface bg-linear-to-r from-info-soft to-info-soft border-b-2 border-b-line-strong";
/** Shrinks to its content: the answer columns share whatever is left. */
const FIT = "w-px whitespace-nowrap";
/** 48 px: the glyph and its padding, so the Student column knows where to stick. */
const STICKY_VERDICT = "sticky left-0 z-1 w-12 min-w-12";
const STICKY_NAME = "sticky left-12 z-1 whitespace-nowrap";

export interface GradingTableProps {
  /** Accessible name: which question these answers are to. */
  label: string;
  /** The type's answer columns, which draw the cells. */
  columns: GradingColumn[];
  /** Every sortable column in the table's order: the header is drawn from it. */
  sortable: SortColumn[];
  rows: GradingEntry[];
  maxPoints: number;
  /** Names shown: the Student column exists. */
  named: boolean;
  sort: Sort | null;
  onSort: (key: string) => void;
  selected: string | null;
  /** Opens the panel on a row (`EXPECTED` for the key); `adjust` focuses its form. */
  onOpen: (key: string, adjust?: boolean) => void;
  onValidate: (entry: GradingEntry) => void;
  validating: boolean;
  onRegrade: () => void;
  /** Absent when the question cannot be opened from here. */
  onEdit?: () => void;
  /** What an empty table says, under the expected row. */
  empty: string;
}

/**
 * One question's answers as a table (ADR-044): the verdict, the student
 * (only when names are shown), the question type's own answer columns, the
 * points and the row's actions; the key pinned as the first row. A row is
 * one answer: clicking it opens the answer panel.
 *
 * The answer columns share the table's width equally and everything else
 * shrinks to its content, so there is never a wide empty column at the end;
 * past the width of the page the table scrolls sideways under its sticky
 * first columns. A row waiting for a decision wears no fill of its own: its
 * glyph and its visible action say it — Validate for a proposal, Grade for a
 * placeholder to read and grade by hand — and the one accent of the screen
 * stays the batch.
 */
export function GradingTable(props: GradingTableProps) {
  const t = useT();
  const { columns, rows, named, selected } = props;
  const body = useRef<HTMLTableSectionElement>(null);

  // The row the keyboard moved to is brought into view, the page scrolling
  // only as far as it must. The focus follows it when it was on a row: after
  // ↓, Enter must open the row now selected, not the one clicked before.
  useEffect(() => {
    const row = body.current?.querySelector<HTMLElement>(
      `[data-row="${CSS.escape(selected ?? "")}"]`,
    );
    row?.scrollIntoView?.({ block: "nearest" });
    const focused = document.activeElement;
    if (
      row &&
      focused instanceof HTMLElement &&
      focused !== row &&
      focused.matches("tr[data-row]")
    ) {
      row.focus({ preventScroll: true });
    }
  }, [selected]);

  // Where each host column sticks and how wide it is; an answer column is
  // capped by its `<col>` and cuts its label.
  const place: Record<string, string> = {
    verdict: cx("whitespace-nowrap", STICKY_VERDICT, "bg-surface"),
    name: cx(FIT, STICKY_NAME, "bg-surface"),
    points: FIT,
  };
  const head: Column<string>[] = [
    ...props.sortable.map((c) => ({
      key: c.key,
      label:
        c.key === "verdict" ? (
          c.label
        ) : (
          <span title={c.title ?? c.label} className="block truncate">
            {c.label}
          </span>
        ),
      srOnly: c.key === "verdict",
      right: c.align === "right",
      className: place[c.key] ?? cx("max-w-0", c.align === "center" && "text-center"),
    })),
    {
      key: "actions",
      label: t("grading.col.actions"),
      srOnly: true,
      sortable: false,
      className: FIT,
    },
  ];
  const span = head.length;

  return (
    <div className={cx(T.container, "overflow-x-auto")}>
      <table aria-label={props.label} className={cx(T.table, "border-separate border-spacing-0")}>
        {/* Each answer column takes an equal share; the others are `w-px`. */}
        <colgroup>
          <col />
          {named ? <col /> : null}
          {columns.map((c) => (
            <col key={c.key} style={{ width: `${100 / columns.length}%` }} />
          ))}
          <col />
          <col />
        </colgroup>
        <TableHead columns={head} sort={props.sort} onToggle={props.onSort} />
        <tbody ref={body}>
          <ExpectedRow {...props} />
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={span}
                className={cx(T.td, "border-t border-line py-10 text-center text-fg-muted")}
              >
                {props.empty}
              </td>
            </tr>
          ) : (
            rows.map((entry) => <AnswerRow key={entryKey(entry)} entry={entry} {...props} />)
          )}
        </tbody>
      </table>
    </div>
  );
}

function ExpectedRow({
  columns,
  maxPoints,
  named,
  selected,
  onOpen,
  onRegrade,
  onEdit,
}: GradingTableProps) {
  const t = useT();
  const current = selected === EXPECTED;
  return (
    <tr
      data-row={EXPECTED}
      aria-current={current ? "true" : undefined}
      onClick={() => onOpen(EXPECTED)}
      {...pressable(() => onOpen(EXPECTED), "row")}
      className="group cursor-pointer"
    >
      <td
        className={cx(
          T.td,
          EXPECTED_CELL,
          STICKY_VERDICT,
          current && "shadow-[inset_3px_0_0_var(--color-info)]",
        )}
      >
        <ExpectedGlyph />
      </td>
      {named ? (
        <td className={cx(T.td, EXPECTED_CELL, STICKY_NAME, "font-semibold text-info")}>
          {t("grading.expected")}
        </td>
      ) : null}
      {columns.map((c) => (
        <td key={c.key} className={cx(T.td, EXPECTED_CELL, c.align === "center" && "text-center")}>
          {c.expected()}
        </td>
      ))}
      <td className={cx(T.td, EXPECTED_CELL, "text-right font-semibold tabular-nums")}>
        {formatPoints(maxPoints)}
      </td>
      <td className={cx(T.td, EXPECTED_CELL, "whitespace-nowrap text-right")}>
        <span className="inline-flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          {onEdit ? (
            <IconButton label={t("grading.editQuestion")} onClick={onEdit}>
              <PencilLine />
            </IconButton>
          ) : null}
          <IconButton label={t("grading.regrade.open")} onClick={onRegrade}>
            <RefreshCcw />
          </IconButton>
        </span>
      </td>
    </tr>
  );
}

function AnswerRow({
  entry,
  columns,
  named,
  selected,
  onOpen,
  onValidate,
  validating,
}: GradingTableProps & { entry: GradingEntry }) {
  const t = useT();
  const key = entryKey(entry);
  const current = selected === key;
  const action = rowAction(entry);
  const cell = cx(T.td, CELL, current && SELECTED);
  const grading = entry.grading;
  return (
    <tr
      data-row={key}
      aria-current={current ? "true" : undefined}
      onClick={() => onOpen(key)}
      {...pressable(() => onOpen(key), "row")}
      className="group cursor-pointer"
    >
      <td className={cx(cell, STICKY_VERDICT, current && "shadow-[inset_3px_0_0_var(--color-fg)]")}>
        <span className="flex items-center gap-1.5">
          <VerdictGlyph entry={entry} />
          {/* Anonymised there is no Student column: what the row still says
              about whose answer it is — a retake's number, a teacher's own
              run — sits beside its verdict. */}
          {named ? null : <RowMarks entry={entry} />}
        </span>
      </td>
      {named ? (
        <td className={cx(cell, STICKY_NAME)}>
          <span className="flex items-center gap-1.5">
            <span className="font-semibold text-fg">{whoOf(t, entry)}</span>
            <RowMarks entry={entry} />
          </span>
        </td>
      ) : null}
      {isMissing(entry) ? (
        <td colSpan={columns.length} className={cell}>
          <NoAnswer>{t("grading.noAnswer.short")}</NoAnswer>
        </td>
      ) : (
        columns.map((c) => (
          <td key={c.key} className={cx(cell, "max-w-0", c.align === "center" && "text-center")}>
            {c.cell({ answer: entry.answer, details: grading?.details ?? null })}
          </td>
        ))
      )}
      <td className={cx(cell, "whitespace-nowrap text-right tabular-nums")}>
        {grading ? (
          <>
            <span className="font-semibold text-fg">{formatPoints(grading.points)}</span>
            <span className="text-fg-faint"> / {formatPoints(grading.maxPoints)}</span>
          </>
        ) : (
          <Dash />
        )}
        {grading?.source === "llm" && grading.confidence ? (
          <span className="block text-[11px] text-info">
            {t("grading.row.ai", {
              confidence: confidenceLabelShort(t, grading.confidence),
            })}
          </span>
        ) : grading?.source === "manual" ? (
          <span className="block text-[11px] text-fg-faint">
            {t("grading.filter.source.manual")}
          </span>
        ) : null}
      </td>
      <td className={cx(cell, "whitespace-nowrap text-right")}>
        <span
          className={cx(
            "inline-flex items-center gap-1",
            // Hidden, not removed: the column keeps its width, so a row
            // hovered never pushes its neighbours sideways.
            action === null && !current && "invisible group-hover:visible group-focus-within:visible",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {action === "grade" ? (
            // A 0-point placeholder (an essay) is never validated unread: its
            // one action opens it on the grading form.
            <Button size="sm" variant="secondary" onClick={() => onOpen(key, true)}>
              <PencilLine /> {t("grading.grade")}
            </Button>
          ) : (
            <>
              {action === "validate" ? (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={validating && current}
                  onClick={() => onValidate(entry)}
                >
                  <Check /> {t("grading.validate")}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => onOpen(key, true)}>
                {t("grading.override")}
              </Button>
            </>
          )}
        </span>
      </td>
    </tr>
  );
}

/** A retake's number (ADR-025) and a teacher's own run (ADR-018): never a name. */
export function RowMarks({ entry }: { entry: GradingEntry }) {
  const t = useT();
  const n = entry.attemptNumber;
  return (
    <>
      {n !== null ? (
        <Tip label={t(entry.kept ? "grading.attempt.kept" : "grading.attempt", { n })}>
          <Badge tone={entry.kept ? "green" : "zinc"} className="tabular-nums">
            #{n}
          </Badge>
        </Tip>
      ) : null}
      {entry.staff ? (
        <Tip label={t("grading.staff.tip")}>
          <Badge tone="zinc" icon={GraduationCap}>
            {t("grading.staff")}
          </Badge>
        </Tip>
      ) : null}
    </>
  );
}
