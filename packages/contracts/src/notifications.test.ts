import { describe, expect, it } from "vitest";

import {
  DEFAULT_CHANNEL_ENABLED,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  notificationKindsFor,
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

  it("keeps the app on for every kind: a default never hides a notification", () => {
    for (const kind of NOTIFICATION_KINDS) expect(DEFAULT_CHANNEL_ENABLED[kind].bell).toBe(true);
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
});

describe("notificationKindsFor — the rows of the settings grid (#277)", () => {
  const SEAT_KINDS = [
    "results_released",
    "activity_scheduled",
    "activity_available",
    "deadline_approaching",
    "results_updated",
  ];
  const STAFF_KINDS = [
    "student_joined",
    "roster_conflict",
    "grading_ready",
    "pool_shared",
    "pool_ownership",
    "pool_question_added",
  ];

  it("gives a student the seat kinds, with or without a claimed seat", () => {
    expect(notificationKindsFor("student", false)).toEqual(SEAT_KINDS);
    expect(notificationKindsFor("student", true)).toEqual(SEAT_KINDS);
  });

  it("gives a teacher or an admin without a student seat the staff kinds only", () => {
    expect(notificationKindsFor("teacher", false)).toEqual(STAFF_KINDS);
    expect(notificationKindsFor("admin", false)).toEqual(STAFF_KINDS);
  });

  it("gives a teacher or an admin on a roster every kind, in the catalogue order", () => {
    expect(notificationKindsFor("teacher", true)).toEqual([...NOTIFICATION_KINDS]);
    expect(notificationKindsFor("admin", true)).toEqual([...NOTIFICATION_KINDS]);
  });
});
