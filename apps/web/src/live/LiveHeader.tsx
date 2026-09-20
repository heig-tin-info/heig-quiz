import { Clock, Maximize2, Minimize2, Pause, Play, Square } from "lucide-react";

import type { EvaluationState } from "@quiz/contracts";

import { stateLabel, stateTone } from "../evaluation/common";
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
}) {
  const t = useT();
  const running = state === "running";
  const paused = state === "paused";
  const lobby = state === "lobby" || state === "scheduled";
  const live = running || paused;

  return (
    <PageHeader
      eyebrow={eyebrow}
      title={
        <span className="flex flex-wrap items-baseline gap-3">
          {title}
          <Badge tone={stateTone(state)}>{stateLabel(state, t)}</Badge>
          {closesAt && live ? (
            <Countdown deadlineAt={Date.parse(closesAt)} now={now} className="text-[20px]" />
          ) : null}
        </span>
      }
      actions={
        <>
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
