import { describe, expect, it } from "vitest";

import {
  ACCOUNT_KINDS,
  DEFAULT_CHANNEL_ENABLED,
  GITHUB_KINDS,
  kindChannels,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  notificationKindsFor,
  NotificationPayload,
  NotificationPreferencePut,
} from "./notifications.js";

describe("DEFAULT_CHANNEL_ENABLED — the defaults per kind (ADR-030, #198)", () => {
  it("has one row per kind, and every channel in each row", () => {
    expect(Object.keys(DEFAULT_CHANNEL_ENABLED).sort()).toEqual([...NOTIFICATION_KINDS].sort());
    for (const kind of NOTIFICATION_KINDS) {
      expect(Object.keys(DEFAULT_CHANNEL_ENABLED[kind]).sort()).toEqual(
        [...NOTIFICATION_CHANNELS].sort(),
      );
    }
  });

  it("keeps the app on for every kind the bell carries: a default never hides a notification", () => {
    for (const kind of NOTIFICATION_KINDS) {
      if (kindChannels(kind).includes("bell")) expect(DEFAULT_CHANNEL_ENABLED[kind].bell, kind).toBe(true);
    }
  });

  it("leaves the kinds that existed before #198 on everywhere, as they were", () => {
    const allOn = { bell: true, email: true, teams: true };
    expect(DEFAULT_CHANNEL_ENABLED.results_released).toEqual(allOn);
    expect(DEFAULT_CHANNEL_ENABLED.pool_shared).toEqual(allOn);
    expect(DEFAULT_CHANNEL_ENABLED.pool_ownership).toEqual(allOn);
  });

  it("keeps grading_ready on everywhere and pool_question_added in the app only (§c)", () => {
    expect(DEFAULT_CHANNEL_ENABLED.grading_ready).toEqual({ bell: true, email: true, teams: true });
    expect(DEFAULT_CHANNEL_ENABLED.pool_question_added).toEqual({
      bell: true,
      email: false,
      teams: false,
    });
  });

  it("keeps activity_scheduled in the app only, and activity_available on everywhere (§h)", () => {
    expect(DEFAULT_CHANNEL_ENABLED.activity_scheduled).toEqual({ bell: true, email: false, teams: false });
    expect(DEFAULT_CHANNEL_ENABLED.activity_available).toEqual({ bell: true, email: true, teams: true });
  });

  it("keeps deadline_approaching on everywhere: a reminder a student must not miss (§c)", () => {
    expect(DEFAULT_CHANNEL_ENABLED.deadline_approaching).toEqual({ bell: true, email: true, teams: true });
  });

  it("mails system_alert by default, and keeps it out of Teams whatever the toggle (ADR-055 §5)", () => {
    expect(DEFAULT_CHANNEL_ENABLED.system_alert).toEqual({ bell: true, email: true, teams: false });
    expect(kindChannels("system_alert")).toEqual(["bell", "email"]);
    expect(kindChannels("results_released")).toEqual(NOTIFICATION_CHANNELS);
  });

  it("never enables by default a channel a kind may not use", () => {
    for (const kind of NOTIFICATION_KINDS) {
      for (const channel of NOTIFICATION_CHANNELS) {
        if (!kindChannels(kind).includes(channel)) expect(DEFAULT_CHANNEL_ENABLED[kind][channel], `${kind}.${channel}`).toBe(false);
      }
    }
  });
});

describe("system_alert — the payload", () => {
  it("names checks by key only, and refuses an empty list", () => {
    const payload = { kind: "system_alert", state: "failing", checks: ["disk", "runner"] };
    expect(NotificationPayload.parse(payload)).toEqual(payload);
    expect(NotificationPayload.safeParse({ ...payload, checks: [] }).success).toBe(false);
    expect(NotificationPayload.safeParse({ ...payload, checks: ["nope"] }).success).toBe(false);
  });
});

describe("impersonation_ended — a session opened in the student's name (ADR-034 §6)", () => {
  it("carries the role and two times, never who acted", () => {
    const payload = {
      kind: "impersonation_ended",
      actorRole: "admin",
      openedAt: "2026-10-15T08:00:00.000Z",
      closedAt: "2026-10-15T08:20:00.000Z",
    };
    expect(NotificationPayload.parse(payload)).toEqual(payload);
    // A stray actor id is dropped, never carried.
    expect(NotificationPayload.parse({ ...payload, actorUserId: "11111111-1111-4111-8111-111111111111" })).toEqual(payload);
    expect(NotificationPayload.safeParse({ ...payload, actorRole: "student" }).success).toBe(false);
  });
});

describe("account_dormant — the account's lifecycle e-mail (ADR-117 §4)", () => {
  it("is an e-mail only, about the account, with no toggle anyone may send", () => {
    expect(ACCOUNT_KINDS).toEqual(["account_dormant"]);
    expect(kindChannels("account_dormant")).toEqual(["email"]);
    expect(DEFAULT_CHANNEL_ENABLED.account_dormant).toEqual({ bell: false, email: true, teams: false });
    for (const enabled of [true, false]) {
      expect(NotificationPreferencePut.safeParse({ kind: "account_dormant", channel: "email", enabled }).success).toBe(false);
    }
    expect(NotificationPreferencePut.safeParse({ kind: "pool_shared", channel: "email", enabled: false }).success).toBe(true);
  });

  it("names its stage and nothing else", () => {
    expect(NotificationPayload.parse({ kind: "account_dormant", state: "notice" })).toEqual({ kind: "account_dormant", state: "notice" });
    expect(NotificationPayload.safeParse({ kind: "account_dormant", state: "gone" }).success).toBe(false);
  });

  it("is never a row of the settings grid, whatever the account", () => {
    for (const role of ["student", "teacher", "admin"] as const) {
      for (const seat of [false, true]) {
        expect(notificationKindsFor({ role, studentSeat: seat, courseSeat: seat, github: true })).not.toContain("account_dormant");
      }
    }
  });
});

describe("notificationKindsFor — the rows of the settings grid (#277)", () => {
  const SEAT_KINDS = [
    "results_released",
    "activity_scheduled",
    "activity_available",
    "deadline_approaching",
    "results_updated",
    "project_published",
    "project_deadline_reminder",
    "project_repo_invited",
    "project_grade_final",
    "impersonation_ended",
  ];
  const COURSE_KINDS = [
    "student_joined",
    "roster_conflict",
    "grading_ready",
    "project_deadline_applied",
    "project_provision_failed",
    "github_org_lost",
  ];
  const POOL_KINDS = ["pool_shared", "pool_ownership", "pool_question_added", "question_reported", "question_report_resolved", "pool_unpublished"];
  const STAFF_KINDS = [...COURSE_KINDS, ...POOL_KINDS];
  const ADMIN_KINDS = ["system_alert"];

  it("gives a student the seat kinds, with or without a claimed seat", () => {
    expect(notificationKindsFor({ role: "student", studentSeat: false, courseSeat: false, github: true })).toEqual(SEAT_KINDS);
    expect(notificationKindsFor({ role: "student", studentSeat: true, courseSeat: false, github: true })).toEqual(SEAT_KINDS);
  });

  it("gives a teacher without a student seat the staff kinds, course seat or not", () => {
    expect(notificationKindsFor({ role: "teacher", studentSeat: false, courseSeat: false, github: true })).toEqual(STAFF_KINDS);
    expect(notificationKindsFor({ role: "teacher", studentSeat: false, courseSeat: true, github: true })).toEqual(STAFF_KINDS);
  });

  it("gives an admin the course kinds only while holding a course seat (#287)", () => {
    expect(notificationKindsFor({ role: "admin", studentSeat: false, courseSeat: false, github: true })).toEqual([
      ...POOL_KINDS,
      ...ADMIN_KINDS,
    ]);
    expect(notificationKindsFor({ role: "admin", studentSeat: false, courseSeat: true, github: true })).toEqual([
      ...STAFF_KINDS,
      ...ADMIN_KINDS,
    ]);
  });

  it("gives the admin kinds to an admin only", () => {
    expect(notificationKindsFor({ role: "teacher", studentSeat: true, courseSeat: true, github: true })).not.toContain("system_alert");
  });

  it("gives a teacher on a roster every kind but the admin and account ones, and an admin every kind but the account ones, in the catalogue order", () => {
    const listed = NOTIFICATION_KINDS.filter((k) => !ACCOUNT_KINDS.includes(k));
    expect(notificationKindsFor({ role: "teacher", studentSeat: true, courseSeat: false, github: true })).toEqual(
      listed.filter((k) => !ADMIN_KINDS.includes(k)),
    );
    expect(notificationKindsFor({ role: "admin", studentSeat: true, courseSeat: true, github: true })).toEqual(listed);
  });

  it("hides the project kinds on a platform without Quiz's GitHub App: a toggle that does nothing is a lie (F-NOTIF-13)", () => {
    const shown = notificationKindsFor({ role: "admin", studentSeat: true, courseSeat: true, github: false });
    const gated: readonly string[] = GITHUB_KINDS;
    expect(shown).toEqual(NOTIFICATION_KINDS.filter((k) => !gated.includes(k) && !ACCOUNT_KINDS.includes(k)));
    for (const kind of GITHUB_KINDS) expect(shown).not.toContain(kind);
    // Every project kind is gated, and the lost organization with them.
    for (const kind of NOTIFICATION_KINDS) {
      if (kind.startsWith("project_")) expect(gated, kind).toContain(kind);
    }
    expect(gated).toContain("github_org_lost");
    expect(GITHUB_KINDS).toHaveLength(7);
  });
});

describe("the project kinds (F-NOTIF-13, D18)", () => {
  it("are on by e-mail and Teams for what must not be missed, off for the news that can wait", () => {
    for (const kind of ["project_deadline_reminder", "project_repo_invited", "project_grade_final", "project_provision_failed", "github_org_lost"] as const) {
      expect(DEFAULT_CHANNEL_ENABLED[kind], kind).toEqual({ bell: true, email: true, teams: true });
    }
    for (const kind of ["project_published", "project_deadline_applied"] as const) {
      expect(DEFAULT_CHANNEL_ENABLED[kind], kind).toEqual({ bell: true, email: false, teams: false });
    }
  });

  it("carry ids, a title and counts, never a score nor a student", () => {
    const project = { projectId: "11111111-1111-4111-8111-111111111111", projectTitle: "Lab 1" };
    expect(NotificationPayload.parse({ kind: "project_published", ...project })).toEqual({ kind: "project_published", ...project });
    // The unlinked variant carries a boolean and nothing else (M3-14d, N-SEC-20).
    const unlinked = { kind: "project_published", ...project, githubLinked: false };
    expect(NotificationPayload.parse(unlinked)).toEqual(unlinked);
    expect(NotificationPayload.safeParse({ ...unlinked, githubLinked: true }).success).toBe(false);
    const failed = { kind: "project_provision_failed", ...project, count: 2, reason: "repo_name_taken" };
    expect(NotificationPayload.parse(failed)).toEqual(failed);
    expect(NotificationPayload.safeParse({ kind: "project_provision_failed", ...project, count: 1, reason: "invitation_refused" }).success).toBe(false);
    expect(NotificationPayload.safeParse({ kind: "project_grade_final", ...project, points: 5 }).success).toBe(true);
    // A stray `points` is stripped, never carried: zod objects drop unknown keys.
    expect(NotificationPayload.parse({ kind: "project_grade_final", ...project, points: 5 })).toEqual({ kind: "project_grade_final", ...project });
  });
});
