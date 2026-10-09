/**
 * What's new (ADR-087) through the real application: the boot's sync, the
 * audiences, the acknowledgement on the database's clock, and what the
 * other sessions may read. The bundle is a fixture (the build's `dist/changelog.json`
 * is whatever was last built).
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ChangelogList, type ChangelogSource } from "@quiz/contracts";

import { CSRF_COOKIE, SESSION_COOKIE, createSession, type NewSession } from "../../auth/session.js";
import { changelogEntries, users } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { syncChangelog } from "./service.js";

const STUDENT_TEXT = "You can now see your drill streak.";
const TEACHER_TEXT = "Staff only: conditions moved to Settings.";
const BUNDLE: ChangelogSource[] = [
  { id: "drill-streak", audience: "student", kind: "new", en: STUDENT_TEXT, fr: "Votre série est visible." },
  { id: "conditions-moved", audience: "teacher", kind: "moved", en: TEACHER_TEXT, fr: "Réservé à l'équipe." },
];
vi.mock("./bundle.js", () => ({ bundledChangelog: () => BUNDLE }));

const SHA = "ad87b7d2c0ffee";
let server: TestServer;
beforeAll(async () => {
  server = await testServer({ COMMIT_SHA: SHA });
  // A row whose entry left the build: never served.
  await server.app.db.insert(changelogEntries).values({ id: "gone-entry", commitSha: null });
});
afterAll(() => server.close());

const get = async (headers: Record<string, string>, path: "" | "/unseen") => {
  const res = await server.app.inject({ method: "GET", url: `/app/api/changelog${path}`, headers });
  expect(res.statusCode, res.body).toBe(200);
  return { body: res.body, list: ChangelogList.parse(res.json()) };
};
const ack = (headers: Record<string, string>) =>
  server.app.inject({ method: "POST", url: "/app/api/me/changelog", headers });
/** The account acknowledged nothing for a day: every entry is unseen. */
const backdate = (id: string) =>
  server.app.db
    .update(users)
    .set({ changelogSeenAt: sql`now() - interval '1 day'` })
    .where(eq(users.id, id));
const seenAt = async (id: string) =>
  (await server.app.db.select({ at: users.changelogSeenAt }).from(users).where(eq(users.id, id)))[0]!.at;

async function sessionOf(userId: string, auth: NewSession): Promise<Record<string, string>> {
  const s = await createSession(server.app.db, userId, 12, auth);
  return { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf };
}

describe("the boot's sync", () => {
  it("dates every bundled entry once, with the boot's commit, and keeps that date", async () => {
    const before = await server.app.db.select().from(changelogEntries);
    expect(before.map((r) => r.id).sort()).toEqual(["conditions-moved", "drill-streak", "gone-entry"]);
    expect(before.find((r) => r.id === "drill-streak")?.commitSha).toBe(SHA);
    await syncChangelog(server.app.db, [...BUNDLE, { ...BUNDLE[0]!, id: "later" }], "0000000");
    const after = await server.app.db.select().from(changelogEntries);
    for (const row of before) expect(after.find((r) => r.id === row.id)).toEqual(row);
    expect(after.find((r) => r.id === "later")?.commitSha).toBe("0000000");
    await server.app.db.delete(changelogEntries).where(eq(changelogEntries.id, "later"));
  });
});

describe("the readers", () => {
  it("never sends a student a teacher entry, unseen or in the history", async () => {
    const student = await server.signIn("student");
    await backdate(student.id);
    for (const path of ["", "/unseen"] as const) {
      const { body, list } = await get(student.headers, path);
      expect(list.map((e) => e.id)).toEqual(["drill-streak"]);
      expect(list[0]).toMatchObject({ kind: "new", commitSha: SHA });
      expect(list[0]?.text).toEqual({ en: STUDENT_TEXT, fr: "Votre série est visible." });
      expect(body).not.toContain(TEACHER_TEXT);
      expect(body).not.toContain("conditions-moved");
      expect(body).not.toContain("gone-entry");
    }
  });

  it.each(["teacher", "admin"] as const)("sends a %s both audiences", async (role) => {
    const staff = await server.signIn(role);
    await backdate(staff.id);
    for (const path of ["", "/unseen"] as const) {
      const { list } = await get(staff.headers, path);
      expect(list.map((e) => e.id).sort()).toEqual(["conditions-moved", "drill-streak"]);
    }
  });

  it("shows a new account nothing from before it, while the history lists it", async () => {
    const teacher = await server.signIn("teacher");
    expect((await get(teacher.headers, "/unseen")).list).toEqual([]);
    expect((await get(teacher.headers, "")).list).toHaveLength(2);
  });

  it("acknowledges on the database's clock, and nothing is unseen after", async () => {
    const student = await server.signIn("student");
    await backdate(student.id);
    const before = await seenAt(student.id);
    expect((await get(student.headers, "/unseen")).list).toHaveLength(1);
    const res = await ack(student.headers);
    expect(res.statusCode).toBe(204);
    const [{ now }] = (await server.app.db.execute(sql`select now() as now`)).rows as [{ now: string }];
    const after = await seenAt(student.id);
    expect(after.getTime()).toBeGreaterThan(before.getTime());
    expect(Math.abs(after.getTime() - new Date(now).getTime())).toBeLessThan(5_000);
    expect((await get(student.headers, "/unseen")).list).toEqual([]);
    expect((await get(student.headers, "")).list).toHaveLength(1);
  });
});

describe("the other sessions", () => {
  it("an impersonation reads the student's history, not their unseen entries, and cannot acknowledge", async () => {
    const student = await server.signIn("student");
    const admin = await server.signIn("admin");
    await backdate(student.id);
    const headers = await sessionOf(student.id, {
      kind: "impersonation",
      actorUserId: admin.id,
      projectId: null,
      evaluationId: null,
    });
    const { body, list } = await get(headers, "");
    expect(list.map((e) => e.id)).toEqual(["drill-streak"]);
    expect(body).not.toContain(TEACHER_TEXT);
    const unseen = await server.app.inject({ method: "GET", url: "/app/api/changelog/unseen", headers });
    expect(unseen.statusCode).toBe(403);
    const before = await seenAt(student.id);
    expect((await ack(headers)).statusCode).toBe(403);
    expect(await seenAt(student.id)).toEqual(before);
  });

  it.each(["seb", "kiosk"] as const)("a %s session is nobody here (401)", async (kind) => {
    const student = await server.signIn("student");
    const headers = await sessionOf(student.id, { kind, actorUserId: null, projectId: null, evaluationId: null });
    for (const url of ["/app/api/changelog", "/app/api/changelog/unseen"]) {
      expect((await server.app.inject({ method: "GET", url, headers })).statusCode).toBe(401);
    }
    expect((await ack(headers)).statusCode).toBe(401);
  });
});
