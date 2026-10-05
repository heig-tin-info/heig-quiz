import { describe, expect, it } from "vitest";

import { legacyRule, type LegacyRule } from "./legacyClassroom.js";

const C = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const U = "33333333-3333-4333-8333-333333333333";

/** One row of docs/merge/06 §6.6 per case (the dead-API and fixed rows included). */
const ROWS: [string, string, LegacyRule][] = [
  ["POST /webhooks/github", "/webhooks/github", { kind: "gone" }],
  ["/app/auth/github/callback", "/app/auth/github/callback", { kind: "redirect", to: "/settings" }],
  ["/setup/github/installed", "/setup/github/installed", { kind: "redirect", to: "/" }],
  ["/app/auth/* (edu-ID)", "/app/auth/callback", { kind: "redirect", to: "/" }],
  ["/app/auth/login", "/app/auth/login", { kind: "redirect", to: "/" }],
  ["/app/codespace/start/:aid", `/app/codespace/start/${A}`, { kind: "start", assignmentId: A }],
  ["/app/email/unsub", "/app/email/unsub", { kind: "redirect", to: "/settings" }],
  ["/classrooms/:id", `/classrooms/${C}`, { kind: "classroom", classroomId: C }],
  ["/classrooms/:id/assignments/:aid", `/classrooms/${C}/assignments/${A}`, { kind: "project", classroomId: C, assignmentId: A }],
  ["/classrooms/:id/assignments/:aid/groups", `/classrooms/${C}/assignments/${A}/groups`, { kind: "groups", classroomId: C, assignmentId: A }],
  ["/classrooms/:cid/journal", `/classrooms/${C}/journal`, { kind: "journal", classroomId: C, path: "" }],
  ["/classrooms/:cid/journal/<path>", `/classrooms/${C}/journal/10-w1/README.md`, { kind: "journal", classroomId: C, path: "10-w1/README.md" }],
  ["/settings", "/settings", { kind: "redirect", to: "/settings" }],
  ["/admin", "/admin", { kind: "redirect", to: "/admin" }],
  ["/", "/", { kind: "redirect", to: "/" }],
  ["/app/api/*", "/app/api/classrooms", { kind: "gone" }],
  ["/app/events", "/app/events", { kind: "gone" }],
  ["/kc/*", "/kc/realms/x", { kind: "gone" }],
  ["/healthz", "/healthz", { kind: "gone" }],
  ["/metrics", "/metrics", { kind: "gone" }],
  ["/app/api/journals/:jid/assets/*", `/app/api/journals/${C}/assets/a.png`, { kind: "gone" }],
  ["/app/api/users/:uid/avatar", `/app/api/users/${U}/avatar`, { kind: "avatar", userId: U }],
];

describe("legacyRule: every row of the permalink table", () => {
  it.each(ROWS)("%s", (_row, path, rule) => {
    expect(legacyRule(path)).toEqual(rule);
  });
});

describe("legacyRule: edges", () => {
  it("ignores a trailing slash and an empty path", () => {
    expect(legacyRule(`/classrooms/${C}/`)).toEqual({ kind: "classroom", classroomId: C });
    expect(legacyRule("")).toEqual({ kind: "redirect", to: "/" });
  });

  it("a malformed id under a known prefix is a missing entity", () => {
    expect(legacyRule("/classrooms/nope")).toEqual({ kind: "not_found" });
    expect(legacyRule(`/classrooms/${C}/assignments/nope`)).toEqual({ kind: "not_found" });
    expect(legacyRule("/app/codespace/start/nope")).toEqual({ kind: "not_found" });
    expect(legacyRule("/app/api/users/nope/avatar")).toEqual({ kind: "gone" });
  });

  it("a suffix no row names is no row: the fallback, never a silent resolution", () => {
    const home = { kind: "redirect", to: "/" };
    for (const tail of ["/roster", "/assignments", `/assignments/${A}/other`, `/assignments/${A}/groups/x`, `/assignments/${A}/groups/x/y`]) {
      expect(legacyRule(`/classrooms/${C}${tail}`)).toEqual(home);
    }
  });

  it("an unknown path falls to the home, as the last line of the fragment", () => {
    expect(legacyRule("/whatever/else")).toEqual({ kind: "redirect", to: "/" });
    expect(legacyRule("/classrooms")).toEqual({ kind: "redirect", to: "/" });
    expect(legacyRule("/app/somethingnew")).toEqual({ kind: "redirect", to: "/" });
  });

  it("a journal path is the raw remainder, vetted later by the contract", () => {
    expect(legacyRule(`/classrooms/${C}/journal/x/../y`)).toEqual({ kind: "journal", classroomId: C, path: "x/../y" });
  });
});
