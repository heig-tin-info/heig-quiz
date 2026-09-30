/**
 * The `github` module (M2-02) against a fake GitHub: a real RSA key signs
 * the App's JWT, and a stubbed global fetch answers the routes the adapters
 * call and the avatar host. No network is ever reached.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GithubClassroom, GithubOrg } from "@quiz/contracts";

import {
  auditLog,
  classroomJournals,
  enrollments,
  githubClassroomLinks,
  githubOrganizations,
} from "../../db/schema.js";
import { testServer, type Payload, type TestServer } from "../../test/http.js";
import { addStaff, createClassroom, createCourse } from "../org/service.js";
import { HEAL_TTL_MS, resetGithubCaches } from "./service.js";

// ---------------------------------------------------------------- fake GitHub

interface FakeOrg {
  githubOrgId: number;
  login: string;
  installationId: number | null;
  selection: "all" | "selected";
  plan: string;
  secret: boolean;
  exists: boolean;
}

/** The smallest header `sniffImage` reads as a PNG. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8),
  Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]),
]);

let orgs: FakeOrg[] = [];
let avatar: () => Response = () => png();
const calls: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function png(): Response {
  return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
}
const notFound = () => json({ message: "Not Found" }, 404);
const account = (o: FakeOrg) => ({ id: o.githubOrgId, login: o.login, type: "Organization" });
const installation = (o: FakeOrg) => ({
  id: o.installationId,
  account: account(o),
  repository_selection: o.selection,
});
const byLogin = (login: string) =>
  orgs.find((o) => o.exists && o.login.toLowerCase() === decodeURIComponent(login).toLowerCase());

function github(method: string, path: string): Response {
  let m: RegExpExecArray | null;
  if (method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
    return json({ token: "ghs_fake", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
  }
  if (method !== "GET") return notFound();
  if (path === "/app/installations") {
    return json(orgs.filter((o) => o.installationId !== null).map(installation));
  }
  if ((m = /^\/app\/installations\/(\d+)$/.exec(path))) {
    const o = orgs.find((x) => x.installationId === Number(m![1]));
    return o ? json(installation(o)) : notFound();
  }
  if ((m = /^\/orgs\/([^/]+)\/installation$/.exec(path))) {
    const o = byLogin(m[1]!);
    return o?.installationId ? json(installation(o)) : notFound();
  }
  if ((m = /^\/orgs\/([^/]+)\/actions\/secrets\/ANTHROPIC_API_KEY$/.exec(path))) {
    return byLogin(m[1]!)?.secret ? json({ name: "ANTHROPIC_API_KEY" }) : notFound();
  }
  if ((m = /^\/orgs\/([^/]+)$/.exec(path))) {
    const o = byLogin(m[1]!);
    return o ? json({ ...account(o), plan: { name: o.plan } }) : notFound();
  }
  return notFound();
}

const fetchStub = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init.method ?? "GET").toUpperCase();
  calls.push(`${method} ${url.host}${url.pathname}`);
  if (url.host === "avatars.githubusercontent.com") return avatar();
  if (url.host === "api.github.com") return github(method, url.pathname);
  throw new Error(`unexpected request to ${url.href}`);
});

// ---------------------------------------------------------------- the world

type Caller = Awaited<ReturnType<TestServer["signIn"]>>;

const dir = mkdtempSync(join(tmpdir(), "quiz-github-"));
const pem = join(dir, "app.pem");
writeFileSync(
  pem,
  generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }),
);

let server: TestServer;
let teacher: Caller;
let colleague: Caller;
let outsider: Caller;
let student: Caller;
let courseId: string;

async function classroom(name: string): Promise<string> {
  return (await createClassroom(server.app.db, courseId, { name, period: "2026" })).id;
}

function call(method: "GET" | "PUT" | "DELETE", url: string, who?: Caller, payload?: Payload) {
  return server.app.inject({
    method,
    url,
    ...(who ? { headers: who.headers } : {}),
    ...(payload === undefined ? {} : { payload }),
  });
}

/** An organization row as the import (M8-01) or an earlier request left it. */
async function orgRow(values: Partial<typeof githubOrganizations.$inferInsert> & { login: string }) {
  const [row] = await server.app.db
    .insert(githubOrganizations)
    .values({ id: randomUUID(), ...values })
    .returning();
  return row!;
}

async function link(classroomId: string, orgId: string) {
  await server.app.db
    .insert(githubClassroomLinks)
    .values({ classroomId, orgId, linkedBy: teacher.id, linkedAt: server.clock.now() });
}

async function audits(action: string, subjectId: string) {
  return server.app.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.subjectId, subjectId)));
}

beforeAll(async () => {
  vi.stubGlobal("fetch", fetchStub);
  server = await testServer({
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY_PATH: pem,
    GITHUB_APP_SLUG: "quiz-test",
  });
  [teacher, colleague, outsider, student] = await Promise.all([
    server.signIn("teacher"),
    server.signIn("teacher"),
    server.signIn("teacher"),
    server.signIn("student"),
  ]);
  courseId = (await createCourse(server.app.db, { name: "Prog 1", code: "PRG1" }, teacher.id))!.id;
  await addStaff(server.app.db, courseId, colleague.id);
  await createCourse(server.app.db, { name: "Other", code: "OTH1" }, outsider.id);
});

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetGithubCaches();
  orgs = [];
  avatar = () => png();
  calls.length = 0;
});

// ---------------------------------------------------------------- tests

describe("without Quiz's App", () => {
  it("answers 404 on every route, and never calls GitHub", async () => {
    const bare = await testServer();
    try {
      const who = await bare.signIn("admin");
      const id = randomUUID();
      for (const [method, url] of [
        ["GET", "/app/api/github/orgs"],
        ["GET", `/app/api/github/orgs/${id}/avatar`],
        ["GET", `/app/api/classrooms/${id}/github`],
        ["PUT", `/app/api/classrooms/${id}/github`],
        ["DELETE", `/app/api/classrooms/${id}/github`],
        ["GET", `/setup/github/installed?installation_id=1&state=${id}`],
      ] as const) {
        const res = await bare.app.inject({
          method,
          url,
          headers: who.headers,
          ...(method === "PUT" ? { payload: { orgId: id } } : {}),
        });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
      }
      expect(calls).toEqual([]);
    } finally {
      await bare.close();
    }
  });
});

describe("the setup return", () => {
  const setup = (query: string) => call("GET", `/setup/github/installed?${query}`);

  it("stores nothing for an installation the App's JWT does not confirm", async () => {
    const room = await classroom("setup-refused");
    const res = await setup(`installation_id=9999&state=${room}`);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/classrooms/${room}/settings`);
    expect(calls).toContain("GET api.github.com/app/installations/9999");
    const rows = await server.app.db
      .select()
      .from(githubOrganizations)
      .where(eq(githubOrganizations.installationId, 9999));
    expect(rows).toEqual([]);
  });

  it("records a confirmed installation once, however often GitHub returns", async () => {
    orgs = [{ githubOrgId: 601, login: "heig-setup", installationId: 81, selection: "all", plan: "free", secret: false, exists: true }];
    for (let i = 0; i < 2; i += 1) {
      expect((await setup("installation_id=81&setup_action=install")).statusCode).toBe(303);
    }
    const rows = await server.app.db
      .select()
      .from(githubOrganizations)
      .where(eq(githubOrganizations.githubOrgId, 601));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ login: "heig-setup", installationId: 81, status: "active", plan: "free" });
    expect(await audits("github_org.installation_resolved", rows[0]!.id)).toHaveLength(1);
  });

  it("never redirects outside the application, whatever `state` says", async () => {
    for (const state of ["https://evil.example/x", "//evil.example", "/\\evil.example", "/admin", "javascript:alert(1)"]) {
      const res = await setup(`state=${encodeURIComponent(state)}`);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location, state).toBe("/");
    }
  });
});

describe("the organizations", () => {
  it("lists those where the App is installed, with a same-origin avatar", async () => {
    orgs = [
      { githubOrgId: 701, login: "heig-listed", installationId: 91, selection: "all", plan: "team", secret: true, exists: true },
    ];
    const stale = await orgRow({ login: "heig-gone", githubOrgId: 702, installationId: 92 });
    const res = await call("GET", "/app/api/github/orgs", teacher);
    expect(res.statusCode).toBe(200);
    const list = res.json<GithubOrg[]>();
    const listed = list.find((o) => o.login === "heig-listed");
    expect(listed).toMatchObject({ installed: true, status: "active" });
    expect(listed!.avatarUrl).toBe(`/app/api/github/orgs/${listed!.id}/avatar`);
    // GitHub no longer lists it: its installation is cleared, and audited.
    expect(list.map((o) => o.login)).not.toContain("heig-gone");
    expect(await audits("github_org.installation_deleted", stale.id)).toHaveLength(1);
  });

  it("is the staff's: a student is refused", async () => {
    expect((await call("GET", "/app/api/github/orgs", student)).statusCode).toBe(403);
  });
});

describe("a classroom's link", () => {
  let room: string;
  let installed: { id: string };
  let other: { id: string };

  beforeAll(async () => {
    room = await classroom("link");
    installed = await orgRow({ login: "heig-link", githubOrgId: 801, installationId: 101 });
    other = await orgRow({ login: "heig-other", githubOrgId: 802, installationId: 102 });
  });
  beforeEach(() => {
    orgs = [
      { githubOrgId: 801, login: "heig-link", installationId: 101, selection: "all", plan: "team", secret: true, exists: true },
      { githubOrgId: 802, login: "heig-other", installationId: 102, selection: "all", plan: "team", secret: true, exists: true },
    ];
  });

  it("is a 404 for anyone off the course's staff", async () => {
    await server.app.db.insert(enrollments).values({
      id: randomUUID(),
      classroomId: room,
      nom: "N",
      prenom: "P",
      email: "p@heig.test",
      userId: student.id,
    });
    for (const who of [outsider, student]) {
      expect((await call("PUT", `/app/api/classrooms/${room}/github`, who, { orgId: installed.id })).statusCode).toBe(404);
      expect((await call("GET", `/app/api/classrooms/${room}/github`, who)).statusCode).toBe(404);
      expect((await call("DELETE", `/app/api/classrooms/${room}/github`, who)).statusCode).toBe(404);
    }
    expect(await server.app.db.select().from(githubClassroomLinks).where(eq(githubClassroomLinks.classroomId, room))).toEqual([]);
  });

  it("offers the install page with the classroom as `state`", async () => {
    const res = await call("GET", `/app/api/classrooms/${room}/github`, teacher);
    expect(res.statusCode).toBe(200);
    expect(res.json<GithubClassroom>()).toMatchObject({
      link: null,
      installUrl: `https://github.com/apps/quiz-test/installations/new?state=${room}`,
    });
  });

  it("connects a member of the staff, audited, with a strict body", async () => {
    const bad = await call("PUT", `/app/api/classrooms/${room}/github`, colleague, { orgId: installed.id, extra: 1 });
    expect(bad.statusCode).toBe(400);
    const res = await call("PUT", `/app/api/classrooms/${room}/github`, colleague, { orgId: installed.id });
    expect(res.statusCode).toBe(200);
    expect(res.json<GithubClassroom>().link).toMatchObject({
      org: { id: installed.id, installed: true },
      checks: { allRepositories: true, llmSecret: "present" },
    });
    expect(await audits("github_org.link", room)).toHaveLength(1);
    // The same organization again writes nothing.
    await call("PUT", `/app/api/classrooms/${room}/github`, colleague, { orgId: installed.id });
    expect(await audits("github_org.link", room)).toHaveLength(1);
  });

  it("suggests the organization of the course's other classrooms", async () => {
    const sibling = await classroom("link-sibling");
    const res = await call("GET", `/app/api/classrooms/${sibling}/github`, teacher);
    expect(res.json<GithubClassroom>().suggestedOrgId).toBe(installed.id);
  });

  it("refuses an organization the App is not installed on", async () => {
    const bare = await orgRow({ login: "heig-uninstalled", githubOrgId: 803 });
    const res = await call("PUT", `/app/api/classrooms/${room}/github`, teacher, { orgId: bare.id });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "app_not_installed" });
  });

  it("is held by a journal: no other organization, no disconnect (D28)", async () => {
    await server.app.db.insert(classroomJournals).values({
      classroomId: room,
      githubRepoId: 4242,
      fullName: "heig-link/journal",
      ref: "main",
      createdBy: teacher.id,
    });
    const moved = await call("PUT", `/app/api/classrooms/${room}/github`, teacher, { orgId: other.id });
    expect(moved.statusCode).toBe(409);
    expect(moved.json()).toMatchObject({ error: "journal_attached" });
    const dropped = await call("DELETE", `/app/api/classrooms/${room}/github`, teacher);
    expect(dropped.statusCode).toBe(409);
    expect(dropped.json()).toMatchObject({ error: "journal_attached" });

    await server.app.db.delete(classroomJournals).where(eq(classroomJournals.classroomId, room));
    expect((await call("DELETE", `/app/api/classrooms/${room}/github`, teacher)).statusCode).toBe(204);
    expect(await audits("github_org.unlink", room)).toHaveLength(1);
    const res = await call("GET", `/app/api/classrooms/${room}/github`, teacher);
    expect(res.json<GithubClassroom>().link).toBeNull();
  });
});

describe("the lazy healing", () => {
  it("resolves a missing installation, refreshes the plan and reads the checks, once a minute", async () => {
    const room = await classroom("heal");
    const imported = await orgRow({ login: "heig-imported" });
    await link(room, imported.id);
    orgs = [{ githubOrgId: 901, login: "heig-imported", installationId: 111, selection: "selected", plan: "team", secret: false, exists: true }];

    const read = async () => (await call("GET", `/app/api/classrooms/${room}/github`, teacher)).json<GithubClassroom>();
    const first = await read();
    expect(first.link).toMatchObject({
      org: { id: imported.id, installed: true, status: "active", plan: "team" },
      checks: { allRepositories: false, llmSecret: "missing" },
    });
    expect(first.link!.org.avatarUrl).toBe(`/app/api/github/orgs/${imported.id}/avatar`);
    expect(await audits("github_org.installation_resolved", imported.id)).toHaveLength(1);

    // Within the minute: the stored row and the cached checks, no GitHub call.
    calls.length = 0;
    orgs[0]!.secret = true;
    expect((await read()).link!.checks.llmSecret).toBe("missing");
    expect(calls).toEqual([]);

    server.clock.advance(HEAL_TTL_MS);
    expect((await read()).link!.checks.llmSecret).toBe("present");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("follows a renamed organization by its id", async () => {
    const room = await classroom("heal-rename");
    const renamed = await orgRow({ login: "heig-old", githubOrgId: 911, installationId: 121, plan: "team" });
    await link(room, renamed.id);
    orgs = [{ githubOrgId: 911, login: "heig-new", installationId: 121, selection: "all", plan: "team", secret: true, exists: true }];
    const res = await call("GET", `/app/api/classrooms/${room}/github`, teacher);
    expect(res.json<GithubClassroom>().link!.org.login).toBe("heig-new");
    expect(await audits("github_org.renamed", renamed.id)).toHaveLength(1);
  });

  it("clears a vanished installation and marks a deleted organization", async () => {
    const room = await classroom("heal-gone");
    const gone = await orgRow({ login: "heig-deleted", githubOrgId: 921, installationId: 131, plan: "team" });
    await link(room, gone.id);
    orgs = [];
    const res = await call("GET", `/app/api/classrooms/${room}/github`, teacher);
    expect(res.json<GithubClassroom>().link).toMatchObject({
      org: { installed: false, status: "deleted" },
      checks: { allRepositories: null, llmSecret: "unknown" },
    });
    expect(await audits("github_org.installation_deleted", gone.id)).toHaveLength(1);
    expect(await audits("github_org.deleted", gone.id)).toHaveLength(1);
  });
});

describe("an organization's avatar", () => {
  let org: { id: string };
  const get = (who: Caller) => call("GET", `/app/api/github/orgs/${org.id}/avatar`, who);

  beforeAll(async () => {
    org = await orgRow({ login: "heig-avatar", githubOrgId: 1001, installationId: 141 });
  });

  it("is fetched by the server and served from here, cached", async () => {
    const res = await get(teacher);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers.location).toBeUndefined();
    expect(res.rawPayload.equals(PNG)).toBe(true);
    expect(calls).toEqual(["GET avatars.githubusercontent.com/u/1001"]);
    await get(colleague);
    expect(calls).toHaveLength(1);
  });

  it("never sends the browser to GitHub: a redirect or a non-image upstream is a 404", async () => {
    avatar = () => new Response(null, { status: 302, headers: { location: "https://github.com/x.png" } });
    const redirected = await get(teacher);
    expect(redirected.statusCode).toBe(404);
    expect(redirected.headers.location).toBeUndefined();

    resetGithubCaches();
    avatar = () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
    expect((await get(teacher)).statusCode).toBe(404);

    resetGithubCaches();
    // Declared an image, but the bytes are not one.
    avatar = () => new Response("<svg onload=alert(1)>", { status: 200, headers: { "content-type": "image/png" } });
    expect((await get(teacher)).statusCode).toBe(404);
  });

  it("is refused past its size cap", async () => {
    avatar = () =>
      new Response(Buffer.concat([PNG, Buffer.alloc(300 * 1024)]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    expect((await get(teacher)).statusCode).toBe(404);
  });

  it("is the staff's: a student gets the 404 of a missing image", async () => {
    expect((await get(student)).statusCode).toBe(404);
    expect(calls).toEqual([]);
  });
});
