/**
 * The scheduled catalog (D10): every minutes-scale periodic task of the
 * server, with its default period. The ONE place it is assembled; the rest
 * of the application reaches it through this module's `service.ts` and
 * `jobs.ts`.
 *
 * A module contributes its tasks as a list, so the order stays readable and
 * neither the ticker nor this module knows any domain: `POLL_TASKS` ends the
 * polls left without an answer for 12 hours, `NOTIFICATION_TASKS` reminds
 * the students of an evaluation closing within 24 hours (ADR-030 §d),
 * `DRILL_TASKS` purges the drill data past its five-year retention
 * (N-DATA-03). `health.checks` is this module's own: the health registry,
 * run every five minutes, telling the administrators of a check that fails
 * or recovers (ADR-055 §5, `alerts.ts`). `GITHUB_TASKS` replays and purges the
 * webhook deliveries (ADR-011, M2-04); `RECONCILE_TASKS` catches up the
 * projects' runs, invitations and repositories GitHub's webhooks missed
 * (ADR-011, N-RES-08, M3-06); `REVIEW_TASKS` reviews the questions of the
 * pools that asked, at night (ADR-060 §5); `ASSIST_TASKS` deletes the
 * assistant's messages past their 30 days (ADR-080 §6); `LIVE_SCHEDULED_TASKS`
 * deletes the integrity journal of the evaluations closed six months ago and
 * never released (ADR-088). A new task also adds its key to
 * `SCHEDULED_TASK_KEYS` (`@quiz/contracts`) and its names to the web's
 * dictionaries.
 */
import { purgeOAuth } from "../../auth/oauth/service.js";
import { purgeExpiredSessions } from "../../auth/session.js";
import type { ScheduledTask } from "../../ticker.js";
import { ASSIST_TASKS } from "../assist/jobs.js";
import { DRILL_TASKS } from "../drill/jobs.js";
import { GITHUB_TASKS } from "../github/jobs.js";
import { LIVE_SCHEDULED_TASKS } from "../live/jobs.js";
import { NOTIFICATION_TASKS } from "../notifications/jobs.js";
import { POLL_TASKS } from "../poll/jobs.js";
import { REVIEW_TASKS } from "../pool/jobs.js";
import { RECONCILE_TASKS } from "../project/reconcile.js";
import { runHealthAlerts } from "./alerts.js";

export const SCHEDULED_TASKS: readonly ScheduledTask[] = [
  {
    key: "sessions.purge",
    defaultIntervalMinutes: 10,
    run: async (app) => `${await purgeExpiredSessions(app.db, app.clock.now())} expired sessions deleted`,
  },
  {
    // ADR-023: spent requests and hourly access tokens, dead grants, and
    // self-registered clients that never got as far as a grant.
    key: "oauth.purge",
    defaultIntervalMinutes: 60,
    run: async (app) => `${await purgeOAuth(app.db, app.clock.now())} OAuth rows deleted`,
  },
  ...POLL_TASKS,
  ...NOTIFICATION_TASKS,
  ...DRILL_TASKS,
  ...GITHUB_TASKS,
  ...RECONCILE_TASKS,
  ...REVIEW_TASKS,
  ...ASSIST_TASKS,
  ...LIVE_SCHEDULED_TASKS,
  {
    key: "health.checks",
    defaultIntervalMinutes: 5,
    run: (app, config) => runHealthAlerts(app, config),
  },
];
