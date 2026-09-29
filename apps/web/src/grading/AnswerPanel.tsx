import { useMutation } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Check, PencilLine, RefreshCcw } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import type { GradingColumn } from "@quiz/core/client";
import type { Grading, GradingEntry } from "@quiz/contracts";
import { formatPoints } from "@quiz/domain";

import { api } from "../api";
import { useT } from "../i18n";
import { MarkdownView } from "../markdown/MarkdownView";
import { useToast } from "../notify";
import { emptyAnswerOf, QuestionPlayerHost, QuestionReviewHost, typeLabel } from "../questionTypes";
import { Button, Field, FormError, IconButton, NotePanel, Sheet, Textarea } from "../ui";
import { RowMarks } from "./GradingTable";
import { GradingHistory } from "./GradingHistory";
import { gradingStateLabel, machineReason, sourceLabel, whoOf } from "./labels";
import { isMissing, type PanelTarget } from "./rows";
import { useGradingInvalidate } from "./useGradingInvalidate";
import type { GradingItem } from "./useGradingData";
import { ExpectedGlyph, VerdictGlyph } from "./VerdictGlyph";

interface PanelProps {
  evaluationId: string;
  target: PanelTarget;
  item: GradingItem;
  /** The question's number, from 1. */
  number: number;
  named: boolean;
  columns: GradingColumn[];
  /** The question as its students saw it: the expected panel's statement. */
  student: unknown;
  explanation: string | null;
  onClose: () => void;
  /** One row up or down the table, the expected row included (↑ / ↓). */
  onMove: (delta: number) => void;
  onAdjust: (on: boolean) => void;
  onValidate: (entry: GradingEntry) => void;
  validating: boolean;
  onRegrade: () => void;
  onEdit?: (() => void) | undefined;
}

/**
 * The answer panel (ADR-040): one row of the table, read in full in a
 * sheet on the right — the question as the student saw it with their answer
 * and its verdict (the type's own `Review`), the explanation, the history,
 * and what the teacher does with it: validate the proposal, or adjust the
 * points with a comment.
 *
 * It is keyed on the ENTRY, never on a row's index: an answer validated
 * under "To validate" leaves the table, and the panel keeps showing it, now
 * validated, instead of sliding onto the next student's answer. ↑ and ↓ are
 * what move it, in the table's order.
 *
 * The adjustment form is inline (it replaced a sheet of its own: a sheet
 * never opens another sheet), and the comment it asks for is the one the
 * student may read: the help line under it says so.
 */
export function AnswerPanel(props: PanelProps) {
  const t = useT();
  const { target } = props;
  const moves = (
    <>
      <IconButton label={t("grading.detail.prev")} onClick={() => props.onMove(-1)}>
        <ArrowUp />
      </IconButton>
      <IconButton label={t("grading.detail.next")} onClick={() => props.onMove(1)}>
        <ArrowDown />
      </IconButton>
    </>
  );
  if (target.kind === "expected") {
    return (
      <Sheet
        title={t("grading.panel.question", { n: props.number })}
        subtitle={
          <>
            <span className="font-mono text-[12.5px]">{props.item.internalName}</span> ·{" "}
            {typeLabel(t, props.item.type)} · {t("grading.points", { n: props.item.points })}
          </>
        }
        leading={<ExpectedGlyph />}
        actions={moves}
        onClose={props.onClose}
        footer={
          <>
            {props.onEdit ? (
              <Button variant="secondary" onClick={props.onEdit}>
                <PencilLine /> {t("grading.editQuestion")}
              </Button>
            ) : null}
            <Button variant="secondary" onClick={props.onRegrade}>
              <RefreshCcw /> {t("grading.regrade.open")}
            </Button>
          </>
        }
      >
        <ExpectedBody {...props} />
      </Sheet>
    );
  }
  return <EntrySheet {...props} target={target} moves={moves} />;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-faint">{title}</h3>
      {children}
    </section>
  );
}

function ExpectedBody({ item, columns, student, explanation }: PanelProps) {
  const t = useT();
  return (
    <div className="space-y-6">
      <Section title={t("grading.panel.statement")}>
        <QuestionPlayerHost
          t={t}
          type={item.type}
          student={student}
          answer={emptyAnswerOf(item.type, student)}
          onChange={() => {}}
          readOnly
        />
      </Section>
      <Section title={t("grading.expected")}>
        <dl className="space-y-1.5 text-[13px]">
          {columns.map((c) => (
            <div key={c.key} className="flex items-baseline gap-3">
              <dt className="w-40 shrink-0 truncate text-fg-muted" title={c.title ?? c.label}>
                {c.label}
              </dt>
              <dd className="min-w-0">{c.expected()}</dd>
            </div>
          ))}
        </dl>
      </Section>
      {explanation ? (
        <NotePanel eyebrow={t("grading.explanation")}>
          <MarkdownView size="sm" source={explanation} />
        </NotePanel>
      ) : null}
      <p className="text-xs text-fg-muted">{t("grading.panel.expectedHelp")}</p>
    </div>
  );
}

function EntrySheet({
  evaluationId,
  target,
  item,
  named,
  explanation,
  onClose,
  onAdjust,
  onValidate,
  validating,
  moves,
}: PanelProps & { target: Extract<PanelTarget, { kind: "entry" }>; moves: ReactNode }) {
  const t = useT();
  const toast = useToast();
  const invalidate = useGradingInvalidate(evaluationId);
  const formId = useId();
  const { entry, adjust } = target;
  const grading = entry.grading;

  // Two addresses for one correction (deviation W6-3): a graded cell by its
  // grading, an ungraded one by its answer. A cell with neither — an absent
  // student the pass has not reached — has nothing to adjust yet.
  const path = grading
    ? `/app/api/gradings/${grading.id}/override`
    : entry.answerId
      ? `/app/api/answers/${entry.answerId}/gradings`
      : null;
  const save = useMutation<Grading, unknown, { points: number; comment: string }>({
    mutationFn: (body) => api(path!, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      invalidate();
      toast(t("grading.override.done"), "success");
      onAdjust(false);
    },
  });

  const status = grading
    ? [
        t("grading.panel.score", {
          points: formatPoints(grading.points),
          max: formatPoints(grading.maxPoints),
        }),
        sourceLabel(t, grading.source),
        gradingStateLabel(t, grading.state),
      ].join(" · ")
    : t("grading.entry.state.ungraded");

  return (
    <Sheet
      title={named ? whoOf(t, entry) : t("grading.panel.anonymous")}
      subtitle={
        <span className="flex flex-wrap items-center gap-1.5">
          <RowMarks entry={entry} />
          <span className="tabular-nums">{status}</span>
        </span>
      }
      leading={<VerdictGlyph entry={entry} />}
      actions={moves}
      onClose={onClose}
      footer={
        adjust ? (
          <>
            <Button variant="ghost" onClick={() => onAdjust(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" form={formId} loading={save.isPending}>
              {t("grading.override.save")}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" disabled={path === null} onClick={() => onAdjust(true)}>
              <PencilLine /> {t("grading.override")}
            </Button>
            {grading?.state === "proposed" ? (
              <Button loading={validating} onClick={() => onValidate(entry)}>
                <Check /> {t("grading.validate")}
              </Button>
            ) : null}
          </>
        )
      }
    >
      <div className="space-y-6">
        {isMissing(entry) ? (
          <p className="text-sm italic text-fg-faint">{t("grading.noAnswer")}</p>
        ) : null}
        <QuestionReviewHost
          t={t}
          type={item.type}
          student={entry.student}
          answer={entry.answer}
          solution={entry.solution}
          details={grading?.details ?? null}
          points={grading ? grading.points : null}
          maxPoints={grading?.maxPoints ?? item.points}
          audience="teacher"
        />
        {/* A comment is the teacher's only when the grading is: an automatic
            pass puts its own note here ("runner unavailable"), and labelling
            that "visible to the student" would be a promise nobody made. */}
        {grading?.comment ? (
          <NotePanel
            tone={grading.source === "manual" ? "outlined" : "soft"}
            eyebrow={t(grading.source === "manual" ? "grading.comment" : "grading.machineComment")}
          >
            <p className="text-[13px] text-fg">
              {grading.source === "manual" ? grading.comment : machineReason(t, grading.comment)}
            </p>
          </NotePanel>
        ) : null}
        {explanation ? (
          <NotePanel eyebrow={t("grading.explanation")}>
            <MarkdownView size="sm" source={explanation} />
          </NotePanel>
        ) : null}
        {adjust && path !== null ? (
          <Section title={t("grading.override.title")}>
            {/* Keyed on the entry: another answer is another form. */}
            <AdjustForm
              key={`${entry.attemptId}:${entry.itemId}`}
              id={formId}
              entry={entry}
              maxPoints={grading?.maxPoints ?? item.points}
              minPoints={item.minPoints ?? 0}
              onSave={(body) => save.mutate(body)}
              error={<FormError error={save.error} title={t("grading.override.failed")} />}
            />
          </Section>
        ) : null}
        <Section title={t("grading.history.title")}>
          <GradingHistory history={entry.history} />
        </Section>
      </div>
    </Sheet>
  );
}

/**
 * F-GRADE-05: the teacher's own points, with their MANDATORY comment. The
 * grading it replaces is not deleted — the server supersedes it, and the
 * history under this form is where it goes on living. The check is quiet
 * until the first submit, then marks what is wrong.
 */
function AdjustForm({
  id,
  entry,
  maxPoints,
  minPoints,
  onSave,
  error,
}: {
  id: string;
  entry: GradingEntry;
  maxPoints: number;
  /** 0, or `-maxPoints` for a choice question under negative marking (ADR-026). */
  minPoints: number;
  onSave: (body: { points: number; comment: string }) => void;
  error: ReactNode;
}) {
  const t = useT();
  const [points, setPoints] = useState(() =>
    entry.grading ? formatPoints(entry.grading.points) : "0",
  );
  const [comment, setComment] = useState(
    entry.grading?.source === "manual" ? (entry.grading.comment ?? "") : "",
  );
  const [touched, setTouched] = useState(false);
  const value = Number(points.replace(",", "."));
  const pointsInvalid =
    points.trim() === "" || !Number.isFinite(value) || value < minPoints || value > maxPoints;
  const commentInvalid = comment.trim() === "";
  const range = { min: formatPoints(minPoints), max: formatPoints(maxPoints) };

  return (
    <form
      id={id}
      // The checks are ours, worded under each field: the browser's own
      // bubbles (from `required`, `min`, `max`) would stop the submit first.
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (pointsInvalid || commentInvalid) return;
        onSave({ points: value, comment: comment.trim() });
      }}
    >
      <Field
        label={t("grading.override.points")}
        hint={minPoints < 0 ? t("grading.override.range", range) : t("grading.override.max", range)}
        type="number"
        step="0.5"
        min={minPoints}
        max={maxPoints}
        autoFocus
        width="w-32"
        value={points}
        onChange={(e) => setPoints(e.target.value)}
        aria-invalid={touched && pointsInvalid}
      />
      {touched && pointsInvalid ? (
        <p className="text-[13px] text-danger">{t("grading.override.pointsInvalid", range)}</p>
      ) : null}
      <div className="space-y-1.5">
        <Textarea
          label={t("grading.override.comment")}
          placeholder={t("grading.override.commentPlaceholder")}
          value={comment}
          required
          onChange={(e) => setComment(e.target.value)}
          aria-invalid={touched && commentInvalid}
        />
        {touched && commentInvalid ? (
          <p className="text-[13px] text-danger">{t("grading.override.commentRequired")}</p>
        ) : (
          <p className="text-xs text-fg-muted">
            {t("grading.override.commentHelp")} {t("grading.override.subtitle")}
          </p>
        )}
      </div>
      {error}
    </form>
  );
}
