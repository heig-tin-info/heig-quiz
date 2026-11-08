import { describe, expect, it } from "vitest";

import {
  DEFAULT_CHANNEL_ENABLED,
  GITHUB_KINDS,
  kindChannels,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  notificationKindsFor,
  NotificationPayload,
} from "./notifications.js";

describe("DEFAULT_CHANNEL_ENABLED — the defaults per kind (ADR-030, #198)", () => {
  // The decision itself, in one place (ADR-030, #198 §c §h, ADR-055 §5): a row per kind, every channel in each row.
  it("is this table, kind by kind", () => {
    const on = { bell: true, email: true, teams: true };
    const appOnly = { bell: true, email: false, teams: false };
    expect(DEFAULT_CHANNEL_ENABLED).toEqual({
      results_released: on,
      activity_scheduled: appOnly,
      activity_available: on,
      deadline_approaching: on,
      results_updated: appOnly,
      project_scheduled: appOnly,
      project_published: appOnly,
      project_deadline_reminder: on,
      project_repo_invited: on,
      project_grade_final: on,
      impersonation_ended: appOnly,
      student_joined: appOnly,
      roster_conflict: on,
      grading_ready: on,
      project_deadline_applied: appOnly,
      project_provision_failed: on,
      github_org_lost: on,
      pool_shared: on,
      pool_ownership: on,
      pool_question_added: appOnly,
      question_reported: appOnly,
      question_report_resolved: on,
      pool_unpublished: on,
      system_alert: { bell: true, email: true, teams: false },
    });
  });

  it("keeps the app on for every kind: a default never hides a notification", () => {
    for (const kind of NOTIFICATION_KINDS) expect(DEFAULT_CHANNEL_ENABLED[kind].bell).toBe(true);
  });

  it("keeps system_alert out of Teams whatever the toggle (ADR-055 §5)", () => {
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

describe("notificationKindsFor — the rows of the settings grid (#277)", () => {
  const SEAT_KINDS = [
    "results_released",
    "activity_scheduled",
    "activity_available",
    "deadline_approaching",
    "results_updated",
    "project_scheduled",
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

  it("gives a teacher on a roster every kind but the admin ones, and an admin every kind, in the catalogue order", () => {
    expect(notificationKindsFor({ role: "teacher", studentSeat: true, courseSeat: false, github: true })).toEqual(
      NOTIFICATION_KINDS.filter((k) => !ADMIN_KINDS.includes(k)),
    );
    expect(notificationKindsFor({ role: "admin", studentSeat: true, courseSeat: true, github: true })).toEqual([...NOTIFICATION_KINDS]);
  });

  it("hides the project kinds on a platform without Quiz's GitHub App: a toggle that does nothing is a lie (F-NOTIF-13)", () => {
    const shown = notificationKindsFor({ role: "admin", studentSeat: true, courseSeat: true, github: false });
    const gated: readonly string[] = GITHUB_KINDS;
    expect(shown).toEqual(NOTIFICATION_KINDS.filter((k) => !gated.includes(k)));
    for (const kind of GITHUB_KINDS) expect(shown).not.toContain(kind);
    // Every project kind is gated, and the lost organization with them.
    for (const kind of NOTIFICATION_KINDS) {
      if (kind.startsWith("project_")) expect(gated, kind).toContain(kind);
    }
    expect(gated).toContain("github_org_lost");
    expect(GITHUB_KINDS).toHaveLength(8);
  });
});

describe("the project kinds (F-NOTIF-13, D18)", () => {
  it("are on by e-mail and Teams for what must not be missed, off for the news that can wait", () => {
    for (const kind of ["project_deadline_reminder", "project_repo_invited", "project_grade_final", "project_provision_failed", "github_org_lost"] as const) {
      expect(DEFAULT_CHANNEL_ENABLED[kind], kind).toEqual({ bell: true, email: true, teams: true });
    }
    for (const kind of ["project_scheduled", "project_published", "project_deadline_applied"] as const) {
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
    // ADR-127: the start it opens at, and the same unlinked variant.
    const scheduled = { kind: "project_scheduled", ...project, startAt: "2026-11-06T15:30:00.000Z", githubLinked: false };
    expect(NotificationPayload.parse(scheduled)).toEqual(scheduled);
    expect(NotificationPayload.safeParse({ kind: "project_scheduled", ...project }).success).toBe(false);
    const failed = { kind: "project_provision_failed", ...project, count: 2, reason: "repo_name_taken" };
    expect(NotificationPayload.parse(failed)).toEqual(failed);
    expect(NotificationPayload.safeParse({ kind: "project_provision_failed", ...project, count: 1, reason: "invitation_refused" }).success).toBe(false);
    expect(NotificationPayload.safeParse({ kind: "project_grade_final", ...project, points: 5 }).success).toBe(true);
    // A stray `points` is stripped, never carried: zod objects drop unknown keys.
    expect(NotificationPayload.parse({ kind: "project_grade_final", ...project, points: 5 })).toEqual({ kind: "project_grade_final", ...project });
  });
});
