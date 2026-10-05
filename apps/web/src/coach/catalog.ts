import type { Dict } from "../i18n";
import type { Route } from "../router";

/**
 * What the coach marks say, and where. A coach mark is a speech bubble hung
 * on one element of a screen (`[data-coach="…"]`, or a tab's id), shown the
 * first time a newcomer reaches that screen, and never again once read or
 * dismissed (`Me.coach.seen`, on the account).
 *
 * Two kinds:
 *
 *   - a TOUR is the short walk of a screen, played when the screen is
 *     reached: two to four bubbles, in order, each one pointing at a control
 *     that exists on the page right now. A step whose target is missing (an
 *     empty list has no "New" button in its header) is skipped and stays
 *     unread, so it shows the day the control does.
 *   - a NUDGE is the one bubble a screen offers to someone who looks stuck
 *     on it (`hesitation.ts`): long enough on the page, pointer wandering,
 *     nothing clicked. It points at the thing the screen is for.
 *
 * An id is `<screen>.<step>` and is what the account stores: renaming one
 * shows it again to everybody, which is the right way to re-announce a
 * control that changed.
 */

type Key = keyof Dict;

export type Placement = "top" | "bottom" | "left" | "right";

export interface CoachStep {
  id: string;
  /** A CSS selector; the first VISIBLE match is the target. */
  target: string;
  title: Key;
  body: Key;
  /** Tried first; the layer falls back to whichever side has the room. */
  placement?: Placement;
}

export type Audience = "teacher" | "student";

export interface CoachTour {
  id: string;
  /** The views the tour plays on; `"*"` is any view inside the frame. */
  views: readonly (Route["view"] | "*")[];
  audience: Audience;
  steps: readonly CoachStep[];
}

export interface CoachNudge extends CoachStep {
  views: readonly Route["view"][];
  audience: Audience;
}

/** `[data-coach="x"]`, the one way a component names a target. */
const at = (name: string) => `[data-coach="${name}"]`;

export const TOURS: readonly CoachTour[] = [
  // The frame first: it is on every screen, so it is what a newcomer meets
  // whatever page they land on.
  {
    id: "shell",
    views: ["*"],
    audience: "teacher",
    steps: [
      {
        id: "shell.courses",
        target: at("nav.home"),
        title: "coach.shell.courses.title",
        body: "coach.shell.courses.body",
        placement: "right",
      },
      {
        id: "shell.pools",
        target: at("nav.pools"),
        title: "coach.shell.pools.title",
        body: "coach.shell.pools.body",
        placement: "right",
      },
      {
        id: "shell.polls",
        target: at("nav.polls"),
        title: "coach.shell.polls.title",
        body: "coach.shell.polls.body",
        placement: "right",
      },
      {
        id: "shell.palette",
        target: at("shell.shortcuts"),
        title: "coach.shell.palette.title",
        body: "coach.shell.palette.body",
        placement: "right",
      },
      {
        id: "shell.student-view",
        target: at("shell.view-toggle"),
        title: "coach.shell.studentView.title",
        body: "coach.shell.studentView.body",
        placement: "right",
      },
    ],
  },
  {
    id: "home",
    views: ["home"],
    audience: "teacher",
    steps: [
      {
        id: "home.new-course",
        target: at("home.new-course"),
        title: "coach.home.newCourse.title",
        body: "coach.home.newCourse.body",
        placement: "bottom",
      },
      {
        id: "home.help",
        target: at("page.help"),
        title: "coach.page.help.title",
        body: "coach.page.help.body",
        placement: "bottom",
      },
    ],
  },
  {
    id: "classroom",
    views: ["classroom"],
    audience: "teacher",
    steps: [
      {
        id: "classroom.add",
        target: at("classroom.add"),
        title: "coach.classroom.add.title",
        body: "coach.classroom.add.body",
        placement: "bottom",
      },
      {
        id: "classroom.evaluations",
        target: at("classroom.tab.evaluations"),
        title: "coach.classroom.evaluations.title",
        body: "coach.classroom.evaluations.body",
        placement: "bottom",
      },
      {
        id: "classroom.join",
        target: at("classroom.join"),
        title: "coach.classroom.join.title",
        body: "coach.classroom.join.body",
        placement: "bottom",
      },
    ],
  },
  {
    id: "pools",
    views: ["pools"],
    audience: "teacher",
    steps: [
      {
        id: "pools.new",
        target: at("pools.new"),
        title: "coach.pools.new.title",
        body: "coach.pools.new.body",
        placement: "bottom",
      },
    ],
  },
  {
    id: "pool",
    views: ["pool"],
    audience: "teacher",
    steps: [
      {
        id: "pool.new-question",
        target: at("pool.new-question"),
        title: "coach.pool.newQuestion.title",
        body: "coach.pool.newQuestion.body",
        placement: "bottom",
      },
      {
        id: "pool.search",
        target: at("pool.search"),
        title: "coach.pool.search.title",
        body: "coach.pool.search.body",
        placement: "bottom",
      },
    ],
  },
  {
    id: "question",
    views: ["question"],
    audience: "teacher",
    steps: [
      {
        id: "question.try",
        target: "#question-tab-try",
        title: "coach.question.try.title",
        body: "coach.question.try.body",
        placement: "bottom",
      },
      {
        id: "question.preview",
        target: at("question.preview"),
        title: "coach.question.preview.title",
        body: "coach.question.preview.body",
        placement: "bottom",
      },
      {
        id: "question.publish",
        target: at("question.publish"),
        title: "coach.question.publish.title",
        body: "coach.question.publish.body",
        placement: "bottom",
      },
    ],
  },
  {
    id: "evaluation",
    views: ["evaluation"],
    audience: "teacher",
    steps: [
      {
        id: "evaluation.steps",
        target: "#eval-step-tab-questions",
        title: "coach.evaluation.steps.title",
        body: "coach.evaluation.steps.body",
        placement: "bottom",
      },
      {
        id: "evaluation.launch",
        target: "#eval-step-tab-launch",
        title: "coach.evaluation.launch.title",
        body: "coach.evaluation.launch.body",
        placement: "bottom",
      },
    ],
  },
  {
    id: "live",
    views: ["live"],
    audience: "teacher",
    steps: [
      {
        id: "live.start",
        target: at("live.start"),
        title: "coach.live.start.title",
        body: "coach.live.start.body",
        placement: "bottom",
      },
    ],
  },
  {
    id: "polls",
    views: ["polls"],
    audience: "teacher",
    steps: [
      {
        id: "polls.launch",
        target: at("polls.launch"),
        title: "coach.polls.launch.title",
        body: "coach.polls.launch.body",
        placement: "bottom",
      },
    ],
  },
  // M7-01. The project page is one address and two pages (a student gets
  // theirs): each audience has its own walk.
  {
    id: "project",
    views: ["project"],
    audience: "teacher",
    steps: [
      {
        id: "project.primary",
        target: at("project.primary"),
        title: "coach.project.primary.title",
        body: "coach.project.primary.body",
        placement: "bottom",
      },
      {
        id: "project.repos",
        target: at("project.repos"),
        title: "coach.project.repos.title",
        body: "coach.project.repos.body",
        placement: "top",
      },
      {
        id: "project.repo",
        target: at("project.repo"),
        title: "coach.project.repo.title",
        body: "coach.project.repo.body",
        placement: "bottom",
      },
      {
        id: "project.checkpoints",
        target: at("project.checkpoints"),
        title: "coach.project.checkpoints.title",
        body: "coach.project.checkpoints.body",
        placement: "top",
      },
      {
        id: "project.sync",
        target: at("project.sync"),
        title: "coach.project.sync.title",
        body: "coach.project.sync.body",
        placement: "bottom",
      },
    ],
  },
  {
    id: "sproj",
    views: ["project"],
    audience: "student",
    steps: [
      {
        id: "sproj.action",
        target: at("sproj.action"),
        title: "coach.sproj.action.title",
        body: "coach.sproj.action.body",
        placement: "bottom",
      },
      {
        id: "sproj.score",
        target: at("sproj.score"),
        title: "coach.sproj.score.title",
        body: "coach.sproj.score.body",
        placement: "top",
      },
      {
        id: "sproj.deadline",
        target: at("sproj.deadline"),
        title: "coach.sproj.deadline.title",
        body: "coach.sproj.deadline.body",
        placement: "bottom",
      },
    ],
  },
];

/**
 * One per screen at most: what the screen is for, offered to someone who
 * looks for it. Its id is its own (`*.nudge`): having walked the tour and
 * still hesitating a week later is exactly when it is worth showing.
 */
export const NUDGES: readonly CoachNudge[] = [
  {
    id: "home.nudge",
    views: ["home"],
    audience: "teacher",
    target: at("shell.shortcuts"),
    title: "coach.nudge.palette.title",
    body: "coach.nudge.palette.body",
    placement: "right",
  },
  {
    id: "pool.nudge",
    views: ["pool"],
    audience: "teacher",
    target: at("pool.new-question"),
    title: "coach.nudge.pool.title",
    body: "coach.nudge.pool.body",
    placement: "bottom",
  },
  {
    id: "question.nudge",
    views: ["question"],
    audience: "teacher",
    target: "#question-tab-try",
    title: "coach.nudge.question.title",
    body: "coach.nudge.question.body",
    placement: "bottom",
  },
  {
    id: "evaluation.nudge",
    views: ["evaluation"],
    audience: "teacher",
    target: "#eval-step-tab-launch",
    title: "coach.nudge.evaluation.title",
    body: "coach.nudge.evaluation.body",
    placement: "bottom",
  },
  {
    id: "classroom.nudge",
    views: ["classroom"],
    audience: "teacher",
    target: at("classroom.tab.evaluations"),
    title: "coach.nudge.classroom.title",
    body: "coach.nudge.classroom.body",
    placement: "bottom",
  },
];

/** The tours that play on `view` for this audience, frame first. */
export function toursFor(view: Route["view"], audience: Audience): CoachTour[] {
  return TOURS.filter(
    (tour) =>
      tour.audience === audience && (tour.views.includes("*") || tour.views.includes(view)),
  );
}

export function nudgeFor(view: Route["view"], audience: Audience): CoachNudge | null {
  return NUDGES.find((n) => n.audience === audience && n.views.includes(view)) ?? null;
}

