/**
 * The "zen" player: one question per screen (F-EVAL-08, mockup 07).
 *
 * A question is ANSWERED as soon as it holds an answer — the type says what
 * an empty one is (`isAnswered`) — with no click (issue #89, F-LIVE-08). What
 * the student can set by hand is what the answer alone cannot say:
 *
 *   - "I won't answer this question", on an EMPTY question: settled on
 *     purpose, left blank. Writing an answer takes it back, and so does the
 *     secondary "Answer it after all";
 *   - the review FLAG, a toggle beside the points: a note to self, shown in
 *     the question list and on the teacher's grid, no effect on the grade;
 *   - "Clear", for MULTIPLE CHOICE only (the other types are emptied by
 *     hand): with negative points, withdrawing a selection must be possible.
 *
 * Those three are one line of quiet buttons under the question — tools, not
 * the page's action. ONE primary action, and it moves with the question:
 *
 *   - where the navigation asks for it — every question in `forward_only`, a
 *     checkpoint in `milestones` — "Validate and continue", the one
 *     irreversible thing on the screen, behind a confirmation;
 *   - otherwise, once the question is settled (answered or skipped), "Next",
 *     or "Hand in" on the last one — the button that is already in the bar,
 *     which lights up rather than being drawn twice;
 *   - on an unsettled question in `free`, none: the answer field IS the
 *     action, and an accent on "Next" would push past it.
 *
 * A one-question evaluation has no navigation to draw: no progress strip
 * (the strip is a map of a paper that has one page) and no previous / next
 * buttons — absent, not disabled. Two dead controls are worse than none.
 *
 * What this component owns, beyond the layout:
 *   - the keyboard: `Alt + ←/→` moves, `Ctrl + Enter` validates where
 *     validating exists. Alt and Ctrl, not bare arrows: every question type
 *     has a field, and a player that steals the arrow keys cannot be used to
 *     write;
 *   - the navigation rules, mirrored from the server (`playerReducer`, and
 *     the shared `@quiz/domain` rules), so a student is never offered a move
 *     the API would refuse with `409`.
 *
 * It never decides that the attempt is over: `useAttempt` does, from a `410`
 * or from an `attempt.closed` frame, and then this renders `ClosedScreen` —
 * or, on an exercise that takes retakes, forwards to the score, where the
 * student decides to try again (ADR-025 addendum, issue #121).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Flag, Lock, Minus } from "lucide-react";

import { retakesOf, type AttemptView } from "@quiz/contracts";
import { answerMark, mayValidate, maySkip, retakesOn } from "@quiz/domain";
import type { RunnerOutcome } from "@quiz/core/server";

import { UnsavedAnswer, useAttempt, type UseAttempt } from "../attempt/useAttempt";
import { currentItem, isLocked, neighbour, segmentsOf } from "../attempt/playerReducer";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { useShortcuts } from "../shortcuts";
import { Badge, Button, Card, cx, modKey, Spinner, useMinWidth } from "../ui";
import { ClosedScreen } from "./ClosedScreen";
import { OfflineBanner } from "./OfflineBanner";
import { PausedOverlay } from "./PausedOverlay";
import { PlayerActions } from "./PlayerActions";
import { PlayerShell } from "./PlayerShell";
import type {
  CodeAnswer,
  CodeImageAnswer,
  CodeImageStudent,
  CodeRunOptions,
  CodeRunStage,
  CodeStudent,
} from "@quiz/qt-code/client";

import { api, ApiError } from "../api";
import { runCode, runCodeImage } from "../runner/codeRun";
import { emptyAnswerOf, isAnswered, QuestionHost } from "./QuestionHost";
import { SubmitDialog } from "./SubmitDialog";
import { usePlayerCommands } from "./usePlayerCommands";

/**
 * `POST /attempts/:id/simulate`: the student's own button of a type that
 * builds its own request (ADR-019) — the `circuit` player's "Simulate", and
 * the backend half of a `codeimage` "Run" (ADR-021).
 *
 * For a circuit it is the only path: only the server may turn a schematic
 * into a SPICE netlist (invariant 14), so this is one call and its answer is
 * read here rather than by the package.
 *
 * Three of the four outcomes are not errors and must not read as one:
 * `503 runner_unavailable` is the default deployment (decision D14),
 * `429` is the per-attempt budget of N-SEC-07, and anything else is a real
 * failure the player shows in red.
 */
async function simulateAnswer(
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

/**
 * What the player drives: the attempt hook's state and actions, plus the one
 * button that is not an attempt call in every context (Simulate). `useAttempt`
 * is the real one; the teacher's stateless preview of an evaluation
 * (`preview/usePreviewSession.ts`, issue #75) is the other, which keeps its
 * answers in the browser and grades them in one call — so the SAME screen
 * renders both, and a preview cannot look different from the exam.
 */
export type PlayerSession = Pick<
  UseAttempt,
  | "state"
  | "dispatch"
  | "now"
  | "deadlineAt"
  | "closed"
  | "paused"
  | "setAnswer"
  | "markDone"
  | "skip"
  | "flag"
  | "submit"
  | "run"
> & {
  /** Absent when nothing is saved as one types (the preview): no badge at all. */
  sync?: UseAttempt["sync"];
  simulate: (itemId: string, answer: unknown) => ReturnType<typeof simulateAnswer>;
};

/**
 * Opens the student's feedback on an attempt. `replace` when the player sends
 * the student there by itself, so Back does not land on a player that would
 * only forward again.
 */
export type OnResults = (attemptId: string, options?: { replace?: boolean }) => void;

export function Player({
  initial,
  onHome,
  onResults,
  onExitStudentView,
}: {
  initial: AttemptView;
  onHome: () => void;
  /** WP10: opens the student's own feedback on this attempt. */
  onResults: OnResults;
  /**
   * Given only to a TEACHER walking their own test attempt (ADR-018
   * addendum): the exam screen carries no teacher chrome — that is the point
   * of walking it — so the way out of the student view is one palette entry
   * rather than a button on a student's exam. A student never has it: the
   * switch is off, so `AttemptPage` passes nothing.
   */
  onExitStudentView?: () => void;
}) {
  const attempt = useAttempt(initial.attempt.id, initial);
  const attemptId = initial.attempt.id;
  const t = useT();
  const toast = useToast();
  const { flush } = attempt;
  // Issue #125: leaving unmounts the player, and its autosave with it. An
  // answer still waiting for its debounce — or on its way — must reach the
  // server first; if it cannot, the student stays, told why, rather than
  // leaving an answer behind. The attempt itself stays in progress.
  const leave = useCallback(async () => {
    if (await flush()) onHome();
    else toast(t("player.leaveUnsaved"), "error");
  }, [flush, onHome, toast, t]);
  const session = useMemo<PlayerSession>(
    () => ({
      ...attempt,
      simulate: (itemId: string, answer: unknown) => simulateAnswer(attemptId, itemId, answer),
    }),
    [attempt, attemptId],
  );
  return (
    <PlayerView
      initial={initial}
      session={session}
      onHome={() => void leave()}
      onResults={onResults}
      {...(onExitStudentView ? { onExitStudentView } : {})}
    />
  );
}

/** The screen itself, for whichever {@link PlayerSession} drives it. */
export function PlayerView({
  initial,
  session,
  onHome,
  onResults,
  onExitStudentView,
  banner,
}: {
  initial: AttemptView;
  session: PlayerSession;
  onHome: () => void;
  /** Absent where there is no feedback page to open (the preview). */
  onResults?: OnResults;
  onExitStudentView?: () => void;
  /** Above the question, before the offline alert: the preview's own banner. */
  banner?: ReactNode;
}) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const {
    state,
    dispatch,
    sync,
    now,
    deadlineAt,
    closed,
    paused,
    setAnswer,
    markDone,
    skip,
    flag,
    submit,
    run,
  } = session;
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
  const segments = useMemo(() => segmentsOf(state, isAnswered), [state]);
  const unanswered = state.items.filter(
    (i) => !isAnswered(i.type, state.answers[i.id] ?? null),
  ).length;

  const answered = item ? isAnswered(item.type, state.answers[item.id] ?? null) : false;
  const mark = answerMark({ answered, skipped: item?.skipped ?? false });
  const validated = item?.markedDone === true;
  // "Validate and continue" exists where the navigation locks (F-LIVE-08),
  // and is offered while it can still be pressed.
  const canValidate =
    item !== undefined && !readOnly && !validated && mayValidate(state.navigation, item);

  const validate = useCallback(async () => {
    // The same condition as the button, so `Ctrl+Enter` can never ask for
    // what the screen does not offer.
    if (!item || !canValidate) return;
    // Irreversible, so it asks first: in `forward_only` the question closes
    // for good, at a checkpoint everything before it does too.
    const ok = await confirm({
      title: t("player.validate.title"),
      message:
        state.navigation === "milestones"
          ? t("lobby.nav.milestones.body")
          : t("player.validate.body"),
      confirmLabel: t("player.validate"),
      // Irreversible: Enter right after Ctrl+Enter must not validate for good.
      focusCancel: true,
    });
    if (!ok) return;
    try {
      await markDone(item.id, true);
    } catch (error) {
      toast(
        t(error instanceof UnsavedAnswer ? "player.validateUnsaved" : "player.validateFailed"),
        "error",
      );
    }
  }, [item, canValidate, state.navigation, confirm, t, markDone, toast]);

  const toggleSkip = useCallback(async () => {
    if (!item || readOnly) return;
    try {
      await skip(item.id, !item.skipped);
    } catch {
      toast(t("player.saveFailed"), "error");
    }
  }, [item, readOnly, skip, toast, t]);

  const toggleFlag = useCallback(async () => {
    if (!item || readOnly) return;
    try {
      await flag(item.id, !item.flagged);
    } catch {
      toast(t("player.saveFailed"), "error");
    }
  }, [item, readOnly, flag, toast, t]);

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
        void validate();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch, validate, submitting]);

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
    // Only where there is something to validate: a shortcut that does
    // nothing on this paper is one the student learns for nothing.
    ...(state.navigation === "free"
      ? []
      : [{ keys: `${modKey()}+Enter`, label: t("player.validate") }]),
  ]);

  const previous = neighbour(state, -1);
  const next = neighbour(state, 1);
  // The palette of the exam screen (W15): only what the footer and the bar
  // already carry.
  /*
   * F-EVAL-15 (issues #121, ADR-025): on an exercise that takes retakes, the
   * end of an attempt — handed in, or its time up — opens the score at once.
   * The hand-in screen's "your answers are with your teacher" is wrong there:
   * the student reads the score now and decides whether to try again, and
   * that page carries the Retake. A teacher's close is not such an end (no
   * retake follows it), and an exam keeps its hand-in screen.
   */
  const retakes =
    !initial.attempt.preview &&
    retakesOn(initial.evaluation.mode, retakesOf(initial.evaluation.settings));
  const toResults =
    retakes &&
    onResults !== undefined &&
    (closed?.reason === "submitted" || closed?.reason === "deadline");
  const forwarded = useRef(false);
  useEffect(() => {
    if (!toResults || forwarded.current) return;
    forwarded.current = true;
    onResults(initial.attempt.id, { replace: true });
  }, [toResults, onResults, initial.attempt.id]);

  const commands = usePlayerCommands({
    next,
    previous,
    onMove: (delta) => dispatch({ type: "move", delta }),
    onSubmit: () => setSubmitting(true),
    onHome,
    onExitStudentView,
  });

  if (closed !== null) {
    if (toResults) return <Spinner label={t("player.loading")} className="py-24" />;
    return (
      <ClosedScreen
        reason={closed.reason}
        title={initial.evaluation.title}
        onHome={onHome}
        // A teacher preview has no attempt of its own, so there is nothing
        // to show them; every real attempt has a feedback page (WP10).
        {...(initial.attempt.preview || !onResults
          ? {}
          : { onResults: () => onResults(initial.attempt.id) })}
      />
    );
  }

  // Only a rule worth reading under the question: a locked question, or an
  // irreversible validation ahead. That answers are saved as one types is
  // said once, in the lobby, and the free player stays bare.
  const hint = locked
    ? t("player.hint.locked")
    : canValidate
      ? state.navigation === "milestones"
        ? t("player.hint.milestone")
        : t("player.hint.forward")
      : null;
  /*
   * Who wears the accent, and therefore what the other two tiers are. Where
   * the navigation asks for a validation, that is the thing to do; once the
   * question is settled, the thing to do is to leave it, and there is only
   * one way out of the last question.
   */
  const settled = mark !== "unanswered" || validated;
  const handInIsPrimary = !canValidate && settled && next === null;
  const nextIsPrimary = !canValidate && settled && next !== null;
  // A single question has no neighbours to walk to: the two buttons are
  // absent rather than disabled, and so is the strip above (F-LIVE-09 draws
  // the questions, and one question is not a progression).
  const manyItems = total > 1;
  // Nothing to show at all — one question, nothing to validate — means no
  // footer bar, not an empty one.
  const actions =
    manyItems || canValidate ? (
      <PlayerActions
        manyItems={manyItems}
        canValidate={canValidate}
        hasPrevious={previous !== null}
        hasNext={next !== null}
        nextIsPrimary={nextIsPrimary}
        onValidate={() => void validate()}
        onMove={(delta) => dispatch({ type: "move", delta })}
      />
    ) : null;
  // The one tool of the answer, beside the flag: exactly one of the three
  // can apply at a time, because they read the same two facts.
  const clearable = item?.type === "mcq" && answered && !readOnly;
  const skippable = item !== undefined && !readOnly && maySkip({ answered });
  const tool = clearable ? (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        if (!item) return;
        setAnswer(item.id, emptyAnswerOf(item.type, item.student), false);
      }}
    >
      {t("player.clear")}
    </Button>
  ) : skippable ? (
    <Button variant="ghost" size="sm" onClick={() => void toggleSkip()}>
      {item?.skipped ? t("player.unskip") : t("player.skip")}
    </Button>
  ) : null;

  return (
    <>
      <PlayerShell
        title={initial.evaluation.title}
        deadlineAt={deadlineAt}
        now={now}
        paused={paused}
        {...(sync === undefined ? {} : { sync })}
        segments={manyItems ? segments : []}
        onSelectSegment={(itemId) => dispatch({ type: "goto", itemId })}
        progressLabel={t("player.progress", { n: state.index + 1, total })}
        commands={commands}
        // Issue #125: an exercise may be left and continued later; an exam
        // may not look like it can. The preview is a tab of its own.
        {...(initial.evaluation.mode === "exercise" && !initial.attempt.preview
          ? { onHome }
          : {})}
        headerAction={
          <Button
            variant={handInIsPrimary ? "primary" : "secondary"}
            size="sm"
            onClick={() => setSubmitting(true)}
          >
            {t("player.finish")}
          </Button>
        }
        banner={
          <>
            {banner}
            <OfflineBanner show={sync === "offline"} />
          </>
        }
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
              {/* The state of the question in a word AND a symbol, the
                  same symbols as the list above. Nothing for "not answered
                  yet": that is what a question is until it is not. */}
              {validated ? (
                <Badge tone="zinc" icon={Lock}>
                  {t("player.validated")}
                </Badge>
              ) : mark === "answered" ? (
                <Badge tone="zinc" icon={Check}>
                  {t("player.answered")}
                </Badge>
              ) : mark === "skipped" ? (
                <Badge tone="zinc" icon={Minus}>
                  {t("player.skipped")}
                </Badge>
              ) : null}
              <span className="ml-auto text-[13px] text-fg-muted">
                {item.points === 1 ? t("player.point") : t("player.points", { n: item.points })}
              </span>
              {readOnly && !item.flagged ? null : (
                // The word hides on a phone, where it would take a line of
                // its own; the name stays, and so does the pressed state.
                <Button
                  variant="ghost"
                  size="sm"
                  aria-pressed={item.flagged}
                  aria-label={item.flagged ? t("player.flagged") : t("player.flag")}
                  title={item.flagged ? t("player.flagged") : t("player.flag")}
                  disabled={readOnly}
                  onClick={() => void toggleFlag()}
                  className={cx("-mr-2", item.flagged && "!text-warning")}
                >
                  <Flag className={cx("size-3.5", item.flagged && "fill-current")} aria-hidden />
                  <span className="hidden sm:inline">
                    {item.flagged ? t("player.flagged") : t("player.flag")}
                  </span>
                </Button>
              )}
            </div>
            <Card className="p-5 sm:p-6">
              <QuestionHost
                key={item.id}
                type={item.type}
                student={item.student}
                answer={state.answers[item.id] ?? null}
                onChange={(payload) =>
                  setAnswer(item.id, payload, isAnswered(item.type, payload))
                }
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
                          // The backend path is the API call it always was. It
                          // sends the regions and, if there is one, the free
                          // input or the compile-only flag: the program itself
                          // is rebuilt server-side (invariant 14).
                          backend: (manual, backendOptions) =>
                            run(
                              item.id,
                              (answer as { regions?: string[] }).regions ?? [],
                              manual,
                              backendOptions,
                            ),
                          options: options as CodeRunOptions | undefined,
                        }),
                    }
                  : {})}
                {...(item.type === "circuit"
                  ? {
                      onSimulate: (answer: unknown) => session.simulate(item.id, answer),
                    }
                  : {})}
                {...(item.type === "codeimage"
                  ? {
                      // Where it runs is `code`'s rule (ADR-015): the browser
                      // for `runtime: "runno"`, else the server, which
                      // rebuilds the program from the stored template
                      // (invariant 14) behind the generic simulate route.
                      onRun: (answer: unknown, options?: unknown) =>
                        runCodeImage({
                          student: item.student as CodeImageStudent,
                          answer: answer as CodeImageAnswer,
                          backend: () => session.simulate(item.id, answer),
                          options: options as
                            | { onStage?: (stage: CodeRunStage) => void }
                            | undefined,
                        }),
                    }
                  : {})}
              />
            </Card>
            {/* `-ml-3`: the ghost button's own padding, so its word lines
                up with the card's edge rather than floating off it. */}
            {tool ? <div className="-ml-3 mt-2 flex items-center">{tool}</div> : null}
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
