import { ClipboardCheck, Clock, Maximize2, Minimize2, Pause, Play, Square } from "lucide-react";

import type { EvaluationState } from "@quiz/contracts";

import { evaluationStateLabel, isGraded, stateTone } from "../evaluation/common";
import { useT } from "../i18n";
import { Badge, Button, ClockCountdown, IconButton, Menu, PageHeader } from "../ui";

/**
 * The band a teacher watches from the back of the room: where we are, how
 * long is left — the big clock, right beside the controls that change it —
 * and the three things they will actually press.
 *
 * Exactly one primary action, and it changes with the state: in the waiting
 * room it is Start, and from the moment the class is working there is no
 * primary at all — pausing, extending and closing are all secondary, because
 * none of them is what the screen is FOR. Closing is the one destructive
 * action and goes through a confirmation, never a single click.
 *
 * Once the quiz is closed the primary comes back, and it is the correction:
 * the grid is a record at that point, and the teacher's next move is to grade
 * (WP10). There is nothing else to press here, so the squint test is safe.
 */
export interface LiveControls {
  start: () => void;
  pause: () => void;
  resume: () => void;
  close: () => void;
  extend: (minutes: 1 | 5 | 10) => void;
  busy: boolean;
  /**
   * Whether this evaluation may be paused at all: only an exam can
   * (glossary, §1: "the exercise mode skips lobby and paused"; the server
   * refuses the move with 409). Offering a button the server always refuses
   * is what made the pause look inert (#77).
   */
  canPause: boolean;
}

export function LiveHeader({
  title,
  eyebrow,
  state,
  closesAt,
  endPassed = false,
  clock,
  controls,
  fullscreen,
  onToggleFullscreen,
  onGoToGrading,
}: {
  title: string;
  eyebrow?: React.ReactNode;
  state: EvaluationState;
  closesAt: string | null;
  /**
   * In the waiting room, the common end has passed (#178): the server refuses
   * the start, and "+N min" — moved from now — is the way out.
   */
  endPassed?: boolean;
  /** Server time, stable; the countdown re-reads it on its own tick. */
  clock: () => number;
  controls: LiveControls;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  /** WP10: shown as the primary once the evaluation is closed. */
  onGoToGrading: () => void;
}) {
  const t = useT();
  const running = state === "running";
  const paused = state === "paused";
  const lobby = state === "lobby" || state === "scheduled";
  const live = running || paused;
  const extendMenu = (
    <Menu
      label={t("live.extend")}
      trigger={
        <Button variant="secondary">
          <Clock /> {t("live.extend")}
        </Button>
      }
      items={[
        {
          label: t("live.extendMinutes", { n: 1 }),
          description: t("live.extendAll"),
          onSelect: () => controls.extend(1),
        },
        {
          label: t("live.extendMinutes", { n: 5 }),
          onSelect: () => controls.extend(5),
        },
        {
          label: t("live.extendMinutes", { n: 10 }),
          onSelect: () => controls.extend(10),
        },
      ]}
    />
  );

  return (
    <PageHeader
      eyebrow={eyebrow}
      // The heading is the evaluation, and nothing else. The state badge and
      // the countdown used to live inside it, which made the document heading
      // read "Quiz 3 — pointeurs et tableaux running 11:58" and rewrite itself
      // every second (W6). The badge sits under it.
      title={title}
      help="live"
      description={<Badge tone={stateTone(state)}>{evaluationStateLabel(state, t)}</Badge>}
      actions={
        <>
          {/* The ONE clock of the screen (#227), big, beside the controls
              that act on it: the grid no longer repeats it on every row, and
              only a row whose deadline differs from this one shows its own.
              Read from the back of the room, so about 30 px and tabular; it
              keeps the paused state and the warning and danger tones of
              every countdown. No clock in the waiting room or once closed:
              there is no running window to count. */}
          {closesAt && live ? (
            <ClockCountdown
              deadlineAt={Date.parse(closesAt)}
              clock={clock}
              paused={paused}
              className="mr-2 text-[30px] leading-none [&_svg]:size-6"
            />
          ) : null}
          {isGraded(state) ? (
            <Button onClick={onGoToGrading}>
              <ClipboardCheck /> {t("live.goToGrading")}
            </Button>
          ) : null}
          {lobby && endPassed ? extendMenu : null}
          {lobby ? (
            <Button data-coach="live.start" onClick={controls.start} loading={controls.busy}>
              <Play /> {t("live.start")}
            </Button>
          ) : null}
          {live ? (
            <>
              {controls.canPause || paused ? (
                <Button
                  variant="secondary"
                  onClick={paused ? controls.resume : controls.pause}
                  loading={controls.busy}
                >
                  {paused ? <Play /> : <Pause />} {paused ? t("live.resume") : t("live.pause")}
                </Button>
              ) : null}
              {extendMenu}
              <Button variant="danger" onClick={controls.close}>
                <Square /> {t("live.closeAll")}
              </Button>
            </>
          ) : null}
          <IconButton
            label={fullscreen ? t("live.exitFullscreen") : t("live.fullscreen")}
            active={fullscreen}
            onClick={onToggleFullscreen}
          >
            {fullscreen ? <Minimize2 /> : <Maximize2 />}
          </IconButton>
        </>
      }
    />
  );
}
