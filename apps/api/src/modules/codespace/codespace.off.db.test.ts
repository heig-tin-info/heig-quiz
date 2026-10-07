/**
 * ADR-047 §5 (M6-06 acceptance): with `CODESPACE_URL` empty the online
 * workspace does not exist — with Quiz's App configured, so the project
 * routes do: every route of the module is the 404 of a missing entity, the
 * administration carries no grant, and a project left in an online mode is
 * said to its student as no workspace at all.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultProjectGradingScale, StudentProject, type AdminTeacher } from "@quiz/contracts";

import { githubOrganizations, projects } from "../../db/schema.js";
import { appKey } from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";

const key = appKey();
let server: TestServer;

beforeAll(async () => {
  server = await testServer({
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY_PATH: key.pem,
    GITHUB_APP_SLUG: "quiz-test",
    GITHUB_WEBHOOK_SECRET: "w".repeat(40),
  });
});

afterAll(async () => {
  await server.close();
  key.remove();
});

describe("the online workspace off (CODESPACE_URL empty)", () => {
  it("404s every route, lists no grant, and shows the student no workspace", async () => {
    const db = server.app.db;
    const teacher = await server.signIn("teacher");
    const student = await server.signIn("student");
    const admin = await server.signIn("admin");
    const room = await seedLive(db, { teacherId: teacher.id, studentIds: [student.id], questions: 0 });
    const orgId = randomUUID();
    await db.insert(githubOrganizations).values({ id: orgId, login: "off-org", githubOrgId: 91_000, installationId: 91_000 });
    const id = randomUUID();
    const now = new Date();
    await db.insert(projects).values({
      id,
      classroomId: room.classroomId,
      orgId,
      name: "Online lab",
      slug: "online-lab",
      state: "published",
      startAt: now,
      deadlineAt: new Date(now.getTime() + 7 * 86_400_000),
      sourceRepoId: 1,
      sourceFullName: "off-org/starter",
      distributionFullName: "off-org/online-lab-squashed",
      branches: ["main"],
      protectedFiles: [],
      gradingScale: defaultProjectGradingScale(),
      createdBy: teacher.id,
      workMode: "online",
    });

    const inject = (method: "GET" | "PUT" | "POST" | "PATCH", url: string, headers: Record<string, string>, payload?: object) =>
      server.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    expect((await inject("GET", `/app/codespace/start/${id}`, student.headers)).statusCode).toBe(404);
    expect((await inject("GET", `/app/codespace/start/${id}`, {})).statusCode).toBe(404);
    expect((await inject("GET", `/app/api/projects/${id}/workspace`, teacher.headers)).statusCode).toBe(404);
    expect((await inject("PUT", `/app/api/projects/${id}/workspace/mode`, teacher.headers, { mode: "free" })).statusCode).toBe(404);
    expect((await inject("POST", `/app/api/projects/${id}/workspace/sync`, teacher.headers)).statusCode).toBe(404);
    expect((await inject("GET", `/app/api/projects/${id}/workspace/sessions`, teacher.headers)).statusCode).toBe(404);

    const created = await inject("POST", "/app/api/admin/teachers", admin.headers, { email: "off@heig.test" });
    const gid = created.json().id as string;
    const teachers = (await inject("GET", "/app/api/admin/teachers", admin.headers)).json() as AdminTeacher[];
    expect(teachers.every((t) => t.codespace === null)).toBe(true);
    expect((await inject("PATCH", `/app/api/admin/teachers/${gid}/codespace`, admin.headers, { enabled: true })).statusCode).toBe(404);

    const view = await inject("GET", `/app/api/student/projects/${id}`, student.headers);
    expect(view.statusCode, view.body).toBe(200);
    expect(StudentProject.parse(view.json()).workspace).toBeNull();
  });
});
