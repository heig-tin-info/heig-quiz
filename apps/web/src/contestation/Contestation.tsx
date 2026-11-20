import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { Check, CheckCircle2, Eye, Hourglass, MessageSquareWarning, X, XCircle, type LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import {
  CONTESTATION_TEXT_MAX,
  ContestationFileBody,
  ContestationResolveBody,
  NotContestable,
  ProjectContestationResolveBody,
  type ContestationState,
  type ContestationVerdict,
  type ContestRefusal,
  type ProjectStudentContestation,
  type StudentContestation,
} from "@quiz/contracts";
import { answerExplained, formatPoints } from "@quiz/domain";

import { api, refusalCodeOf, refusalReasonOf, wordedRefusal } from "../api";
import { useHoldChanged } from "../build";
import { useT, type Dict } from "../i18n";
import { useToast } from "../notify";
import {
  Button,
  cx,
  FieldError,
  fieldErrorProps,
  FormDialog,
  FormError,
  HeldButton,
  isoDateTime,
  NotePanel,
  pointsBounds,
  pointsMax,
  Switch,
  Textarea,
  useNow,
} from "../ui";

/**
 * A contestation as its readers see it (ADR-139): the student on their
 * results, the staff where they grade. One request, one answer: where it
 * stands, the reason with its date, and the reply when there is one. Plain
 * text both, drawn escaped with their line breaks kept, never Markdown
 * (decision 6). An acceptance may come with no reply and no change of
 * points (decision 7): nothing here promises points.
 *
 * Shared by every unit a student contests — an exam's question, a
 * project's criterion (Lot 1b) —: the record, the field, the dialog, the
 * window's line and the owner's answer (the days' setting is
 * `ContestationDays.tsx`). What differs per
 * unit is the caller's: the route, the body's schema, and the refusals'
 * words (a question, a criterion).
 */

/** The id of a contestation's state line (`ContestationRecord`'s `stateId`): where the focus lands after an act on its proposal. */
export const contestationStateId = (id: string) => `contestation-state-${id}`;

export const CONTESTATION_STATE: Record<ContestationState, { icon: LucideIcon; label: keyof Dict; badge: keyof Dict; text: string }> = {
  open: { icon: Hourglass, label: "contest.state.waiting", badge: "contest.badge.open", text: "text-warning" },
  accepted: { icon: CheckCircle2, label: "contest.state.accepted", badge: "contest.badge.accepted", text: "text-success" },
  refused: { icon: XCircle, label: "contest.state.refused", badge: "contest.badge.refused", text: "text-fg-muted" },
};

/** A reason or a reply: the text as written, line breaks kept, never interpreted. */
function ContestationText({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap break-words text-sm text-fg">{text}</p>;
}

export function ContestationRecord({
  contestation,
  audience,
  folded = false,
  focus = false,
  stateId,
  children,
}: {
  contestation: StudentContestation;
  /** The student reads "Your reason"; the staff, "Reason". */
  audience: "student" | "teacher";
  /** The reason starts behind "Show the reason" (the staff under Anonymise, decision 4). */
  folded?: boolean;
  /** Takes the focus once shown: the record replaced the button that was focused. */
  focus?: boolean;
  /** The state line's id: where the focus lands after an act on the contestation (a proposal confirmed or discarded). */
  stateId?: string;
  /** Under the record: what the reader may do, or why they may not. */
  children?: ReactNode;
}) {
  const t = useT();
  const reasonId = useId();
  const [shown, setShown] = useState(!folded);
  // Names on unfold it; names off fold it again, for the next answer read.
  useEffect(() => setShown(!folded), [folded]);
  const stateRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (focus) stateRef.current?.focus();
  }, [focus]);
  const reasonRef = useRef<HTMLDivElement>(null);
  const state = CONTESTATION_STATE[contestation.state];
  const Icon = state.icon;
  return (
    <div className="space-y-3">
      <p ref={stateRef} id={stateId} tabIndex={-1} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 outline-none">
        <span className={cx("inline-flex items-center gap-1.5 text-sm font-semibold", state.text)}>
          <Icon aria-hidden className="size-4 self-center" />
          {t(state.label)}
        </span>
        {contestation.resolvedAt ? (
          <span className="text-xs tabular-nums text-fg-muted">
            {t("contest.answeredOn", { when: isoDateTime(contestation.resolvedAt) })}
          </span>
        ) : null}
      </p>
      <NotePanel
        tone="outlined"
        eyebrow={t(audience === "student" ? "contest.yourReason" : "contest.reason")}
        aside={isoDateTime(contestation.filedAt)}
      >
        {shown ? (
          <div id={reasonId} ref={reasonRef} tabIndex={-1} className="outline-none">
            <ContestationText text={contestation.reason} />
          </div>
        ) : (
          // A disclosure: once open, the focus moves to the text it revealed.
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2"
            aria-expanded={false}
            aria-controls={reasonId}
            onClick={() => {
              setShown(true);
              requestAnimationFrame(() => reasonRef.current?.focus());
            }}
          >
            <Eye /> {t("contest.showReason")}
          </Button>
        )}
      </NotePanel>
      {contestation.reply ? (
        <NotePanel eyebrow={t("contest.reply")}>
          <ContestationText text={contestation.reply} />
        </NotePanel>
      ) : null}
      {children}
    </div>
  );
}

/**
 * A criterion's contestation under its heading (ADR-139 §13): the criterion
 * as it read when contested — its description, `detail` under it (the
 * staff's id) — and its points then over its maximum. A criterion may have
 * left the snapshot since: the heading is the contestation's own.
 */
export function ContestedCriterionHeading({
  contestation,
  detail,
}: {
  contestation: Pick<ProjectStudentContestation, "criterionDescription" | "pointsAtFiling" | "maxAtFiling" | "bonusAtFiling">;
  detail?: ReactNode;
}) {
  const t = useT();
  const bounds = pointsBounds({ max: contestation.maxAtFiling, bonus: contestation.bonusAtFiling ?? undefined });
  return (
    <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <span className="min-w-0">
        <span className="block text-sm font-semibold leading-snug">{contestation.criterionDescription}</span>
        {detail}
      </span>
      <span className="text-[13px] tabular-nums text-fg-muted">
        {t("contest.atFiling", { points: formatPoints(contestation.pointsAtFiling), max: pointsMax(bounds) })}
      </span>
    </p>
  );
}

/**
 * A reason or a reply being written: plain text, at most 2,000 characters
 * (`maxLength`), the help line turned into the error when there is one —
 * tied to the field — and the count beside it.
 */
export function ContestationField({
  label,
  placeholder,
  value,
  onChange,
  help,
  error,
  autoFocus,
  rows,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  help: string;
  /** Shown instead of the help, in the error's tone. */
  error?: string | null;
  autoFocus?: boolean;
  rows?: number;
}) {
  const t = useT();
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Textarea
        id={id}
        label={label}
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        rows={rows}
        maxLength={CONTESTATION_TEXT_MAX}
        onChange={(e) => onChange(e.target.value)}
        {...fieldErrorProps(id, error)}
      />
      <div className="flex justify-between gap-3 text-xs text-fg-muted">
        {error ? <FieldError id={id}>{error}</FieldError> : <span>{help}</span>}
        <span className="shrink-0 tabular-nums">
          {t("qt.rich.p.countOf", { count: value.length, max: CONTESTATION_TEXT_MAX })}
        </span>
      </div>
    </div>
  );
}

/**
 * ADR-139: the window, a quiet line under the score. While it runs (the
 * closing instant against the clock), until when — if a unit may still be
 * contested or is; once it closed, that it did — if one was contested. A
 * student with nothing to contest reads nothing about it.
 */
export function ContestWindowLine({ closesAt, contested, offered }: { closesAt: string | null; contested: boolean; offered: boolean }) {
  const t = useT();
  const now = useNow(60_000);
  if (closesAt === null) return null;
  const running = Date.parse(closesAt) > now;
  if (running ? !(contested || offered) : !contested) return null;
  return (
    <p className="flex items-center gap-1.5 text-[13px] text-fg-muted">
      <MessageSquareWarning aria-hidden className="size-3.5 shrink-0" />
      {running ? t("contest.until", { when: isoDateTime(closesAt) }) : t("contest.closed")}
    </p>
  );
}

/**
 * The words of a student's refused filing (ADR-139 §4), per unit: the
 * codes (`contestation_closed`, `contestation_exists`, `classroom_archived`)
 * and `409 not_contestable`'s reasons — a new reason in the contract is a
 * compile error in every table.
 */
export interface FilingRefusals {
  codes: Partial<Record<string, keyof Dict>>;
  notContestable: Record<ContestRefusal, keyof Dict>;
}

/** An exam's question (Lot 1). */
export const QUESTION_REFUSALS: FilingRefusals = {
  codes: {
    contestation_closed: "contest.refusal.closed",
    contestation_exists: "contest.refusal.exists",
    classroom_archived: "contest.refusal.archived",
  },
  notContestable: {
    not_shown: "contest.refusal.not_shown",
    not_counted: "contest.refusal.not_counted",
    not_counting: "contest.refusal.not_counting",
    pending: "contest.refusal.pending",
    full_points: "contest.refusal.full_points",
  },
};

/**
 * "Contest" (ADR-139, F-GRADE-08): the student's one request on one unit.
 * One field, the reason, plain text and mandatory; the dialog says it goes
 * once and cannot be changed, and until when the window holds. The server
 * decides again on its own clock: a refusal is worded here, and `invalidate`
 * is read again whatever the answer, so a window closed since the page
 * loaded stops offering the act.
 */
export function ContestDialog<C extends StudentContestation = StudentContestation>({
  title,
  closesAt,
  path,
  invalidate,
  refusals = QUESTION_REFUSALS,
  note,
  onFiled,
  onClose,
}: {
  title: string;
  /** The window's closing instant, as the page has it. */
  closesAt: string | null;
  /** The route that files it (`POST`, `ContestationFileBody`). */
  path: string;
  /** The reads that show the contestation, refreshed after the answer. */
  invalidate: readonly QueryKey[];
  /** The refusals' words for the unit; an exam's question's by default. */
  refusals?: FilingRefusals;
  /** A line under the window's: what else the student should know before sending (a group's repository). */
  note?: ReactNode;
  /** The contestation as filed, before the reads come back. */
  onFiled?: (contestation: C) => void;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const refresh = () => {
    for (const queryKey of invalidate) void qc.invalidateQueries({ queryKey });
  };

  const file = useMutation<C, unknown, ContestationFileBody>({
    mutationFn: (body) => api(path, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (contestation) => {
      onFiled?.(contestation);
      refresh();
      toast(t("contest.sent"), "success");
      onClose();
    },
    onError: refresh,
  });

  // The contract's own check (invariant 7): trimmed, 1 to 2,000 characters.
  const body = ContestationFileBody.safeParse({ reason });

  return (
    <FormDialog
      title={title}
      onClose={onClose}
      submitLabel={t("contest.send")}
      submitting={file.isPending}
      canSubmit={body.success}
      onSubmit={() => body.success && file.mutate(body.data)}
      error={
        <FormError
          error={file.error}
          describe={(e) => {
            const reason = refusalReasonOf(e, NotContestable);
            return reason ? t(refusals.notContestable[reason]) : wordedRefusal(e, refusals.codes, t);
          }}
        />
      }
    >
      <ContestationField
        label={t("contest.reason")}
        placeholder={t("contest.reason.placeholder")}
        value={reason}
        onChange={setReason}
        help={t("contest.once")}
        autoFocus
        rows={6}
      />
      {closesAt ? <p className="text-[13px] text-fg-muted">{t("contest.until", { when: isoDateTime(closesAt) })}</p> : null}
      {note ? <p className="text-[13px] text-fg-muted">{note}</p> : null}
    </FormDialog>
  );
}

/**
 * The points an answer gives, as the unit's write takes them: an exam
 * cell's (`points`, or an essay's `criteria`, the manual override's), or a
 * project criterion's (`points` and its `rationale`, the teacher's
 * criterion write).
 */
export type AnswerPoints =
  | Pick<ContestationResolveBody, "points" | "criteria">
  | Pick<ProjectContestationResolveBody, "points" | "rationale">;

/** The answer's body, by the unit's contract (invariant 7): an exam's, or a project criterion's. */
export type ResolveSchema = typeof ContestationResolveBody | typeof ProjectContestationResolveBody;

/**
 * New points of an answer: the unit's fields (shown once "Change the
 * points" is on), whether they are valid, as the wire writes them, and how
 * a proposal's points (and a criterion's rationale) are copied into them.
 */
export interface ReplyPoints {
  fields: ReactNode;
  invalid: boolean;
  body: () => AnswerPoints;
  fill?: (points: number, rationale: string | null) => void;
}

/** A proposal copied into the answer (Edit): its reply, and whether its points were; `n` keys the form's remount, one per Edit. */
export interface ReplySeed {
  reply: string;
  givePoints: boolean;
  n: number;
}

/** The refusals of the owner's answer this block words; `owner_required` and `criteria_invalid` are the app's. */
const ANSWER_REFUSAL: Partial<Record<string, keyof Dict>> = {
  not_open: "contest.answer.refusal.not_open",
  points_out_of_range: "contest.answer.refusal.points",
};

/**
 * The owner's one answer to an OPEN contestation (decision 2): a reply,
 * Refuse — which needs it — and Accept, which takes one or none, and may
 * give new points (`points`, the caller's fields: then the reply is
 * mandatory, and becomes the override's comment, decision 7). Both buttons
 * are secondary: the screen's one primary stays its own. The body is the
 * contract's (invariant 7); `onChanged` refreshes the reads after an
 * answer, and after a refusal that says it was answered meanwhile.
 */
export function ContestationReply({
  resolvePath,
  onChanged,
  points,
  schema = ContestationResolveBody,
  acceptable = true,
  refusals,
  initial = null,
}: {
  resolvePath: string;
  onChanged: () => void;
  /** New points: the unit's fields, offered by the switch. */
  points?: ReplyPoints | undefined;
  /** The body's contract; an exam's by default. */
  schema?: ResolveSchema;
  /** Accept is offered (a criterion that left the project's snapshot may only be refused). */
  acceptable?: boolean;
  /** The unit's words for refusals, over the shared ones. */
  refusals?: Partial<Record<string, keyof Dict>>;
  /** Where the form starts (Edit, which remounts it): the proposal's reply and whether its points were copied; the focus goes to the reply. */
  initial?: ReplySeed | null;
}) {
  const t = useT();
  const toast = useToast();
  const headingId = useId();
  const [reply, setReply] = useState(initial?.reply ?? "");
  /** The verdict last asked for: its checks show, and its button spins. */
  const [asked, setAsked] = useState<ContestationVerdict | null>(null);
  /** New points are given: the switch, offered with the unit's fields. */
  const [switched, setSwitched] = useState(initial?.givePoints ?? false);
  const given = points !== undefined && switched;
  useHoldChanged({ reply, given });

  const resolve = useMutation<unknown, unknown, { verdict: ContestationVerdict }>({
    mutationFn: (body) => api(resolvePath, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (_data, body) => {
      onChanged();
      toast(t(body.verdict === "accepted" ? "contest.answer.done.accepted" : "contest.answer.done.refused"), "success");
    },
    onError: (error) => {
      if (refusalCodeOf(error) === "not_open") onChanged();
    },
  });

  const replyNeeded = (verdict: ContestationVerdict) => !answerExplained({ verdict, reply, points: given });
  const send = (verdict: ContestationVerdict) => {
    setAsked(verdict);
    if (replyNeeded(verdict) || (verdict === "accepted" && given && points.invalid)) return;
    const body = schema.safeParse({ verdict, reply, ...(verdict === "accepted" && given ? points.body() : {}) });
    if (body.success) resolve.mutate(body.data);
  };

  return (
    <section aria-labelledby={headingId} className="space-y-4 rounded-card border border-line-strong bg-surface p-4">
      <div>
        <h3 id={headingId} className="text-sm font-semibold">
          {t("contest.answer")}
        </h3>
        <p className="text-xs text-fg-muted">{t("contest.answer.desc")}</p>
      </div>
      <ContestationField
        label={t("contest.reply")}
        placeholder={t("contest.reply.placeholder")}
        value={reply}
        onChange={setReply}
        autoFocus={initial != null}
        help={t("contest.reply.help")}
        error={asked !== null && replyNeeded(asked) ? t("contest.reply.help") : null}
      />
      {points ? (
        <>
          <label className="flex items-center gap-2 text-[13px] font-medium">
            <Switch checked={switched} onChange={setSwitched} label={t("grading.contest.givePoints")} />
            <span aria-hidden>{t("grading.contest.givePoints")}</span>
          </label>
          {given ? points.fields : null}
        </>
      ) : null}
      <FormError
        error={resolve.error}
        title={t("contest.answer.failed")}
        describe={(e) => wordedRefusal(e, { ...ANSWER_REFUSAL, ...refusals }, t)}
      />
      <div className="flex flex-wrap justify-end gap-2">
        {/* A refusal gives no points: the contract refuses the pair. */}
        <HeldButton
          variant="secondary"
          disabledReason={given ? t("contest.answer.refuseNoPoints") : null}
          loading={resolve.isPending && asked === "refused"}
          disabled={resolve.isPending}
          onClick={() => send("refused")}
        >
          <X /> {t("contest.answer.refuse")}
        </HeldButton>
        {acceptable ? (
          <Button
            variant="secondary"
            loading={resolve.isPending && asked === "accepted"}
            disabled={resolve.isPending}
            onClick={() => send("accepted")}
          >
            <Check /> {t("contest.answer.accept")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
