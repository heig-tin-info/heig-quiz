/**
 * The "zen" player: one question per screen (F-EVAL-08, mockup 07).
 *
 * The single primary action is "Mark as done". Everything else is one tier
 * below: previous / next are secondary, handing in is a secondary button in
 * the bar (its confirmation is where the weight belongs), and the progress
 * strip is navigation, not an action.
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
import { Check, ChevronLeft, ChevronRight, Home, Send } from "lucide-react";

import type { AttemptView } from "@quiz/contracts";
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

import { runCode } from "../runner/codeRun";
import { QuestionHost } from "./QuestionHost";
import { SubmitDialog } from "./SubmitDialog";

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
}: {
  initial: AttemptView;
  onHome: () => void;
  /** WP10: opens the student's own feedback on this attempt. */
  onResults: (attemptId: string) => void;
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
    if (!item || closed !== null || paused) return;
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
  }, [item, closed, paused, state.navigation, confirm, t, markDone, toast]);

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
    { keys: "Alt+←", label: t("player.command.prev") },
    { keys: "Alt+→", label: t("player.command.next") },
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
  ];
  // Only a rule worth reading under the question: a locked question, or an
  // irreversible "done". That answers are saved as one types is said once,
  // in the lobby, and the free player stays bare.
  const hint = locked
    ? t("player.hint.locked")
    : state.navigation === "free"
      ? null
      : t("player.hint.forward");
  const actions = (
    <>
      <Button
        variant="secondary"
        onClick={() => dispatch({ type: "move", delta: -1 })}
        disabled={previous === null}
      >
        <ChevronLeft className="size-4" aria-hidden />
        {t("player.prev")}
      </Button>
      <div className="flex-1" />
      <Button
        variant={item?.markedDone ? "secondary" : "primary"}
        onClick={() => void toggleDone()}
        // A locked question cannot be un-marked: the server answers
        // `409 irreversible`, so the button must not offer it.
        disabled={readOnly}
      >
        {item?.markedDone ? <Check className="size-4" aria-hidden /> : null}
        {item?.markedDone ? t("player.markedDone") : t("player.markDone")}
      </Button>
      <div className="flex-1" />
      <Button
        variant="secondary"
        onClick={() => dispatch({ type: "move", delta: 1 })}
        disabled={next === null}
      >
        {t("player.next")}
        <ChevronRight className="size-4" aria-hidden />
      </Button>
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
        segments={segments}
        onSelectSegment={(itemId) => dispatch({ type: "goto", itemId })}
        progressLabel={t("player.progress", { n: state.index + 1, total })}
        commands={commands}
        headerAction={
          <Button variant="secondary" size="sm" onClick={() => setSubmitting(true)}>
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
              />
            </Card>
            {desktop ? (
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
