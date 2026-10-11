/*
 * The badge of a project's state (M3-10): the Activities section and the
 * classroom's Projects group both draw it through `KIND` (`activities/
 * model.ts`), and the project page (M3-12) too. Pure: no query here.
 */
import type { ProjectActivitySummary, ProjectPhase } from "@quiz/contracts";

import type { TFunction } from "../i18n";
import type { BadgeStyle } from "../ui";

/**
 * The staff's colour grammar (ADR-104), the same as an evaluation's
 * (`evaluation/common.ts`), keyed by the server's PHASE — the state, with
 * `locked` refined by the freeze and the release: green while it is
 * published — open to the students, whether or not anyone is "in the room"
 * —, zinc at rest: a draft nobody sees yet, a project locked at its deadline
 * whose scores are not final; amber once they are and the staff's release
 * is awaited (`graded`, an evaluation's `grading`); outline green once
 * released. Never the accent. "Open to the students" is also what
 * {@link projectTimerAt} encodes; the timer is never derived from the colour.
 */
const PHASE_STYLE: Record<ProjectPhase, BadgeStyle> = {
  draft: { tone: "zinc" },
  published: { tone: "green" },
  locked: { tone: "zinc" },
  graded: { tone: "amber" },
  released: { tone: "green", variant: "outline" },
};

export const projectPhaseStyle = (phase: ProjectPhase): BadgeStyle => PHASE_STYLE[phase];

export const projectPhaseLabel = (phase: ProjectPhase, t: TFunction): string => t(`project.state.${phase}`);

/**
 * The deadline the badge of a staff table counts down to (ADR-104): only
 * while the project is published — open to the students, the green of
 * {@link projectPhaseStyle} — and only when it has one. Null otherwise.
 */
export const projectTimerAt = (p: Pick<ProjectActivitySummary, "state" | "deadlineAt">): string | null =>
  p.state === "published" ? p.deadlineAt : null;
