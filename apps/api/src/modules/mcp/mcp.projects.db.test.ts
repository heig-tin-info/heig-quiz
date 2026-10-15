/**
 * The MCP server's GitHub projects (ADR-022, addendum of 2026-10-13; #788),
 * on a server built with Quiz's App, against the fake GitHub and local bare
 * repositories (`project/testing.ts`):
 *
 * - `list_project_sources`, `create_project` (a DRAFT, manual publication,
 *   audited as `api_key`) and `list_projects`, through the ordinary routes;
 * - a classroom the caller has no seat on is the 404 of a missing one;
 * - invalid arguments create nothing;
 * - a token reaches those three routes only: every other project route
 *   stays portal-only, and the help assistant's token reaches none.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiTokenCreated, TokenScope } from "@quiz/contracts";

import { mintAssistToken } from "../../auth/tokens.js";
import { auditLog, githubClassroomLinks, githubOrganizations, projects } from "../../db/schema.js";
import { setRemoteBaseForTests } from "../../github/git.js";
import { appKey, fakeGithub, orgsRoute } from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { repoWorld } from "../project/testing.js";
import { ApiError, injectedApi } from "./service.js";

const key = appKey();
const gh = fakeGithub();
const world = repoWorld();
const ENV = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY_PATH: key.pem,
  GITHUB_APP_SLUG: "quiz-test",
  GITHUB_WEBHOOK_SECRET: "w".repeat(40),
};
const NOW = "2026-10-13T08:00:00.000Z";
const IN_A_WEEK = "2026-10-20T22:00:00.000Z";

let server: TestServer;
let teacher: { id: string; headers: Record<string, string>; token: string };
let outsider: { id: string; headers: Record<string, string>; token: string };
let nextOrg = 9100;
let rpcId = 0;

async function tokenFor(headers: Record<string, string>, scope: TokenScope = "quiz") {
  const res = await server.app.inject({ method: "POST", url: "/app/api/me/tokens", headers, payload: { name: "mcp test", scope } });
  return (res.json() as ApiTokenCreated).token;
}

async function call(name: string, args: Record<string, unknown>, token = teacher.token) {
  const res = await server.app.inject({
    method: "POST",
    url: "/app/api/mcp",
    headers: { authorization: `Bearer ${token}` },
    payload: { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } },
  });
  const { result } = res.json() as { result: { isError: boolean; content: { text: string }[] } };
  return { isError: result.isError, data: JSON.parse(result.content[0]!.text) };
}

/** A classroom of `teacherId`'s course, connected to an organization holding a source `lab`. */
async function connectedClassroom(teacherId: string) {
  const db = server.app.db;
  const seeded = await seedLive(db, { teacherId, studentIds: [], questions: 0 });
  const n = nextOrg++;
  const login = `org-${n}`;
  world.orgIds[login] = n;
  world.source(login, "lab", { main: { "README.md": "# Lab", "src/main.c": "int main(){}" } });
  const orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login, githubOrgId: n, installationId: n });
  await db.insert(githubClassroomLinks).values({ classroomId: seeded.classroomId, orgId, linkedBy: teacherId, linkedAt: new Date() });
  return seeded.classroomId;
}

const projectsOf = (classroomId: string) =>
  server.app.db.select().from(projects).where(eq(projects.classroomId, classroomId));

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  setRemoteBaseForTests(`file://${world.dir}`);
  server = await testServer(ENV);
  gh.routes = [orgsRoute(() => []), world.route];
  const [t, o] = await Promise.all([server.signIn("teacher"), server.signIn("teacher")]);
  teacher = { ...t, token: await tokenFor(t.headers) };
  outsider = { ...o, token: await tokenFor(o.headers) };
});

beforeEach(() => {
  server.clock.set(NOW);
});

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  setRemoteBaseForTests(null);
  world.remove();
  key.remove();
});

describe("create_project", () => {
  it("lists the sources, creates a draft the teacher publishes, audited as the token, and lists it", async () => {
    const classroomId = await connectedClassroom(teacher.id);
    const sources = await call("list_project_sources", { classroomId });
    expect(sources.isError, JSON.stringify(sources.data)).toBe(false);
    expect(sources.data.map((s: { name: string }) => s.name)).toEqual(["lab"]);

    const created = await call("create_project", { classroomId, name: "Lab 1", sourceRepo: "lab", deadlineAt: IN_A_WEEK });
    expect(created.isError, JSON.stringify(created.data)).toBe(false);
    expect(created.data).toMatchObject({ name: "Lab 1", state: "draft", publishMode: "manual" });
    expect(created.data.url).toMatch(new RegExp(`/projects/${created.data.id}$`));

    const [audit] = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectId, created.data.id), eq(auditLog.action, "project.create")));
    expect(audit).toMatchObject({ actorUserId: teacher.id, actorType: "api_key" });

    const listed = await call("list_projects", { classroomId });
    expect(listed.isError).toBe(false);
    expect(listed.data).toMatchObject([{ id: created.data.id, state: "draft", url: created.data.url }]);
  });

  it("answers a classroom the caller has no seat on with the 404 of a missing one, and creates nothing", async () => {
    const classroomId = await connectedClassroom(teacher.id);
    const args = { name: "Lab 1", sourceRepo: "lab", durationMinutes: 10_080 };
    const theirs = await call("create_project", { classroomId, ...args }, outsider.token);
    const missing = await call("create_project", { classroomId: randomUUID(), ...args }, outsider.token);
    expect(theirs.isError).toBe(true);
    expect(theirs.data).toEqual(missing.data);
    expect(theirs.data).toMatchObject({ status: 404, body: { error: "not_found" } });
    for (const name of ["list_projects", "list_project_sources"]) {
      expect((await call(name, { classroomId }, outsider.token)).data, name).toEqual(
        (await call(name, { classroomId: randomUUID() }, outsider.token)).data,
      );
    }
    expect(await projectsOf(classroomId)).toEqual([]);
  });

  it("refuses invalid arguments and creates nothing: a scheduled publication by the tool, the deadline rule by the route", async () => {
    const classroomId = await connectedClassroom(teacher.id);
    const base = { classroomId, name: "Lab 1", sourceRepo: "lab" };
    const scheduled = await call("create_project", { ...base, publishMode: "scheduled", startAt: NOW, deadlineAt: IN_A_WEEK });
    expect(scheduled.isError).toBe(true);
    expect(scheduled.data.error).toBe("invalid_arguments");
    // A deadline and a duration, or neither: the contract's rule, the route's 400.
    for (const args of [{ ...base, deadlineAt: IN_A_WEEK, durationMinutes: 10_080 }, { ...base }]) {
      const refused = await call("create_project", args);
      expect(refused.isError, JSON.stringify(args)).toBe(true);
      expect(refused.data).toMatchObject({ error: "refused", status: 400 });
    }
    expect(await projectsOf(classroomId)).toEqual([]);
  });
});

describe("what a token reaches of projects (invariant 6)", () => {
  it("every other project route stays portal-only: a personal token gets the 404 of a missing project", async () => {
    const classroomId = await connectedClassroom(teacher.id);
    const { data: project } = await call("create_project", { classroomId, name: "Lab 2", sourceRepo: "lab", deadlineAt: IN_A_WEEK });
    // A full API token, the only personal token that reaches these routes at all (ADR-113).
    const bearer = { authorization: `Bearer ${await tokenFor(teacher.headers, "api")}` };
    for (const [method, url, payload] of [
      ["GET", `/app/api/projects/${project.id}`, undefined],
      ["PATCH", `/app/api/projects/${project.id}`, { name: "x" }],
      ["POST", `/app/api/projects/${project.id}/publish`, undefined],
      ["POST", `/app/api/projects/${project.id}/archive`, undefined],
      ["DELETE", `/app/api/projects/${project.id}`, undefined],
      ["GET", `/app/api/classrooms/${classroomId}/projects/sources/lab`, undefined],
    ] as const) {
      const res = await server.app.inject({ method, url, headers: bearer, ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await projectsOf(classroomId)).map((p) => [p.name, p.state])).toEqual([["Lab 2", "draft"]]);
  });

  it("the help assistant's token reaches no project route", async () => {
    const classroomId = await connectedClassroom(teacher.id);
    const assist = await mintAssistToken(server.app.db, teacher.id, server.app.clock.now());
    const api = injectedApi(server.app, `Bearer ${assist.token}`, "http://web.test");
    const base = `/classrooms/${classroomId}/projects`;
    for (const attempt of [
      () => api.get(base),
      () => api.get(`${base}/sources`),
      () => api.post(base, { name: "Lab 3", sourceRepo: "lab", deadlineAt: IN_A_WEEK }),
    ]) {
      const error = await attempt().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(404);
    }
    expect(await projectsOf(classroomId)).toEqual([]);
  });
});
