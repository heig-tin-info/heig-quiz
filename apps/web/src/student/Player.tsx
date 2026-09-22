/**
 * The "zen" player: one question per screen (F-EVAL-08, mockup 07).
 *
 * ONE primary action, and it MOVES with the state of the question, because
 * the single thing to do on this screen is not the same before and after
 * F-LIVE-08's "done":
 *
 *   - the question is not done yet    -> "Mark as done", in the footer;
 *   - it is done and another question is reachable -> "Next";
 *   - it is done and nothing follows (the last question, or the only one)
 *     -> "Hand in", the button that was already in the bar, which simply
 *        lights up rather than moving: a second "Hand in" in the footer would
 *        put the same label twice on one screen, and this shell's own header
 *        comment already names "Hand in" as the accent of the page.
 *
 * Marking done is a STATE, not an action to press twice. Once it is set, the
 * screen says so with the "Done" badge beside the counter, and the footer
 * offers a named, secondary way back — "Reopen the question" — instead of a
 * primary-looking "Done ✓" whose click silently un-did it. Where the server
 * refuses to un-do (`forward_only`, a crossed milestone, a closed attempt)
 * nothing is offered at all: the hint line under the question is what says
 * why.
 *
 * A one-question evaluation has no navigation to draw: no progress strip
 * (the strip is a map of a paper that has one page) and no previous / next
 * buttons — absent, not disabled. Two dead controls are worse than none.
 *
 * What this component owns, beyond the layout:
 *   - the keyboard: `Alt + ←/→` moves, `Ctrl + Enter` marks the question as
 *     done. Alt and Ctrl, not bare arrows: every question type has a field,
 *     and a player that steals the arrow keys cannot be used to write;
 *   - the navigation rules, mirrored from the server (`playerReducer`), so a
 *     student is never offered a move the API would refuse with `409`;
 *   - the milestone confirmation of F-LIVE-08, which is the only
 *     irreversible thing on the screen.
 *
 * It never decides that the attempt is over: `useAttempt` does, from a `410`
 * or from an `attempt.closed` frame, and then this renders `ClosedScreen`.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Home, School, Send } from "lucide-react";

import type { AttemptView } from "@quiz/contracts";
import type { RunnerOutcome } from "@quiz/core/server";
import { questionTypeClient } from "@quiz/registry/client";

import { useAttempt } from "../attempt/useAttempt";
import type { Command } from "../commands";
import { currentItem, isLocked, neighbour, type PlayerItem, type PlayerState } from "../attempt/playerReducer";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { useShortcuts } from "../shortcuts";
import { Badge, Button, Card, modKey, useMinWidth, type Segment } from "../ui";
import { ClosedScreen } from "./ClosedScreen";
import { OfflineBanner } from "./OfflineBanner";
import { PausedOverlay } from "./PausedOverlay";
import { PlayerShell } from "./PlayerShell";
import type { CodeAnswer, CodeRunOptions, CodeStudent } from "@quiz/qt-code/client";

import { api, ApiError } from "../api";
import { runCode } from "../runner/codeRun";
import { QuestionHost } from "./QuestionHost";
import { SubmitDialog } from "./SubmitDialog";

/**
 * The `circuit` player's "Simulate", which has no browser half: only the
 * server may turn a schematic into a SPICE netlist (invariant 14), so this is
 * one call and its answer is read here rather than by the package.
 *
 * Three of the four outcomes are not errors and must not read as one:
 * `503 runner_unavailable` is the default deployment (decision D14),
 * `429` is the per-attempt budget of N-SEC-07, and anything else is a real
 * failure the player shows in red.
 */
async function simulateCircuit(
  attemptId: string,
  itemId: string,
  answer: unknown,
): Promise<RunnerOutcome | "unavailable" | "rate_limited"> {
  try {
    return await api<RunnerOutcome>(`/app/api/attempts/${attemptId}/simulate`, {
      method: "POST",
      body: JSON.stringify({ itemId, answer }),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) return "unavailable";
    if (error instanceof ApiError && error.status === 429) return "rate_limited";
    throw error;
  }
}

/** "Has something been written here?" is the question TYPE's call, not ours. */
function isAnswered(item: PlayerItem, answer: unknown): boolean {
  try {
    return questionTypeClient(item.type).isAnswered(answer ?? null);
  } catch {
    return answer !== null && answer !== undefined;
  }
}

function segmentsOf(state: PlayerState): Segment[] {
  return state.items.map((item, index) => ({
    id: item.id,
    state:
      index === state.index
        ? "current"
        : item.markedDone
          ? "done"
          : isAnswered(item, state.answers[item.id] ?? null)
            ? "answered"
            : "empty",
  }));
}

export function Player({
  initial,
  onHome,
  onResults,
  onExitStudentView,
}: {
  initial: AttemptView;
  onHome: () => void;
  /** WP10: opens the student's own feedback on this attempt. */
  onResults: (attemptId: string) => void;
  /**
   * Given only to a TEACHER walking their own test attempt (ADR-018
   * addendum): the exam screen carries no teacher chrome — that is the point
   * of walking it — so the way out of the student view is one palette entry
   * rather than a button on a student's exam. A student never has it: the
   * switch is off, so `AttemptPage` passes nothing.
   */
  onExitStudentView?: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const attempt = useAttempt(initial.attempt.id, initial);
  const { state, dispatch, sync, now, deadlineAt, closed, paused, setAnswer, markDone, submit, run } =
    attempt;
  const [submitting, setSubmitting] = useState(false);
  const item = currentItem(state);
  const total = state.items.length;
  const locked = item ? isLocked(state, item.id) : true;
  const readOnly = locked || closed !== null || paused;
  // On a phone the three actions live in a sticky footer under the thumb;
  // on a desktop they sit right under the question, where the mouse already
  // is — a footer at the bottom of a 900 px window is a trip per question.
  // A hook, so it stays above the early returns below.
  const desktop = useMinWidth(640);
  const segments = useMemo(() => segmentsOf(state), [state]);
  const unanswered = state.items.filter(
    (i) => !isAnswered(i, state.answers[i.id] ?? null),
  ).length;

  const toggleDone = useCallback(async () => {
    // The same condition as the button, so `Ctrl+Enter` can never ask for
    // what the screen does not offer: un-marking in `forward_only` answers
    // `409 irreversible`, and the student would read it as a failure.
    if (!item || readOnly) return;
    const next = !item.markedDone;
    // F-LIVE-08: crossing a milestone closes everything behind it, so it is
    // the one move that asks first.
    if (next && state.navigation === "milestones" && item.milestone) {
      const ok = await confirm({
        title: t("player.markDone"),
        message: t("lobby.nav.milestones.body"),
        confirmLabel: t("player.markDone"),
      });
      if (!ok) return;
    }
    try {
      await markDone(item.id, next);
    } catch {
      toast(t("player.doneFailed"), "error");
    }
  }, [item, readOnly, state.navigation, confirm, t, markDone, toast]);

  // The two shortcuts of the DoD. `Alt` and `Ctrl` are held on purpose: the
  // bare keys belong to whatever field the student is typing in.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (submitting) return;
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        dispatch({ type: "move", delta: e.key === "ArrowRight" ? 1 : -1 });
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void toggleDone();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch, toggleDone, submitting]);

  // The same three, for the sidebar strip. The zen player runs outside the
  // Shell and therefore shows no strip of its own; registering them anyway
  // costs nothing and keeps the day the frame comes back one line of work.
  useShortcuts([
    // A one-question attempt has nowhere to move: offering the two arrows
    // would teach a shortcut that does nothing.
    ...(total > 1
      ? [
          { keys: "Alt+←", label: t("player.command.prev") },
          { keys: "Alt+→", label: t("player.command.next") },
        ]
      : []),
    { keys: `${modKey()}+Enter`, label: t("player.markDone") },
  ]);

  if (closed !== null) {
    return (
      <ClosedScreen
        reason={closed.reason}
        title={initial.evaluation.title}
        onHome={onHome}
        // A teacher preview has no attempt of its own, so there is nothing
        // to show them; every real attempt has a feedback page (WP10).
        {...(initial.attempt.preview ? {} : { onResults: () => onResults(initial.attempt.id) })}
      />
    );
  }

  const previous = neighbour(state, -1);
  const next = neighbour(state, 1);
  /*
   * What `Ctrl+K` offers during an attempt (W15). Deliberately short: an exam
   * is the one screen the rest of the app must stay out of, so there is no
   * navigation, no theme, no help — only the four moves the footer and the
   * bar already carry, for a student who reaches for the keyboard first.
   * Built here rather than in `commands.ts`, which knows nothing of an
   * attempt and should not learn.
   */
  const commands: Command[] = [
    {
      id: "player:submit",
      label: t("player.command.submit"),
      icon: Send,
      group: "action",
      run: () => setSubmitting(true),
    },
    ...(next !== null
      ? [
          {
            id: "player:next",
            label: t("player.command.next"),
            icon: ChevronRight,
            group: "action" as const,
            run: () => dispatch({ type: "move", delta: 1 }),
          },
        ]
      : []),
    ...(previous !== null
      ? [
          {
            id: "player:prev",
            label: t("player.command.prev"),
            icon: ChevronLeft,
            group: "action" as const,
            run: () => dispatch({ type: "move", delta: -1 }),
          },
        ]
      : []),
    {
      id: "player:home",
      label: t("player.command.home"),
      icon: Home,
      group: "navigate",
      run: onHome,
    },
    ...(onExitStudentView
      ? [
          {
            id: "player:teacher-view",
            label: t("menu.teacherView"),
            icon: School,
            group: "navigate" as const,
            run: onExitStudentView,
          },
        ]
      : []),
  ];
  // Only a rule worth reading under the question: a locked question, or an
  // irreversible "done". That answers are saved as one types is said once,
  // in the lobby, and the free player stays bare.
  const hint = locked
    ? t("player.hint.locked")
    : state.navigation === "free"
      ? null
      : t("player.hint.forward");
  /*
   * Who wears the accent, and therefore what the other two tiers are. The
   * order matters: as long as the question is open, the thing to do is to
   * close it; once it is closed, the thing to do is to leave it, and there is
   * only one way out of the last question.
   */
  const done = item?.markedDone === true;
  const handInIsPrimary = done && next === null;
  const nextIsPrimary = done && next !== null;
  // Un-marking is offered exactly where the server accepts it (`free`, and a
  // milestone not yet crossed). In `forward_only` there is nothing to press.
  const canReopen = done && !readOnly;
  // A single question has no neighbours to walk to: the two buttons are
  // absent rather than disabled, and so is the strip above (F-LIVE-09 draws
  // the questions, and one question is not a progression).
  const manyItems = total > 1;
  const centre = !done ? (
    <Button variant="primary" onClick={() => void toggleDone()} disabled={readOnly}>
      {t("player.markDone")}
    </Button>
  ) : canReopen ? (
    // Secondary, named for what it does, and with no tick: the button that
    // used to sit here read "Done ✓" in the primary style and un-did the
    // question when pressed.
    <Button variant="secondary" onClick={() => void toggleDone()}>
      {t("player.reopen")}
    </Button>
  ) : null;
  // Nothing to show at all — a one-question `forward_only` attempt, once the
  // question is handed over — means no footer bar, not an empty one.
  const actions =
    !manyItems && centre === null ? null : (
      <>
        {manyItems ? (
          <Button
            variant="secondary"
            onClick={() => dispatch({ type: "move", delta: -1 })}
            disabled={previous === null}
          >
            <ChevronLeft className="size-4" aria-hidden />
            {t("player.prev")}
          </Button>
        ) : null}
        <div className="flex-1" />
        {centre}
        <div className="flex-1" />
        {manyItems ? (
          <Button
            variant={nextIsPrimary ? "primary" : "secondary"}
            onClick={() => dispatch({ type: "move", delta: 1 })}
            disabled={next === null}
          >
            {t("player.next")}
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        ) : null}
      </>
    );

  return (
    <>
      <PlayerShell
        title={initial.evaluation.title}
        deadlineAt={deadlineAt}
        now={now}
        paused={paused}
        sync={sync}
        segments={manyItems ? segments : []}
        onSelectSegment={(itemId) => dispatch({ type: "goto", itemId })}
        progressLabel={t("player.progress", { n: state.index + 1, total })}
        commands={commands}
        headerAction={
          <Button
            variant={handInIsPrimary ? "primary" : "secondary"}
            size="sm"
            onClick={() => setSubmitting(true)}
          >
            {t("player.finish")}
          </Button>
        }
        banner={<OfflineBanner show={sync === "offline"} />}
        {...(desktop ? {} : { footer: actions })}
      >
        {item ? (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
              {/* Not a heading: "Question 2 of 4" names a position, not a
                  section, and as an `h1` it renamed the document on every
                  move (W5). It is announced instead — politely, because the
                  student is reading, not waiting. */}
              <p
                aria-live="polite"
                className="text-[13px] font-semibold uppercase tracking-wide text-fg-muted"
              >
                {/* "Question 2", not "2 of 4": the strip above already counts,
                    and one question per page needs no second counter. */}
                {t("player.question", { n: state.index + 1 })}
              </p>
              {item.markedDone ? (
                <Badge tone="green" icon={Check}>
                  {t("player.markedDone")}
                </Badge>
              ) : null}
              <span className="ml-auto text-[13px] text-fg-muted">
                {item.points === 1 ? t("player.point") : t("player.points", { n: item.points })}
              </span>
            </div>
            <Card className="p-5 sm:p-6">
              <QuestionHost
                key={item.id}
                type={item.type}
                student={item.student}
                answer={state.answers[item.id] ?? null}
                onChange={(payload) => setAnswer(item.id, payload)}
                readOnly={readOnly}
                {...(item.type === "code"
                  ? {
                      // `POST /attempts/:id/run` takes a free stdin and a
                      // command line, and so does the browser runner: the box
                      // is offered whichever one ends up serving it.
                      allowManualRun: true,
                      onRun: (answer: unknown, options?: unknown) =>
                        runCode({
                          student: item.student as CodeStudent,
                          answer: answer as CodeAnswer,
                          // The backend path is the API call it always was.
                          backend: (_request, manual) =>
                            run(item.id, (answer as { regions?: string[] }).regions ?? [], manual),
                          options: options as CodeRunOptions | undefined,
                        }),
                    }
                  : {})}
                {...(item.type === "circuit"
                  ? {
                      onSimulate: (answer: unknown) =>
                        simulateCircuit(initial.attempt.id, item.id, answer),
                    }
                  : {})}
              />
            </Card>
            {desktop && actions ? (
              <div className="mt-4 flex flex-wrap items-center gap-2">{actions}</div>
            ) : null}
            {hint ? (
              <p className="mt-3 text-[13px] leading-relaxed text-fg-muted">{hint}</p>
            ) : null}
          </>
        ) : null}
      </PlayerShell>
      <PausedOverlay show={paused} />
      <SubmitDialog
        open={submitting}
        unanswered={unanswered}
        onCancel={() => setSubmitting(false)}
        onConfirm={async () => {
          try {
            await submit();
          } catch {
            toast(t("player.submitFailed"), "error");
          } finally {
            setSubmitting(false);
          }
        }}
      />
    </>
  );
}
