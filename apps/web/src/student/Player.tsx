/**
 * The "zen" player: one question per screen (F-EVAL-08, mockup 07).
 *
 * A question is ANSWERED as soon as it holds an answer — the type says what
 * an empty one is (`isAnswered`) — with no click (issue #89, F-LIVE-08). What
 * the student can set by hand is what the answer alone cannot say:
 *
 *   - "Leave unanswered", on an EMPTY question: settled on purpose, left
 *     blank. A toggle: pressing it again — or writing an answer — takes it
 *     back;
 *   - the review FLAG, a toggle: a note to self, shown in the question list
 *     and on the teacher's grid, no effect on the grade;
 *   - "Clear", for MULTIPLE CHOICE only (the other types are emptied by
 *     hand): with negative points, withdrawing a selection must be possible.
 *
 * The flag belongs to the question, so it is an icon in the corner of its
 * card; the other two belong to the answer, and are one neutral chip under
 * it (issue #128): outlined so it reads as a button, pressed in `fg` rather
 * than the accent — a tool, not the page's action.
 * ONE primary action, and it moves with the question:
 *
 *   - where the navigation asks for it — every question in `forward_only`, a
 *     checkpoint in `milestones` — "Validate and continue", the one
 *     irreversible thing on the screen, behind a confirmation. On an empty
 *     question it reads "Leave blank and continue": the same step, named
 *     for what it closes;
 *   - otherwise, once the question is settled (answered or skipped), "Next",
 *     or "Hand in" on the last one — the button that is already in the bar,
 *     which lights up rather than being drawn twice;
 *   - on an unsettled question in `free`, none: the answer field IS the
 *     action, and an accent on "Next" would push past it.
 *
 * An item may carry the teacher's text before it (ADR-084): arriving on it
 * shows that passage in place of the question, and the one primary action
 * is then "Continue". Under `free` navigation "Read the text again" brings
 * it back; elsewhere Continue is one way (`passageOf`, `canReread`).
 *
 * A one-question evaluation has no navigation to draw: no progress strip
 * (the strip is a map of a paper that has one page) and no previous / next
 * buttons — absent, not disabled. Two dead controls are worse than none.
 *
 * What this component owns, beyond the layout, is the navigation rules,
 * mirrored from the server (`playerReducer`, and the shared `@quiz/domain`
 * rules), so a student is never offered a move the API would refuse with
 * `409`. What the buttons and the keyboard DO is `usePlayerControls`; the
 * question itself is `PlayerQuestion`, memoised — the countdown ticks in
 * its own leaf, so nothing here re-renders once a second.
 *
 * It never decides that the attempt is over: `useAttempt` does, from a `410`
 * or from an `attempt.closed` frame, and then this renders `PlayerEnd` — the
 * closed screen or, on an exercise that takes retakes, the way to the score,
 * where the student decides to try again (ADR-025 addendum, issue #121).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight, ShieldAlert } from "lucide-react";

import type { AttemptView } from "@quiz/contracts";
import { answerMark, calculatorOn, mayValidate } from "@quiz/domain";

import { postSimulate } from "../attempt/run";
import { useAttempt, type UseAttempt } from "../attempt/useAttempt";
import { CalculatorDock } from "../calculator/CalculatorDock";
import {
  canReread,
  currentItem,
  isLocked,
  neighbour,
  passageOf,
  segmentsOf,
} from "../attempt/playerReducer";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useLentCanvasShortcuts } from "../shortcuts";
import { Button, Card, Modal, useMinWidth } from "../ui";
import { ConditionsList } from "./ConditionsList";
import { ExpandChrome, type ExpandChromeValue } from "./ExpandLayer";
import { IntroPassage, RereadButton } from "./IntroPassage";
import { OfflineBanner } from "./OfflineBanner";
import { PausedOverlay, ScreenOverlay } from "./PausedOverlay";
import { useStationAttestation } from "../kiosk/useStationAttestation";
import { PlayerActions } from "./PlayerActions";
import { PlayerEnd } from "./PlayerEnd";
import { PlayerQuestion, QuestionHeading } from "./PlayerQuestion";
import { PlayerRail } from "./PlayerRail";
import { PlayerShell } from "./PlayerShell";
import { isAnswered, isWide } from "./QuestionHost";
import { FlagButton, QuestionTools } from "./QuestionTools";
import { SubmitDialog } from "./SubmitDialog";
import { usePlayerCommands } from "./usePlayerCommands";
import { usePlayerControls } from "./usePlayerControls";

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
  | "clock"
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
  /**
   * `POST …/simulate`: the `circuit` player's "Simulate", and the backend
   * half of a `codeimage` "Run" (ADR-019, ADR-021).
   */
  simulate: (itemId: string, answer: unknown) => ReturnType<typeof postSimulate>;
};

/**
 * How long Home waits for the pending answers (issue #125) before asking the
 * student whether to leave anyway: two autosave backoffs, and short enough
 * that a hung request never reads as a dead button.
 */
const LEAVE_FLUSH_TIMEOUT_MS = 6_000;

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
  station = false,
  seb = false,
}: {
  initial: AttemptView;
  onHome: () => void;
  /** WP10: opens the student's own feedback on this attempt. */
  onResults: OnResults;
  /** Sat on a kiosk station (ADR-051 §7): the end returns to the station's screen by itself. */
  station?: boolean;
  /** Sat in Safe Exam Browser (ADR-027): the end's one action is quitting it. */
  seb?: boolean;
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
  const confirm = useConfirm();
  const { flush, closed } = attempt;
  // Issue #125: leaving unmounts the player, and its autosave with it. An
  // answer still waiting for its debounce — or on its way — must reach the
  // server first. The wait is bounded (a request may never answer), and
  // when the answers are not all saved the student is ASKED, told why, with
  // Stay focused: leaving may lose them. The attempt stays in progress.
  const [leaving, setLeaving] = useState(false);
  const leavingRef = useRef(false);
  // Home, then the browser's Back within the wait: the player is gone, and
  // the app-level confirmation must not open on whatever page came next.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const leave = useCallback(async () => {
    // The end screen has nothing left to save, and says so itself.
    if (closed !== null) return onHome();
    if (leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        flush(),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), LEAVE_FLUSH_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timer);
      if (!mounted.current) return;
      if (result === "saved") return onHome();
      const ok = await confirm({
        title: t("player.leave.title"),
        message: t(
          result === "paused"
            ? "player.leave.paused"
            : result === "closed"
              ? "player.leave.closed"
              : "player.leave.unsaved",
        ),
        confirmLabel: t("player.leave.confirm"),
        cancelLabel: t("player.leave.stay"),
        focusCancel: true,
      });
      if (ok) onHome();
    } finally {
      leavingRef.current = false;
      if (mounted.current) setLeaving(false);
    }
  }, [closed, flush, onHome, confirm, t]);
  // Stable, like every callback the question receives: it is memoised.
  const simulate = useCallback(
    (itemId: string, answer: unknown) =>
      postSimulate(`/app/api/attempts/${attemptId}/simulate`, { itemId, answer }),
    [attemptId],
  );
  // ADR-051 §6: on a station, the page re-attests on its own, and before the submit.
  const attestation = useStationAttestation(station);
  const { submit } = attempt;
  const { guardSubmit } = attestation;
  const guardedSubmit = useCallback(() => guardSubmit(submit), [guardSubmit, submit]);
  const session = useMemo<PlayerSession>(
    () => ({ ...attempt, simulate, submit: guardedSubmit }),
    [attempt, simulate, guardedSubmit],
  );
  return (
    <>
      {/* ADR-051 §6: the station could not prove its integrity; its writes are refused. */}
      <ScreenOverlay
        show={attestation.suspended && closed === null}
        icon={ShieldAlert}
        title={t("player.suspended.title")}
        body={t("player.suspended.body")}
      />
      <PlayerView
        initial={initial}
        session={session}
        onHome={() => void leave()}
        homeBusy={leaving}
        onResults={onResults}
        station={station}
        seb={seb}
        {...(onExitStudentView ? { onExitStudentView } : {})}
      />
    </>
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
  homeLabel,
  tools,
  homeBusy = false,
  station = false,
  seb = false,
}: {
  initial: AttemptView;
  session: PlayerSession;
  onHome: () => void;
  /** Where Home leads, named; the student home by default. */
  homeLabel?: string;
  /** Leaving is under way (the answers are being sent): Home is disabled. */
  homeBusy?: boolean;
  /** Absent where there is no feedback page to open (the preview). */
  onResults?: OnResults;
  onExitStudentView?: () => void;
  /** Above the question, before the offline alert: the preview's own notices. */
  banner?: ReactNode;
  /**
   * The preview's tools for the question on screen (its points, its editor):
   * where the player says what a question is worth — the side column beside
   * the list, under the question otherwise.
   */
  tools?: ReactNode;
  /** Sat on a kiosk station: see {@link PlayerEnd}. */
  station?: boolean;
  /** Sat in Safe Exam Browser: see {@link PlayerEnd}. */
  seb?: boolean;
}) {
  const t = useT();
  const { state, dispatch, sync: saverSync, closed, paused } = session;
  // The question on screen may hold an edit it will not send (a field over
  // its limit, issue #267): the autosave has nothing pending, yet the text
  // on screen is not saved. The question keys this, and resets it on leaving.
  const [unsent, setUnsent] = useState(false);
  const [conditionsOpen, setConditionsOpen] = useState(false);
  // A focused canvas's keys (issue #549), shown in the side column only.
  const [canvasKeys, onCanvasShortcuts] = useLentCanvasShortcuts();
  const sync =
    unsent && (saverSync === "saved" || saverSync === "saving") ? "unsaved" : saverSync;
  const item = currentItem(state);
  // ADR-084: the teacher's text before the question, until Continue. While
  // it shows, the question — and everything that acts on it — waits.
  const passage = passageOf(state);
  const total = state.items.length;
  const locked = item ? isLocked(state, item.id) : true;
  const readOnly = locked || closed !== null || paused;
  // On a phone the three actions live in a sticky footer under the thumb;
  // on a desktop they sit right under the question, where the mouse already
  // is — a footer at the bottom of a 900 px window is a trip per question.
  // A hook, so it stays above the early return below.
  const desktop = useMinWidth(640);
  // Wider still, the question list and the points stand in a column beside
  // the question rather than over it.
  const railScreen = useMinWidth(1024);
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
    item !== undefined &&
    passage === null &&
    !readOnly &&
    !validated &&
    mayValidate(state.navigation, item);
  const controls = usePlayerControls({ session, item, readOnly, canValidate, blank: !answered });
  const move = useCallback((delta: 1 | -1) => dispatch({ type: "move", delta }), [dispatch]);

  const previous = neighbour(state, -1);
  const next = neighbour(state, 1);
  // The palette of the exam screen (W15): only what the footer and the bar
  // already carry.
  // The bar of a question's expand layer: the same clock and badge as the
  // shell's, through a context so the memoised question does not re-render.
  const chrome = useMemo<ExpandChromeValue>(
    () => ({ deadlineAt: session.deadlineAt, clock: session.clock, paused, sync }),
    [session.deadlineAt, session.clock, paused, sync],
  );
  const home = { onClick: onHome, label: homeLabel ?? t("player.command.home"), busy: homeBusy };
  // ADR-079: the conditions read before the start, reopenable at any time.
  const hasConditions = initial.conditions.announced.length + initial.conditions.imposed.length > 0;
  const openConditions = hasConditions ? () => setConditionsOpen(true) : undefined;
  const commands = usePlayerCommands({
    next,
    previous,
    onMove: move,
    onSubmit: controls.openSubmit,
    onHome,
    homeLabel: home.label,
    onConditions: openConditions,
    onExitStudentView,
  });

  if (closed !== null) {
    return (
      <PlayerEnd
        reason={closed.reason}
        initial={initial}
        onHome={onHome}
        onResults={onResults}
        station={station}
        seb={seb}
      />
    );
  }

  /*
   * Who wears the accent, and therefore what the other two tiers are. Where
   * the navigation asks for a validation, that is the thing to do; once the
   * question is settled, the thing to do is to leave it, and there is only
   * one way out of the last question.
   */
  const settled = mark !== "unanswered" || validated;
  const handInIsPrimary = passage === null && !canValidate && settled && next === null;
  // A single question has no neighbours to walk to: the two buttons are
  // absent rather than disabled, and so is the strip above (F-LIVE-09 draws
  // the questions, and one question is not a progression). Nothing to show
  // at all — one question, nothing to validate — means no bar, not an empty
  // one.
  const manyItems = total > 1;
  // One question has no list to stand beside it: the heading keeps the
  // points, as on a narrow screen.
  const rail = railScreen && manyItems && item !== undefined;
  const selectSegment = (itemId: string) => dispatch({ type: "goto", itemId });
  const progressLabel = t("player.progress", { n: state.index + 1, total });
  // ADR-069: the calculator the evaluation provides, for the whole attempt —
  // outside the keyed question, so its number survives a move.
  const calculator = calculatorOn(initial.evaluation.mode, initial.evaluation.settings.calculator);
  // The passage's one action stands where the question's go — the phone's
  // footer, under the text on a desktop — on the right, where Next would be.
  const actions =
    passage !== null && item ? (
      <>
        <div className="flex-1" />
        <Button variant="primary" onClick={() => dispatch({ type: "pass", itemId: item.id })}>
          {t("player.intro.continue")}
          <ChevronRight className="size-4" aria-hidden />
        </Button>
      </>
    ) : manyItems || canValidate ? (
      <PlayerActions
        manyItems={manyItems}
        canValidate={canValidate}
        validateLabel={controls.validateLabel}
        hasPrevious={previous !== null}
        hasNext={next !== null}
        nextIsPrimary={!canValidate && settled && next !== null}
        onValidate={() => void controls.validate()}
        onMove={move}
      />
    ) : null;

  return (
    <ExpandChrome.Provider value={chrome}>
      <PlayerShell
        title={initial.evaluation.title}
        deadlineAt={session.deadlineAt}
        clock={session.clock}
        paused={paused}
        {...(sync === undefined ? {} : { sync })}
        segments={manyItems ? segments : []}
        onSelectSegment={selectSegment}
        progressLabel={progressLabel}
        commands={commands}
        onConditions={openConditions}
        wide={item !== undefined && isWide(item.type)}
        // Issue #125: an exercise may be left and continued later; an exam
        // may not look like it can. The teacher's preview, exam or not, has
        // no clock to stop: its way out is the same quiet button.
        {...(initial.evaluation.mode === "exercise" || initial.attempt.preview
          ? { home }
          : {})}
        headerAction={
          <Button
            variant={handInIsPrimary ? "primary" : "secondary"}
            size="sm"
            onClick={controls.openSubmit}
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
        {...(canvasKeys === null ? {} : { asideShortcuts: canvasKeys })}
        {...(rail
          ? {
              aside: (
                <PlayerRail
                  segments={segments}
                  onSelect={selectSegment}
                  label={progressLabel}
                  // The passage is not the question: its points and the
                  // preview's tools for it wait for Continue (ADR-084).
                  {...(passage === null ? { points: item.points } : {})}
                >
                  {passage === null ? tools : null}
                </PlayerRail>
              ),
            }
          : {})}
      >
        {item && passage !== null ? (
          <>
            <IntroPassage
              source={passage}
              index={state.index}
              oneWay={state.navigation !== "free"}
            />
            {desktop && actions ? (
              <div className="mt-4 flex flex-wrap items-center gap-2">{actions}</div>
            ) : null}
          </>
        ) : item ? (
          <>
            <QuestionHeading
              index={state.index}
              {...(rail ? {} : { points: item.points })}
              bonus={item.bonus}
              validated={validated}
              mark={mark}
            />
            {canReread(state) ? (
              <div className="-mt-1 mb-2">
                <RereadButton onClick={() => dispatch({ type: "reread", itemId: item.id })} />
              </div>
            ) : null}
            {/* `flow-root` holds the floated flag: the statement's first
                lines wrap around it instead of running under it. */}
            <Card className="flow-root p-5 sm:p-6">
              <div className="float-right -mr-2 -mt-2 ml-2 sm:-mr-3 sm:-mt-3">
                <FlagButton
                  item={item}
                  readOnly={readOnly}
                  onFlag={() => void controls.toggleFlag()}
                />
              </div>
              <PlayerQuestion
                key={`${item.id}:${item.generation ?? 0}`}
                itemId={item.id}
                type={item.type}
                student={item.student}
                answer={state.answers[item.id] ?? null}
                readOnly={readOnly}
                setAnswer={session.setAnswer}
                run={session.run}
                simulate={session.simulate}
                onUnsent={setUnsent}
                onCanvasShortcuts={onCanvasShortcuts}
              />
            </Card>
            <QuestionTools
              item={item}
              answered={answered}
              readOnly={readOnly}
              canValidate={canValidate}
              onClear={controls.clear}
              onSkip={() => void controls.toggleSkip()}
            />
            {desktop && actions ? (
              <div className="mt-4 flex flex-wrap items-center gap-2">{actions}</div>
            ) : null}
            <PlayerHint
              locked={locked}
              canValidate={canValidate}
              validateLabel={controls.validateLabel}
              navigation={state.navigation}
            />
            {tools && !rail ? (
              // A hairline: under it is the teacher's, not the student's page.
              <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                {tools}
              </div>
            ) : null}
          </>
        ) : null}
        {calculator === "none" ? null : <CalculatorDock kind={calculator} />}
      </PlayerShell>
      {conditionsOpen ? (
        <Modal title={t("conditions.title")} scroll onClose={() => setConditionsOpen(false)}>
          <ConditionsList conditions={initial.conditions} />
        </Modal>
      ) : null}
      <PausedOverlay show={paused} />
      <SubmitDialog
        open={controls.submitting}
        unanswered={unanswered}
        onCancel={controls.cancelSubmit}
        onConfirm={controls.handIn}
      />
    </ExpandChrome.Provider>
  );
}

/**
 * Only a rule worth reading under the question: a locked question, or an
 * irreversible validation ahead. That answers are saved as one types is said
 * once, in the lobby, and the free player stays bare.
 */
function PlayerHint({
  locked,
  canValidate,
  validateLabel,
  navigation,
}: {
  locked: boolean;
  canValidate: boolean;
  validateLabel: string;
  navigation: PlayerSession["state"]["navigation"];
}) {
  const t = useT();
  const hint = locked
    ? t("player.hint.locked")
    : !canValidate
      ? null
      : navigation === "milestones"
        ? t("player.hint.milestone")
        : t("player.hint.forward", { action: validateLabel });
  return hint ? <p className="mt-3 text-[13px] leading-relaxed text-fg-muted">{hint}</p> : null;
}
