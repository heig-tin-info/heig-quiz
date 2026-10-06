/**
 * The `github` module (M2-02) against a fake GitHub (`github/testing.ts`):
 * a real RSA key signs the App's JWT, and a stubbed global fetch answers the
 * routes the adapters call and the avatar host. No network is ever reached.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { NotificationPayload, type GithubClassroom, type GithubOrg } from "@quiz/contracts";

import {
  auditLog,
  classroomJournals,
  enrollments,
  githubClassroomLinks,
  githubOrganizations,
  notifications,
} from "../../db/schema.js";
import {
  appKey,
  AVATAR_HOST,
  avatarRoute,
  fakeGithub,
  orgsRoute,
  type FakeOrg,
} from "../../github/testing.js";
import { testServer, type Payload, type TestServer } from "../../test/http.js";
import { addStaff, createClassroom, createCourse } from "../org/service.js";
import { SETUPS_PER_WINDOW } from "./routes.js";
import { HEAL_TTL_MS, resetGithubCaches } from "./service.js";

/** The smallest header `sniffImage` reads as a PNG. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8),
  Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]),
]);
const png = () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });

const gh = fakeGithub();
const key = appKey();
let orgs: FakeOrg[] = [];
let avatar: () => Response = png;

const installedOrg = (githubOrgId: number, login: string, installationId: number, more: Partial<FakeOrg> = {}): FakeOrg => ({
  githubOrgId,
  login,
  installationId,
  selection: "all",
  plan: "team",
  secret: true,
  exists: true,
  ...more,
});

// ---------------------------------------------------------------- the world

type Caller = Awaited<ReturnType<TestServer["signIn"]>>;

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

async function orgById(id: string) {
  const [row] = await server.app.db.select().from(githubOrganizations).where(eq(githubOrganizations.id, id));
  return row!;
}

async function link(classroomId: string, orgId: string) {
  await server.app.db
    .insert(githubClassroomLinks)
    .values({ classroomId, orgId, linkedBy: teacher.id, linkedAt: server.clock.now() });
}

async function linkedOrgOf(classroomId: string) {
  const [row] = await server.app.db
    .select({ orgId: githubClassroomLinks.orgId })
    .from(githubClassroomLinks)
    .where(eq(githubClassroomLinks.classroomId, classroomId));
  return row?.orgId;
}

async function audits(action: string, subjectId: string) {
  return server.app.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.subjectId, subjectId)));
}

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  server = await testServer({
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY_PATH: key.pem,
    GITHUB_APP_SLUG: "quiz-test",
  });
  [teacher, colleague, outsider, student] = await Promise.all([
    server.signIn("teacher"),
    server.signIn("teacher"),
    server.signIn("teacher"),
    server.signIn("student"),
  ]);
  courseId = (await createCourse(server.app.db, { name: "Prog 1", code: "PRG1" }, teacher.id))!.id;
  await addStaff(server.app.db, courseId, colleague.id, "owner");
  await createCourse(server.app.db, { name: "Other", code: "OTH1" }, outsider.id);
});

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  key.remove();
});

beforeEach(() => {
  resetGithubCaches();
  orgs = [];
  avatar = png;
  gh.reset();
  gh.routes = [orgsRoute(() => orgs), avatarRoute(() => avatar())];
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
      expect(gh.calls).toEqual([]);
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
    expect(res.headers.location).toBe(`/classrooms/${room}/settings?connect=1`);
    expect(gh.calls).toContain("GET api.github.com/app/installations/9999");
    const rows = await server.app.db
      .select()
      .from(githubOrganizations)
      .where(eq(githubOrganizations.installationId, 9999));
    expect(rows).toEqual([]);
  });

  it("records a confirmed installation once, however often GitHub returns", async () => {
    orgs = [installedOrg(601, "heig-setup", 81, { plan: "free", secret: false })];
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

  it("lands on the connect sheet, naming the organization it recorded", async () => {
    const room = await classroom("setup-return");
    orgs = [installedOrg(611, "heig-return", 191)];
    const res = await setup(`installation_id=191&setup_action=install&state=${room}`);
    expect(res.statusCode).toBe(303);
    const [row] = await server.app.db.select().from(githubOrganizations).where(eq(githubOrganizations.githubOrgId, 611));
    expect(res.headers.location).toBe(`/classrooms/${room}/settings?connect=1&installed=${row!.id}`);
    // Nothing recorded (a non-owner's request): the sheet alone.
    const asked = await setup(`setup_action=request&state=${room}`);
    expect(asked.headers.location).toBe(`/classrooms/${room}/settings?connect=1`);
    // No state: home, installation or not.
    expect((await setup("installation_id=191")).headers.location).toBe("/");
  });

  it("never redirects outside the application, whatever `state` says", async () => {
    for (const state of ["https://evil.example/x", "//evil.example", "/\\evil.example", "/admin", "javascript:alert(1)"]) {
      const res = await setup(`state=${encodeURIComponent(state)}`);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location, state).toBe("/");
    }
  });

  it("never hands a known organization's row to another one that took its login", async () => {
    const room = await classroom("setup-reused");
    const ours = await orgRow({ login: "heig-reused-setup", githubOrgId: 1201 });
    await link(room, ours.id);
    orgs = [installedOrg(1202, "heig-reused-setup", 161)];
    expect((await setup("installation_id=161")).statusCode).toBe(303);

    const retired = await orgById(ours.id);
    expect(retired).toMatchObject({ githubOrgId: 1201, status: "deleted", installationId: null });
    expect(retired.login).toBe(`heig-reused-setup~${ours.id}`);
    expect(await linkedOrgOf(room)).toBe(ours.id);
    const [newcomer] = await server.app.db
      .select()
      .from(githubOrganizations)
      .where(eq(githubOrganizations.githubOrgId, 1202));
    expect(newcomer).toMatchObject({ login: "heig-reused-setup", installationId: 161 });
    expect(newcomer!.id).not.toBe(ours.id);
    expect(await audits("github_org.deleted", ours.id)).toHaveLength(1);
  });
});

describe("the organizations", () => {
  it("lists those where the App is installed, with a same-origin avatar", async () => {
    orgs = [installedOrg(701, "heig-listed", 91)];
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
    orgs = [installedOrg(801, "heig-link", 101), installedOrg(802, "heig-other", 102)];
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
    expect(await linkedOrgOf(room)).toBeUndefined();
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
      mode: "github",
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

    // A Quiz-mode journal needs no GitHub, and holds nothing (ADR-057, F-GH-04).
    await server.app.db
      .update(classroomJournals)
      .set({ mode: "quiz", githubRepoId: null, fullName: null, ref: null })
      .where(eq(classroomJournals.classroomId, room));
    expect((await call("DELETE", `/app/api/classrooms/${room}/github`, teacher)).statusCode).toBe(204);
    await server.app.db.delete(classroomJournals).where(eq(classroomJournals.classroomId, room));
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
    orgs = [installedOrg(901, "heig-imported", 111, { selection: "selected", secret: false })];

    const read = async () => (await call("GET", `/app/api/classrooms/${room}/github`, teacher)).json<GithubClassroom>();
    const first = await read();
    expect(first.link).toMatchObject({
      org: { id: imported.id, installed: true, status: "active", plan: "team" },
      checks: { allRepositories: false, llmSecret: "missing" },
    });
    expect(first.link!.org.avatarUrl).toBe(`/app/api/github/orgs/${imported.id}/avatar`);
    expect(await audits("github_org.installation_resolved", imported.id)).toHaveLength(1);

    // Within the minute: the stored row and the cached checks, no GitHub call.
    gh.calls.length = 0;
    orgs[0]!.secret = true;
    expect((await read()).link!.checks.llmSecret).toBe("missing");
    expect(gh.calls).toEqual([]);

    server.clock.advance(HEAL_TTL_MS);
    expect((await read()).link!.checks.llmSecret).toBe("present");
    expect(gh.calls.length).toBeGreaterThan(0);
  });

  it("follows a renamed organization by its id", async () => {
    const room = await classroom("heal-rename");
    const renamed = await orgRow({ login: "heig-old", githubOrgId: 911, installationId: 121, plan: "team" });
    await link(room, renamed.id);
    orgs = [installedOrg(911, "heig-new", 121)];
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

  it("tells the course staff once that the organization is lost, on the installation GitHub no longer has (F-NOTIF-13)", async () => {
    const room = await classroom("heal-lost");
    const gone = await orgRow({ login: "heig-heal-lost", githubOrgId: 931, installationId: 141, plan: "team" });
    await link(room, gone.id);
    const lost = async (userId: string) =>
      (
        await server.app.db
          .select({ payload: notifications.payload })
          .from(notifications)
          .where(eq(notifications.userId, userId))
      )
        .map((r) => NotificationPayload.parse(r.payload))
        .filter((p) => p.kind === "github_org_lost" && p.classroomId === room);
    orgs = [];
    expect((await call("GET", `/app/api/classrooms/${room}/github`, teacher)).statusCode).toBe(200);
    const entry = { kind: "github_org_lost", classroomId: room, classroomName: "heal-lost", orgLogin: "heig-heal-lost" };
    // The course's staff seats, each once; a teacher off the course never.
    expect(await lost(teacher.id)).toEqual([entry]);
    expect(await lost(colleague.id)).toEqual([entry]);
    expect(await lost(outsider.id)).toEqual([]);
    // Healed again past the minute: the installation is already forgotten, nobody is told twice.
    server.clock.advance(HEAL_TTL_MS);
    expect((await call("GET", `/app/api/classrooms/${room}/github`, teacher)).statusCode).toBe(200);
    expect(await lost(teacher.id)).toEqual([entry]);
  });

  it("keeps a suspended installation it heals or lists, shown uninstalled, and tells nobody it is lost", async () => {
    const room = await classroom("heal-suspended");
    const org = await orgRow({ login: "heig-paused", githubOrgId: 951, installationId: 171, plan: "team" });
    await link(room, org.id);
    const lost = async (userId: string) =>
      (
        await server.app.db
          .select({ payload: notifications.payload })
          .from(notifications)
          .where(eq(notifications.userId, userId))
      )
        .map((r) => NotificationPayload.parse(r.payload))
        .filter((p) => p.kind === "github_org_lost" && p.classroomId === room);
    orgs = [installedOrg(951, "heig-paused", 171, { suspended: true })];
    // The healing, before any webhook: suspended, kept, not acting.
    const healed = await call("GET", `/app/api/classrooms/${room}/github`, teacher);
    expect(healed.json<GithubClassroom>().link).toMatchObject({
      org: { id: org.id, installed: false, status: "active" },
      checks: { allRepositories: null, llmSecret: "unknown" },
    });
    expect(await orgById(org.id)).toMatchObject({ installationId: 171, status: "active" });
    expect((await orgById(org.id)).suspendedAt).not.toBeNull();
    expect(await lost(teacher.id)).toEqual([]);
    expect(await audits("github_org.installation_suspended", org.id)).toHaveLength(1);
    // The listing: kept too, and not offered to connect.
    const listed = (await call("GET", "/app/api/github/orgs", teacher)).json<GithubOrg[]>();
    expect(listed.map((o) => o.id)).not.toContain(org.id);
    expect(await orgById(org.id)).toMatchObject({ installationId: 171 });
    expect(await lost(teacher.id)).toEqual([]);
    // Nor can a classroom connect to it meanwhile.
    const other = await classroom("heal-suspended-other");
    expect((await call("PUT", `/app/api/classrooms/${other}/github`, teacher, { orgId: org.id })).json()).toMatchObject({ error: "app_not_installed" });
    // Lifted: acting again, audited once more, still nobody told.
    orgs = [installedOrg(951, "heig-paused", 171)];
    server.clock.advance(HEAL_TTL_MS);
    expect((await call("GET", `/app/api/classrooms/${room}/github`, teacher)).json<GithubClassroom>().link!.org.installed).toBe(true);
    expect((await orgById(org.id)).suspendedAt).toBeNull();
    expect(await audits("github_org.installation_suspended", org.id)).toHaveLength(2);
    expect(await lost(teacher.id)).toEqual([]);
  });

  it("never re-points a known organization at another one that took its login", async () => {
    const room = await classroom("heal-reused");
    // Ours (id 1101) is uninstalled; GitHub now gives its login to 1102, installed.
    const ours = await orgRow({ login: "heig-reused", githubOrgId: 1101 });
    await link(room, ours.id);
    orgs = [installedOrg(1102, "heig-reused", 151)];

    const res = await call("GET", `/app/api/classrooms/${room}/github`, teacher);
    expect(res.json<GithubClassroom>().link).toMatchObject({
      org: { id: ours.id, installed: false, status: "deleted" },
      checks: { allRepositories: null, llmSecret: "unknown" },
    });
    expect(await orgById(ours.id)).toMatchObject({ githubOrgId: 1101, installationId: null, status: "deleted" });
    // The classroom stays on its own organization, now deleted.
    expect(await linkedOrgOf(room)).toBe(ours.id);
    const [newcomer] = await server.app.db
      .select()
      .from(githubOrganizations)
      .where(eq(githubOrganizations.githubOrgId, 1102));
    expect(newcomer).toMatchObject({ login: "heig-reused", installationId: 151 });
    expect(newcomer!.id).not.toBe(ours.id);
    expect(await audits("github_org.installation_resolved", ours.id)).toEqual([]);
  });
});

describe("an organization's avatar", () => {
  let org: { id: string };
  const get = (who: Caller) => call("GET", `/app/api/github/orgs/${org.id}/avatar`, who);
  const avatarInits = () => gh.inits.filter((_, i) => gh.calls[i]!.includes(AVATAR_HOST));

  beforeAll(async () => {
    org = await orgRow({ login: "heig-avatar", githubOrgId: 1001, installationId: 141 });
  });

  it("is fetched by the server and served from here, inert, cached", async () => {
    const res = await get(teacher);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["content-type"]).not.toMatch(/svg/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(res.headers.location).toBeUndefined();
    expect(res.rawPayload.equals(PNG)).toBe(true);
    expect(gh.calls).toEqual([`GET ${AVATAR_HOST}/u/1001`]);
    // Never follows GitHub elsewhere.
    expect(avatarInits().map((i) => i.redirect)).toEqual(["error"]);
    await get(colleague);
    expect(gh.calls).toHaveLength(1);
  });

  it("never sends the browser to GitHub: a redirect or a non-image upstream is a 404", async () => {
    avatar = () => new Response(null, { status: 302, headers: { location: "https://github.com/x.png" } });
    const redirected = await get(teacher);
    expect(redirected.statusCode).toBe(404);
    expect(redirected.headers.location).toBeUndefined();

    // A failure is not kept: the next request asks again.
    avatar = () => new Response("<svg xmlns='http://www.w3.org/2000/svg'/>", { status: 200, headers: { "content-type": "image/svg+xml" } });
    expect((await get(teacher)).statusCode).toBe(404);

    avatar = () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
    expect((await get(teacher)).statusCode).toBe(404);

    // Declared an image, but the bytes are not one.
    avatar = () => new Response("<svg onload=alert(1)>", { status: 200, headers: { "content-type": "image/png" } });
    expect((await get(teacher)).statusCode).toBe(404);
    expect(avatarInits().every((i) => i.redirect === "error")).toBe(true);
    expect(avatarInits()).toHaveLength(4);
  });

  it("is refused past its size cap", async () => {
    avatar = () =>
      new Response(Buffer.concat([PNG, Buffer.alloc(300 * 1024)]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    expect((await get(teacher)).statusCode).toBe(404);
  });

  it("is the staff's, like the listing: a student is refused", async () => {
    expect((await get(student)).statusCode).toBe(403);
    expect(gh.calls).toEqual([]);
  });
});

// Last: it spends this address's allowance of the setup return.
describe("the setup return's rate limit", () => {
  it("answers 429 past its allowance per address, before calling GitHub", async () => {
    let limited = 0;
    for (let i = 0; i < SETUPS_PER_WINDOW + 1; i += 1) {
      if ((await call("GET", "/setup/github/installed?installation_id=77")).statusCode === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
    const calls = gh.calls.length;
    const res = await call("GET", "/setup/github/installed?installation_id=77");
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(gh.calls.length).toBe(calls);
  });
});
