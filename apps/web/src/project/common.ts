/*
 * The badge of a project's state (M3-10): the Activities section and the
 * classroom's Projects group both draw it through `KIND` (`activities/
 * model.ts`), and the project page (M3-12) will too. Pure: no query here.
 */
import type { ProjectState } from "@quiz/contracts";

import type { TFunction } from "../i18n";
import type { Tone } from "../ui";

/**
 * Amber while it is open — the gantt's colour for an open activity nobody
 * is "in the room" of —, zinc at rest: a draft nobody sees yet, a project
 * locked at its deadline. Never the accent, as for an evaluation's state
 * (`evaluation/common.ts`).
 */
const STATE_TONE: Record<ProjectState, Tone> = {
  draft: "zinc",
  published: "amber",
  locked: "zinc",
};

export const projectStateTone = (state: ProjectState): Tone => STATE_TONE[state];

export const projectStateLabel = (state: ProjectState, t: TFunction): string => t(`project.state.${state}`);
