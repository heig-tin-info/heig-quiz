import { Clock, MonitorPlay, Pause, Play, Square } from "lucide-react";

import type { EvaluationState } from "@quiz/contracts";

import type { Command } from "../commands";
import type { TFunction } from "../i18n";
import type { Route } from "../router";
import { useScreenCommands } from "../screenCommands";
import type { LiveControls } from "./LiveHeader";

/**
 * The contextual palette commands of PLAN-MVP §6.8: "start / pause / +5 min /
 * close, when the live screen is mounted".
 *
 * They are registered rather than declared in `buildCommands` because they
 * are the dashboard's, not the shell's: the shell has no way to know that a
 * quiz is running two components down, and threading a live-controls object
 * through the Shell to the palette would put a screen's mutations in the
 * frame of every page. Registration is what "contextual" means, and
 * `useScreenCommands` is the one mechanism for it.
 *
 * The array is rebuilt by every render and re-registered as it is, so the
 * state and the controls it closes over are the ones on screen — no ref, no
 * dependency array to keep honest.
 */
export function useLiveCommands(input: {
  t: TFunction;
  state: EvaluationState;
  controls: LiveControls;
  navigate: (r: Route) => void;
  id: string;
}): void {
  const { t, state, controls, navigate, id } = input;
  const commands: Command[] = [];
  if (state === "lobby" || state === "scheduled") {
    commands.push({
      id: "live:start",
      label: t("live.start"),
      icon: Play,
      group: "action",
      run: controls.start,
    });
  }
  if (state === "running" || state === "paused") {
    if (controls.canPause || state === "paused") {
      commands.push({
        id: "live:pause",
        label: state === "paused" ? t("live.resume") : t("live.pause"),
        icon: state === "paused" ? Play : Pause,
        group: "action",
        run: state === "paused" ? controls.resume : controls.pause,
      });
    }
    commands.push(
      {
        id: "live:extend",
        label: t("live.extendMinutes", { n: 5 }),
        hint: t("live.extendAll"),
        icon: Clock,
        group: "action",
        run: () => controls.extend(5),
      },
      {
        id: "live:close",
        label: t("live.closeAll"),
        icon: Square,
        group: "action",
        run: controls.close,
      },
    );
  }
  commands.push({
    id: "live:configure",
    label: t("eval.configure"),
    icon: MonitorPlay,
    group: "navigate",
    run: () => navigate({ view: "evaluation", id }),
  });
  useScreenCommands(commands);
}
