import { useMutation } from "@tanstack/react-query";
import { CalendarClock, ChevronRight, Lock, MessageSquareWarning } from "lucide-react";
import { useState } from "react";

import { WindowInstantRefused, type ContestationWindow, type ContestationWindowBody, type WindowExtendRefusal } from "@quiz/contracts";
import { CONTESTATION_DAYS_DEFAULT, contestationClosesAt, windowExtendLatest, windowExtendRefusal } from "@quiz/domain";

import { api, refusalReasonOf, wordedRefusal } from "../api";
import { useConfirm } from "../confirm";
import { useT, type Dict, type TFunction } from "../i18n";
import { useToast } from "../notify";
import { Button, FormError, InstantDialog, isoDateTime, useNow } from "../ui";

/**
 * What the line words per unit: `window_unavailable` (the owner's acts
 * refused, ADR-139 §2; `owner_required` is the app's) and the close's
 * confirmation. An exam's question by default; a project's criterion has
 * its own (§13).
 */
export interface WindowWords {
  unavailable: keyof Dict;
  closeBody: keyof Dict;
}

const QUESTION_WORDS: WindowWords = {
  unavailable: "results.contest.refusal.unavailable",
  closeBody: "results.contest.close.confirm.body",
};

/** "1 open contestation", "n open contestations": the count of the line, a repository's row and a step's flag. */
export const openContestationsWords = (n: number, t: TFunction): string =>
  n === 1 ? t("results.contest.open.one") : t("results.contest.open", { n });

/** An instant refused, the field's and the server's (`422 window_instant`) alike. */
function instantWords(reason: WindowExtendRefusal, now: Date, t: TFunction): string {
  const words: Record<WindowExtendRefusal, string> = {
    not_future: t("live.extendUntil.notLater", { when: isoDateTime(now.toISOString()) }),
    too_far: t("live.extendUntil.tooFar", { when: isoDateTime(windowExtendLatest(now).toISOString()) }),
  };
  return words[reason];
}

/**
 * The contestations of a released unit on its results (ADR-139): how many
 * wait for an answer — a link to where they are answered — and until when
 * a student may file one. Where a window applies, the course's owner may
 * close it now or move its end (which may reopen it), or open one where
 * none was set (a window of 0 days, a policy changed after the release);
 * everyone else reads the line. Nothing when no window applies and nothing
 * is open. Shared by the exams' results and a project's Grading tab.
 */
export function ContestationLine({
  path,
  closesAt,
  applies,
  open,
  isOwner,
  onChanged,
  onOpenContested,
  words = QUESTION_WORDS,
}: {
  /** `PUT …/contestation-window` of the unit. */
  path: string;
  /** The window's closing instant; null without one. */
  closesAt: string | null;
  /** A window applies here (`contestationApplies`): the owner may set it. */
  applies: boolean;
  /** The open contestations. */
  open: number;
  isOwner: boolean;
  /** The window moved: refresh what shows it. */
  onChanged: () => void;
  onOpenContested: () => void;
  words?: WindowWords;
}) {
  const t = useT();
  const refusal: Partial<Record<string, keyof Dict>> = { window_unavailable: words.unavailable };
  const toast = useToast();
  const confirm = useConfirm();
  const [choosing, setChoosing] = useState(false);
  // "Now" for the line and the dialog's bounds; the server decides every write on its own (invariant 5).
  const now = new Date(useNow(60_000));
  const act = useMutation<ContestationWindow, unknown, ContestationWindowBody>({
    mutationFn: (body) => api(path, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: (_answer, body) => {
      onChanged();
      toast(t(body.action === "close" ? "results.contest.closed.done" : "results.contest.extended.done"), "success");
    },
  });
  if (!applies && open === 0) return null;
  const running = closesAt !== null && new Date(closesAt).getTime() > now.getTime();

  const close = async () => {
    const ok = await confirm({
      title: t("results.contest.close.confirm.title"),
      message: t(words.closeBody),
      confirmLabel: t("results.contest.close"),
      danger: true,
    });
    if (ok) act.mutate({ action: "close" }, { onError: (e) => toast(wordedRefusal(e, refusal, t), "error") });
  };

  const windowText = applies
    ? closesAt === null
      ? t("results.contest.none")
      : running
        ? t("contest.until", { when: isoDateTime(closesAt) })
        : t("contest.closed")
    : null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card border border-line bg-surface px-4 py-2.5">
      {open > 0 ? (
        <button
          type="button"
          onClick={onOpenContested}
          className="inline-flex items-center gap-1.5 rounded-sm text-sm font-semibold text-warning underline-offset-4 hover:underline"
        >
          <MessageSquareWarning aria-hidden className="size-4" />
          {openContestationsWords(open, t)}
          <ChevronRight aria-hidden className="size-4" />
        </button>
      ) : null}
      {windowText ? (
        <span className="inline-flex items-center gap-1.5 text-[13px] text-fg-muted">
          {running ? <CalendarClock aria-hidden className="size-3.5" /> : <Lock aria-hidden className="size-3.5" />}
          {windowText}
        </span>
      ) : null}
      {isOwner && applies ? (
        <span className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => setChoosing(true)}>
            <CalendarClock /> {t(closesAt === null ? "results.contest.openWindow" : "results.contest.extend")}
          </Button>
          {running ? (
            <Button size="sm" variant="secondary" loading={act.isPending} onClick={() => void close()}>
              <Lock /> {t("results.contest.close")}
            </Button>
          ) : null}
        </span>
      ) : null}
      {choosing ? (
        // Extending may reopen a closed window, or open one where none was set.
        <InstantDialog
          title={t(closesAt === null ? "results.contest.openWindow.title" : "results.contest.extend.title")}
          submitLabel={t(closesAt === null ? "results.contest.openWindow" : "results.contest.extend")}
          fieldLabel={t("results.contest.extend.field")}
          description={
            closesAt === null ? t("results.contest.none") : t("results.contest.extend.desc", { when: isoDateTime(closesAt) })
          }
          initial={contestationClosesAt(
            new Date(Math.max(now.getTime(), closesAt === null ? 0 : Date.parse(closesAt))),
            CONTESTATION_DAYS_DEFAULT,
          )!.toISOString()}
          min={now.toISOString()}
          max={windowExtendLatest(now).toISOString()}
          refusal={(until) => {
            const reason = windowExtendRefusal(new Date(until), now);
            return reason === null ? null : instantWords(reason, now, t);
          }}
          pending={act.isPending}
          onSubmit={(until) => act.mutate({ action: "extend", closesAt: until }, { onSuccess: () => setChoosing(false) })}
          onClose={() => setChoosing(false)}
          error={
            <FormError
              error={act.error}
              describe={(e) => {
                const reason = refusalReasonOf(e, WindowInstantRefused);
                return reason ? instantWords(reason, now, t) : wordedRefusal(e, refusal, t);
              }}
            />
          }
        />
      ) : null}
    </div>
  );
}
