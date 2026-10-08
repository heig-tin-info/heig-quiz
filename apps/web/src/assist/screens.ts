/**
 * Which views of the router the teacher assistant may open (ADR-080, P2b
 * amendment), and the label its answer names each by ("Opened: …"). ONE
 * entry per view of the `Route` union — a view added to the router and not
 * classified here is a compile error —: the label of a screen of the
 * catalogue (`ASSIST_SCREENS`, `@quiz/domain`, which the server checks the
 * model's calls against), or `null` where it may not open — a student's
 * screen, a projection, a preview, a guest's or a station's page, a
 * creation form, a page whose ids no read tool returns (a project, a group
 * set). `screens.test.ts` holds the two lists to each other and to the
 * router's patterns and entity kinds.
 */
import type { Dict } from "../i18n";
import type { Route } from "../router";

export const ASSIST_SCREEN_LABELS: { readonly [V in Route["view"]]: keyof Dict | null } = {
  home: "nav.courses",
  settings: "menu.settings",
  admin: "nav.admin",
  course: "assist.screen.course",
  template: "assist.screen.template",
  studentCourses: null,
  studentGrades: null,
  classroomSettings: "assist.screen.classroomSettings",
  projectNew: null,
  classroomJournal: "assist.screen.classroomJournal",
  groupSet: null,
  classroomGroups: "assist.screen.classroomGroups",
  classroomGrades: "assist.screen.classroomGrades",
  classroom: "assist.screen.classroom",
  project: null,
  activities: "nav.activities",
  pools: "pools.title",
  poolCategories: "assist.screen.poolCategories",
  pool: "pool.title",
  polls: "poll.launcher",
  question: "assist.screen.question",
  questionPreview: null,
  attempt: null,
  join: null,
  oauthConsent: null,
  teamsLink: null,
  teamsTab: null,
  kiosk: null,
  pair: null,
  sebQuit: null,
  discover: null,
  feedback: null,
  drill: null,
  live: "live.title",
  evaluationPreview: null,
  poll: null,
  pollModerate: null,
  grading: "grading.title",
  results: "results.title",
  correction: null,
  evaluation: "assist.screen.evaluation",
  devUi: null,
};
