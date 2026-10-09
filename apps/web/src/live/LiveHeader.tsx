import {
  BookCheck,
  ClipboardCheck,
  Clock,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Presentation,
  Square,
} from "lucide-react";

import type { EvaluationState } from "@quiz/contracts";
import { isEvaluationOver } from "@quiz/domain";

import { evaluationStateLabel, stateTone } from "../evaluation/common";
import { useT } from "../i18n";
import { Actions, Badge, Button, ClockCountdown, IconButton, Menu, PageHeader } from "../ui";

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
 *
 * An exercise has one more thing a teacher may do while it runs, rarely:
 * publish its correction without closing it (ADR-050). It is tertiary, so it
 * lives in the overflow menu; once done, a badge beside the state says so and
 * the same menu offers the projection instead.
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

/** ADR-050: an exercise's correction, published while it runs. */
export interface CorrectionControls {
  published: boolean;
  publish: () => void;
  present: () => void;
}

export function LiveHeader({
  title,
  eyebrow,
  state,
  deadlineAt,
  endPassed = false,
  clock,
  controls,
  fullscreen,
  onToggleFullscreen,
  onGoToGrading,
  correction = null,
}: {
  title: string;
  eyebrow?: React.ReactNode;
  state: EvaluationState;
  /** The class's one clock (`commonDeadline`): the common close, or the shared start's deadline. */
  deadlineAt: string | null;
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
  /** A running exercise's only (ADR-050); `null` wherever the server refuses it. */
  correction?: CorrectionControls | null;
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
      description={
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <Badge tone={stateTone(state)}>{evaluationStateLabel(state, t)}</Badge>
          {correction?.published ? (
            <Badge tone="zinc" icon={BookCheck}>
              {t("live.correction.published")}
            </Badge>
          ) : null}
        </span>
      }
      actions={
        <>
          {/* The ONE clock of the screen (#227), big, beside the controls
              that act on it: the grid no longer repeats it on every row, and
              only a row whose deadline differs from this one shows its own.
              Read from the back of the room, so about 30 px and tabular; it
              keeps the paused state and the warning and danger tones of
              every countdown. No clock in the waiting room or once closed:
              there is no running window to count. */}
          {deadlineAt && live ? (
            <ClockCountdown
              deadlineAt={Date.parse(deadlineAt)}
              clock={clock}
              paused={paused}
              className="mr-2 text-[30px] leading-none [&_svg]:size-6"
            />
          ) : null}
          {isEvaluationOver(state) ? (
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
          {correction ? (
            // One item, whichever: a menu all the same (`menu`), so the
            // header keeps its shape when the correction is published.
            <Actions
              menu
              label={t("common.actions")}
              items={[
                correction.published
                  ? {
                      label: t("live.correction.present"),
                      icon: Presentation,
                      onSelect: correction.present,
                    }
                  : {
                      label: t("live.correction.publish"),
                      description: t("live.correction.publish.desc"),
                      icon: BookCheck,
                      onSelect: correction.publish,
                    },
              ]}
            />
          ) : null}
          <IconButton
            label={fullscreen ? t("live.exitFullscreen") : t("live.fullscreen")}
            shortcut="F"
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
