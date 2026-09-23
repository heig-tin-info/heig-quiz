import { ChevronLeft, ChevronRight, Home, School, Send } from "lucide-react";

import type { Command } from "../commands";
import { useT } from "../i18n";

/**
 * What `Ctrl+K` offers during an attempt (W15). Deliberately short: an exam
 * is the one screen the rest of the app must stay out of, so there is no
 * navigation, no theme, no help — only the four moves the footer and the
 * bar already carry, for a student who reaches for the keyboard first.
 * Built beside the player rather than in `commands.ts`, which knows nothing
 * of an attempt and should not learn.
 *
 * `next` and `previous` are the indices the arrows would land on
 * (`neighbour`): `null` where there is nothing to reach, and then no command
 * either.
 */
export function usePlayerCommands({
  next,
  previous,
  onMove,
  onSubmit,
  onHome,
  onExitStudentView,
}: {
  next: number | null;
  previous: number | null;
  onMove: (delta: 1 | -1) => void;
  onSubmit: () => void;
  onHome: () => void;
  /** Only for a teacher walking their own test attempt (ADR-018 addendum). */
  onExitStudentView?: (() => void) | undefined;
}): Command[] {
  const t = useT();
  return [
    {
      id: "player:submit",
      label: t("player.command.submit"),
      icon: Send,
      group: "action",
      run: onSubmit,
    },
    ...(next !== null
      ? [
          {
            id: "player:next",
            label: t("player.command.next"),
            icon: ChevronRight,
            group: "action" as const,
            run: () => onMove(1),
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
            run: () => onMove(-1),
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
}
