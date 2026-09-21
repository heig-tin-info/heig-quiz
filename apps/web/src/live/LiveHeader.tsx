import { ClipboardCheck, Clock, Maximize2, Minimize2, Pause, Play, Square } from "lucide-react";

import type { EvaluationState } from "@quiz/contracts";

import { isGraded, stateLabel, stateTone } from "../evaluation/common";
import { useT } from "../i18n";
import { Badge, Button, Countdown, IconButton, Menu, PageHeader } from "../ui";

/**
 * The band a teacher watches from the back of the room: where we are, how
 * long is left, and the three things they will actually press.
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
}

export function LiveHeader({
  title,
  eyebrow,
  state,
  closesAt,
  now,
  controls,
  fullscreen,
  onToggleFullscreen,
  onGoToGrading,
}: {
  title: string;
  eyebrow?: React.ReactNode;
  state: EvaluationState;
  closesAt: string | null;
  /** Server time in epoch ms. */
  now: number;
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

  return (
    <PageHeader
      eyebrow={eyebrow}
      // The heading is the evaluation, and nothing else. The state badge and
      // the countdown used to live inside it, which made the document heading
      // read "Quiz 3 — pointeurs et tableaux running 11:58" and rewrite itself
      // every second (W6). They sit under it now, on the same line as each
      // other, where they are still the first thing the eye lands on.
      title={title}
      help="live"
      description={
        <span className="flex flex-wrap items-center gap-3">
          <Badge tone={stateTone(state)}>{stateLabel(state, t)}</Badge>
          {closesAt && live ? (
            <Countdown
              deadlineAt={Date.parse(closesAt)}
              now={now}
              paused={paused}
              className="text-[20px]"
            />
          ) : null}
        </span>
      }
      actions={
        <>
          {isGraded(state) ? (
            <Button onClick={onGoToGrading}>
              <ClipboardCheck /> {t("live.goToGrading")}
            </Button>
          ) : null}
          {lobby ? (
            <Button onClick={controls.start} loading={controls.busy}>
              <Play /> {t("live.start")}
            </Button>
          ) : null}
          {live ? (
            <>
              <Button variant="secondary" onClick={paused ? controls.resume : controls.pause}>
                {paused ? <Play /> : <Pause />} {paused ? t("live.resume") : t("live.pause")}
              </Button>
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
