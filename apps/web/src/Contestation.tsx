import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { Check, CheckCircle2, Eye, Hourglass, X, XCircle, type LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import {
  CONTESTATION_TEXT_MAX,
  ContestationFileBody,
  ContestationResolveBody,
  NotContestable,
  type ContestationResolution,
  type ContestationState,
  type ContestationVerdict,
  type ContestRefusal,
  type StudentContestation,
} from "@quiz/contracts";
import { answerExplained } from "@quiz/domain";

import { api, refusalCodeOf, refusalReasonOf, wordedRefusal } from "./api";
import { useHoldChanged } from "./build";
import { useT, type Dict } from "./i18n";
import { useToast } from "./notify";
import { Button, cx, FieldError, fieldErrorProps, FormDialog, FormError, HeldButton, isoDateTime, NotePanel, Textarea } from "./ui";

/**
 * A contestation as its readers see it (ADR-139): the student on their
 * results, the staff where they grade. One request, one answer: where it
 * stands, the reason with its date, and the reply when there is one. Plain
 * text both, drawn escaped with their line breaks kept, never Markdown
 * (decision 6). An acceptance may come with no reply and no change of
 * points (decision 7): nothing here promises points.
 *
 * Shared by every unit a student contests: an exam's question here, a
 * project's criterion next (Lot 1b) — the record, the field, the dialog
 * and the refusals' words.
 */

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
  children,
}: {
  contestation: StudentContestation;
  /** The student reads "Your reason"; the staff, "Reason". */
  audience: "student" | "teacher";
  /** The reason starts behind "Show the reason" (the staff under Anonymise, decision 4). */
  folded?: boolean;
  /** Takes the focus once shown: the record replaced the button that was focused. */
  focus?: boolean;
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
      <p ref={stateRef} tabIndex={-1} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 outline-none">
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

/** The refusals of a student's contestation (ADR-139 §4), in their words. */
const REFUSAL: Partial<Record<string, keyof Dict>> = {
  contestation_closed: "contest.refusal.closed",
  contestation_exists: "contest.refusal.exists",
  classroom_archived: "contest.refusal.archived",
};

/** `409 not_contestable`'s reasons: a new reason in the contract is a compile error here. */
const NOT_CONTESTABLE: Record<ContestRefusal, keyof Dict> = {
  not_shown: "contest.refusal.not_shown",
  not_counted: "contest.refusal.not_counted",
  not_counting: "contest.refusal.not_counting",
  pending: "contest.refusal.pending",
  full_points: "contest.refusal.full_points",
};

/**
 * "Contest" (ADR-139, F-GRADE-08): the student's one request on one unit.
 * One field, the reason, plain text and mandatory; the dialog says it goes
 * once and cannot be changed, and until when the window holds. The server
 * decides again on its own clock: a refusal is worded here, and `invalidate`
 * is read again whatever the answer, so a window closed since the page
 * loaded stops offering the act.
 */
export function ContestDialog({
  title,
  closesAt,
  path,
  invalidate,
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
  /** The contestation as filed, before the reads come back. */
  onFiled?: (contestation: StudentContestation) => void;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const refresh = () => {
    for (const queryKey of invalidate) void qc.invalidateQueries({ queryKey });
  };

  const file = useMutation<StudentContestation, unknown, ContestationFileBody>({
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
            return reason ? t(NOT_CONTESTABLE[reason]) : wordedRefusal(e, REFUSAL, t);
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
    </FormDialog>
  );
}

/** The points an answer gives: a grading's (`points`, or an essay's `criteria`), as the manual override writes them. */
export type AnswerPoints = Pick<ContestationResolveBody, "points" | "criteria">;

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
}: {
  resolvePath: string;
  onChanged: () => void;
  /** New points: the fields (the switch that offers them included), whether any are given, valid, and as the wire writes them. */
  points?: { fields: ReactNode; given: boolean; invalid: boolean; body: () => AnswerPoints };
}) {
  const t = useT();
  const toast = useToast();
  const headingId = useId();
  const [reply, setReply] = useState("");
  /** The verdict last asked for: its checks show, and its button spins. */
  const [asked, setAsked] = useState<ContestationVerdict | null>(null);
  const given = points?.given === true;
  useHoldChanged({ reply, given });

  const resolve = useMutation<ContestationResolution, unknown, ContestationResolveBody>({
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
    const body = ContestationResolveBody.safeParse({ verdict, reply, ...(verdict === "accepted" && given ? points.body() : {}) });
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
        help={t("contest.reply.help")}
        error={asked !== null && replyNeeded(asked) ? t("contest.reply.help") : null}
      />
      {points?.fields}
      <FormError error={resolve.error} title={t("contest.answer.failed")} describe={(e) => wordedRefusal(e, ANSWER_REFUSAL, t)} />
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
        <Button
          variant="secondary"
          loading={resolve.isPending && asked === "accepted"}
          disabled={resolve.isPending}
          onClick={() => send("accepted")}
        >
          <Check /> {t("contest.answer.accept")}
        </Button>
      </div>
    </section>
  );
}
