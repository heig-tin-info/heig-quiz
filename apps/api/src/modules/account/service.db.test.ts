/**
 * The pseudonymization of an account (ADR-117, product owner 2026-11-05):
 * one student pseudonymized beside an untouched one, then every row of
 * every table searched for the identity it had; what it did still there
 * under the same id; the refusals; the pool succession of a staff account;
 * a GitHub revocation that fails writes nothing; the last activity. The
 * sign-in and the session of a pseudonymized account:
 * `auth/anonymized.db.test.ts`.
 */
import { randomUUID } from "node:crypto";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { defaultProjectGradingScale } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { SYSTEM_ACTOR } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { attempts, auditLog, courseStaff, drillCards, enrollments, poolMembers, pools, users } from "../../db/schema.js";
import { testApp, testDatabase } from "../../test/db.js";
import { tableDumps, tablesHolding } from "../../test/everything.js";
import { fakeShort } from "../../test/fakeType.js";
import { seedDrillCard } from "../../test/drill.js";
import { handIn, seedLive, type Seeded } from "../../test/live.js";
import { rosterRefusal } from "../org/errors.js";
import * as org from "../org/service.js";
import { lastActivity, pseudonymizeUser, type PseudonymizeContext } from "./service.js";

vi.mock("../org/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../org/service.js")>();
  return { ...actual, revokeAccountAccess: vi.fn(actual.revokeAccountAccess) };
});

const NOW = new Date("2026-11-05T09:00:00Z");
// No GitHub App: a grant's revocation is traced as skipped, as with the App off.
const config = {
  GITHUB_APP_ID: "",
  GITHUB_APP_PRIVATE_KEY_PATH: "",
  SUPER_ADMIN_EMAIL: "",
  STAFF_AFFILIATION_DOMAINS: ["heig-vd.ch"],
} as unknown as AppConfig;

let db: Db;
let pg: PGlite;
let ctx: (by: PseudonymizeContext["by"]) => PseudonymizeContext;

let restore: () => void;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  ({ db, client: pg } = await testDatabase());
  const app = await testApp(db);
  ctx = (by) => ({ by, actor: SYSTEM_ACTOR, config, log: app.log, now: NOW });
});

afterAll(() => restore());

const exec = (sql: string, params: unknown[] = []) => pg.query(sql, params);

/** The credentials that are not a session: a launch ticket, an OAuth grant and request, a kiosk pairing in progress. */
const CREDENTIALS = ["launch_tickets", "oauth_grants", "oauth_requests", "kiosk_pairings"];

/** A person as production knows them, spread over every table that names them; their markers. */
async function identify(seed: Seeded, userId: string, who: string): Promise<Record<string, string>> {
  const m = {
    given: `Given${who}`,
    family: `Family${who}`,
    email: `${who.toLowerCase()}.real@heig-vd.ch`,
    second: `${who.toLowerCase()}.private@hes-so.ch`,
    sub: `sub-${who}-REAL`,
    eduId: `76${who.length}${who.charCodeAt(0)}0000@eduid.ch`,
    picture: `https://pictures.example/${who}.jpg`,
    avatar: `AVATAR-${who}-MARKER`,
    aad: `aad-${who}-REAL`,
    teams: `${who} Teamsname`,
    login: `${who.toLowerCase()}-gh`,
    githubId: String(4_000_000_000 + who.charCodeAt(0)),
    note: `NOTE-${who}-MARKER`,
  };
  await exec(
    `UPDATE users SET oidc_sub = $2, email = $3, email_verified = true, given_name = $4, family_name = $5,
       swiss_edu_id = $6, picture_url = $7, notification_email = $8 WHERE id = $1`,
    [userId, m.sub, m.email, m.given, m.family, m.eduId, m.picture, m.second],
  );
  await exec(`INSERT INTO user_emails (user_id, email, source, verified) VALUES ($1, $2, 'login', true), ($1, $3, 'mail', true)`, [
    userId,
    m.email,
    m.second,
  ]);
  await exec(`INSERT INTO user_idp_claims (user_id, claims, affiliations) VALUES ($1, $2, ARRAY['student@heig-vd.ch'])`, [
    userId,
    JSON.stringify({ given_name: m.given, email: m.email, swissEduPersonUniqueID: m.eduId }),
  ]);
  await exec(`INSERT INTO avatars (user_id, data, content_type) VALUES ($1, convert_to($2, 'UTF8'), 'image/png')`, [userId, m.avatar]);
  await exec(`INSERT INTO teams_links (user_id, tenant_id, aad_object_id, teams_name, teams_username) VALUES ($1, 'tenant', $2, $3, $4)`, [
    userId,
    m.aad,
    m.teams,
    m.email,
  ]);
  await exec(
    `INSERT INTO teams_link_tokens (token_hash, tenant_id, aad_object_id, teams_name, teams_username, created_at, expires_at)
     VALUES ($1, 'tenant', $2, $3, $4, now(), now() + interval '1 hour')`,
    [`token-${who}`, m.aad, m.teams, m.email],
  );
  await exec(`INSERT INTO github_accounts (user_id, github_user_id, login) VALUES ($1, $2, $3)`, [userId, m.githubId, m.login]);
  const [line] = await db.select().from(enrollments).where(eq(enrollments.userId, userId));
  await exec(`UPDATE enrollments SET email = $2, prenom = $3, nom = $4, note = $5 WHERE id = $1`, [line!.id, m.email, m.given, m.family, m.note]);
  // A project repository named after its student, and its access.
  const [org, project, repo] = [randomUUID(), randomUUID(), randomUUID()];
  await exec(`INSERT INTO github_organizations (id, login, github_org_id, installation_id) VALUES ($1, $2, $3, NULL)`, [
    org,
    `heig-${who.toLowerCase()}`,
    who.charCodeAt(0),
  ]);
  await exec(
    `INSERT INTO projects (id, classroom_id, org_id, name, slug, state, start_at, deadline_at, source_repo_id, source_full_name, branches, protected_files, grading_scale, created_by)
     VALUES ($1, $2, $3, 'lab', $4, 'published', now(), now(), 1, 'heig/lab', ARRAY['main'], ARRAY[]::text[], $5, $6)`,
    [project, seed.classroomId, org, `lab-${who.toLowerCase()}`, JSON.stringify(defaultProjectGradingScale()), seed.teacherId],
  );
  await exec(`INSERT INTO project_repos (id, project_id, user_id, github_repo_id, full_name, accepted_at) VALUES ($1, $2, $3, $4, $5, now())`, [
    repo,
    project,
    userId,
    who.charCodeAt(0),
    `heig/lab-${m.login}`,
  ]);
  await exec(
    `INSERT INTO project_repo_access (id, repo_id, enrollment_id, github_user_id, github_login, invited_at) VALUES ($1, $2, $3, $4, $5, now())`,
    [randomUUID(), repo, line!.id, m.githubId, m.login],
  );
  // Credentials and traces of use.
  await exec(`INSERT INTO sessions (sid_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [
    who.charAt(0).toLowerCase().repeat(64),
    userId,
  ]);
  await exec(`INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope) VALUES ($1, $2, 'cli', $3, 'q_', 'quiz')`, [
    randomUUID(),
    userId,
    who.charAt(0).toUpperCase().repeat(64),
  ]);
  const hash = (c: string) => `${c}${who}`.padEnd(64, "0");
  await exec(
    `INSERT INTO launch_tickets (id, secret_hash, kind, user_id, created_at, expires_at) VALUES ($1, $2, 'seb', $3, now(), now() + interval '5 minutes')`,
    [randomUUID(), hash("a"), userId],
  );
  const client = `client-${who}`;
  await exec(`INSERT INTO oauth_clients (id, kind, name, redirect_uris) VALUES ($1, 'dcr', 'Claude', ARRAY['https://claude.example/cb'])`, [client]);
  await exec(
    `INSERT INTO oauth_grants (id, user_id, client_id, scope, resource, refresh_hash, expires_at) VALUES ($1, $2, $3, 'quiz', 'mcp', $4, now() + interval '30 days')`,
    [randomUUID(), userId, client, hash("b")],
  );
  await exec(
    `INSERT INTO oauth_requests (id, client_id, redirect_uri, code_challenge, scope, resource, expires_at, user_id)
     VALUES ($1, $2, 'https://claude.example/cb', 'challenge', 'quiz', 'mcp', now() + interval '1 minute', $3)`,
    [randomUUID(), client, userId],
  );
  const device = randomUUID();
  await exec(`INSERT INTO kiosk_devices (id, google_device_id, label, status) VALUES ($1, $2, 'Poste', 'active')`, [device, `device-${who}`]);
  await exec(
    `INSERT INTO kiosk_pairings (id, device_id, device_code_hash, user_code_hash, state, user_id, expires_at)
     VALUES ($1, $2, $3, $4, 'approved', $5, now() + interval '5 minutes')`,
    [randomUUID(), device, hash("c"), hash("d"), userId],
  );
  await exec(`INSERT INTO presence_hours (user_id, hour) VALUES ($1, date_trunc('hour', now()))`, [userId]);
  await exec(`INSERT INTO presence_last_seen (user_id, at) VALUES ($1, now())`, [userId]);
  await exec(`INSERT INTO notification_preferences (user_id, kind, channel, enabled) VALUES ($1, 'pool_shared', 'email', false)`, [userId]);
  await exec(`INSERT INTO user_course_prefs (user_id, course_id, hidden_at) VALUES ($1, $2, now())`, [userId, seed.courseId]);
  await exec(`INSERT INTO notifications (id, user_id, payload) VALUES ($1, $2, $3)`, [
    randomUUID(),
    userId,
    JSON.stringify({ kind: "pool_shared", poolName: "P", byName: m.given }),
  ]);
  // What the audit log already says of them, kept (ADR-003 §5).
  await exec(
    `INSERT INTO audit_log (actor_user_id, actor_type, action, subject_type, subject_id, payload)
     VALUES ($1, 'user', 'roster.claim', 'enrollment', $2, $3)`,
    [userId, line!.id, JSON.stringify({ email: m.email, name: `${m.given} ${m.family}`, sub: m.sub, login: m.login })],
  );
  return m;
}

describe("pseudonymizeUser", () => {
  it("leaves the identity in the audit log and the repositories' names only, keeps what the student did, and touches nobody else", async () => {
    const seed = await seedLive(db, { students: 2, mode: "exercise" });
    const [alice, bob] = seed.studentIds as [string, string];
    const aliceIdentity = await identify(seed, alice, "Alice");
    const aliceMarkers = Object.values(aliceIdentity);
    const bobMarkers = Object.values(await identify(seed, bob, "Bob"));
    await handIn(db, seed, NOW);
    await seedDrillCard(db, seed, alice, seed.questionIds[0]!);
    const kept = async (userId: string) => ({
      attempts: (await db.select({ id: attempts.id }).from(attempts).where(eq(attempts.userId, userId))).length,
      cards: (await db.select({ id: drillCards.id }).from(drillCards).where(eq(drillCards.userId, userId))).length,
      seats: (await db.select({ id: enrollments.id }).from(enrollments).where(eq(enrollments.userId, userId))).map((e) => e.id),
    });
    const aliceBefore = await kept(alice);
    expect(aliceBefore.attempts).toBeGreaterThan(0);
    expect(aliceBefore.cards).toBeGreaterThan(0);
    const bobBefore = (await exec("SELECT * FROM users WHERE id = $1", [bob])).rows;
    const before = await tableDumps(pg);
    for (const marker of [...aliceMarkers, ...bobMarkers]) expect(tablesHolding(before, marker), marker).not.toEqual([]);

    await pseudonymizeUser(db, alice, ctx("self"));

    const after = await tableDumps(pg);
    // The audit log keeps what it said (ADR-003 §5); the repository on
    // GitHub keeps its name, and so does its row, which holds the GitHub
    // login and nothing else of her (ADR-117 §8).
    for (const marker of aliceMarkers) {
      const allowed = marker === aliceIdentity["login"] ? ["public.audit_log", "public.project_repos"] : ["public.audit_log"];
      for (const table of tablesHolding(after, marker)) expect(allowed, `${marker} in ${table}`).toContain(table);
    }
    expect(tablesHolding(after, "alice.real@heig-vd.ch")).toEqual(["public.audit_log"]);
    expect(tablesHolding(after, "sub-Alice-REAL")).toEqual(["public.audit_log"]);
    expect(tablesHolding(after, "alice-gh")).toEqual(["public.audit_log", "public.project_repos"]);
    // Bob, untouched: every marker where it was, his account as it was.
    for (const marker of bobMarkers) expect(tablesHolding(after, marker), marker).toEqual(tablesHolding(before, marker));
    expect((await exec("SELECT * FROM users WHERE id = $1", [bob])).rows).toEqual(bobBefore);

    // What Alice did, under the same id; her account, pseudonymous.
    expect(await kept(alice)).toEqual(aliceBefore);
    const [row] = (await exec("SELECT oidc_sub, email, given_name, family_name, swiss_edu_id, picture_url, notification_email, anonymized_at FROM users WHERE id = $1", [alice])).rows as Record<string, unknown>[];
    expect(row).toMatchObject({
      oidc_sub: `anon-${alice}`,
      email: `anon-${alice}@example.invalid`,
      given_name: "Anonymous",
      family_name: alice.slice(0, 8),
      swiss_edu_id: null,
      picture_url: null,
      notification_email: null,
    });
    expect(row!["anonymized_at"]).not.toBeNull();
    for (const table of [...CREDENTIALS, "sessions", "api_tokens", "presence_hours", "presence_last_seen", "notification_preferences", "user_course_prefs", "notifications", "avatars", "teams_links"]) {
      expect((await exec(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [alice])).rows, table).toEqual([{ n: 0 }]);
      expect((await exec(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [bob])).rows, table).not.toEqual([{ n: 0 }]);
    }
    const entries = await db.select().from(auditLog).where(eq(auditLog.action, "user.anonymized"));
    expect(entries.map((e) => [e.subjectId, e.payload])).toEqual([[alice, { userId: alice, by: "self" }]]);

    // Once only.
    await expect(pseudonymizeUser(db, alice, ctx("self"))).rejects.toMatchObject({ code: "already_anonymized" });
  });

  it("refuses an account with an exam attempt in progress, or with a seat in a classroom still running", async () => {
    const seed = await seedLive(db, { students: 2 });
    const [busy, seated] = seed.studentIds as [string, string];
    await exec(`UPDATE evaluations SET state = 'running' WHERE id = $1`, [seed.evaluationId]);
    await db.insert(attempts).values({ id: randomUUID(), evaluationId: seed.evaluationId, userId: busy, state: "in_progress", seed: 1 });
    await expect(pseudonymizeUser(db, busy, ctx("self"))).rejects.toMatchObject({ code: "open_attempt", status: 409 });
    await exec(`UPDATE classrooms SET period_start = '2026-09', period_end = '2099-01' WHERE id = $1`, [seed.classroomId]);
    await expect(pseudonymizeUser(db, seated, ctx("self"))).rejects.toMatchObject({ code: "running_classroom" });
    // Archived, or over, it no longer holds anyone.
    await exec(`UPDATE classrooms SET period_end = '2026-01', period_start = '2025-09' WHERE id = $1`, [seed.classroomId]);
    await pseudonymizeUser(db, seated, ctx("self"));
    const [row] = await db.select({ anonymizedAt: users.anonymizedAt }).from(users).where(eq(users.id, seated));
    expect(row!.anonymizedAt).not.toBeNull();
  });

  it("never waits for an exercise attempt left in progress, nor for an exam the ticker closed", async () => {
    const exercise = await seedLive(db, { students: 1, questions: 0, mode: "exercise" });
    const exam = await seedLive(db, { students: 1, questions: 0, studentIds: exercise.studentIds });
    const [student] = exercise.studentIds as [string];
    await exec(`UPDATE evaluations SET state = 'running' WHERE id = $1`, [exercise.evaluationId]);
    await exec(`UPDATE evaluations SET state = 'closed' WHERE id = $1`, [exam.evaluationId]);
    for (const { evaluationId } of [exercise, exam]) {
      await db.insert(attempts).values({ id: randomUUID(), evaluationId, userId: student, state: "in_progress", seed: 1 });
    }
    await pseudonymizeUser(db, student, ctx("self"));
    const [row] = await db.select({ anonymizedAt: users.anonymizedAt }).from(users).where(eq(users.id, student));
    expect(row!.anonymizedAt).not.toBeNull();
  });

  it("refuses a staff account unless an administrator asks, who hands its pools over and keeps its course seats", async () => {
    const seed = await seedLive(db, { students: 2, questions: 0 });
    // Staff whatever the stored role: a pool seat, a grant under a second address.
    const [member, granted] = seed.studentIds as [string, string];
    await db.insert(poolMembers).values({ poolId: seed.poolId, userId: member, role: "reader" });
    await exec(`INSERT INTO user_emails (user_id, email, source, verified) VALUES ($1, 'granted.second@hes-so.ch', 'mail', true)`, [granted]);
    await exec(`INSERT INTO teacher_grants (id, email, created_by) VALUES ($1, 'granted.second@hes-so.ch', $2)`, [randomUUID(), seed.teacherId]);
    for (const userId of [member, granted]) {
      await expect(pseudonymizeUser(db, userId, ctx("self")), userId).rejects.toMatchObject({ code: "staff" });
    }
    await db.delete(poolMembers).where(eq(poolMembers.userId, member));
    const heir = randomUUID();
    await db.insert(users).values({ id: heir, oidcSub: `heir-${heir}`, email: `heir-${heir}@heig.test`, role: "teacher" });
    await db.insert(poolMembers).values({ poolId: seed.poolId, userId: heir, role: "contributor" });
    for (const by of ["self", "lifecycle"] as const) {
      await exec(`UPDATE users SET inactivity_notified_at = now() - interval '13 months' WHERE id = $1`, [seed.teacherId]);
      await expect(pseudonymizeUser(db, seed.teacherId, ctx(by)), by).rejects.toMatchObject({ code: "staff" });
    }
    await pseudonymizeUser(db, seed.teacherId, ctx("admin"));
    const [pool] = await db.select({ ownerId: pools.ownerId }).from(pools).where(eq(pools.id, seed.poolId));
    expect(pool!.ownerId).toBe(heir);
    expect(await db.select().from(courseStaff).where(eq(courseStaff.userId, seed.teacherId))).toHaveLength(1);
    const [notice] = (await exec(`SELECT payload FROM notifications WHERE user_id = $1`, [heir])).rows as { payload: { fromName: string } }[];
    expect(notice!.payload.fromName).toContain("Anonymous");
    const [transfer] = await db.select().from(auditLog).where(eq(auditLog.subjectId, seed.poolId));
    expect(transfer).toMatchObject({ action: "pool.transfer", payload: { from: seed.teacherId, to: heir, reason: "owner_pseudonymized" } });
  });

  it("pseudonymizes for the lifecycle only twelve months after the notice, and never once a sign-in ended the dormancy", async () => {
    const seed = await seedLive(db, { students: 2, questions: 0 });
    const [dormant, back] = seed.studentIds as [string, string];
    await exec(`UPDATE users SET inactivity_notified_at = now() - interval '11 months' WHERE id = $1`, [dormant]);
    await expect(pseudonymizeUser(db, dormant, ctx("lifecycle"))).rejects.toMatchObject({ code: "not_due" });
    await expect(pseudonymizeUser(db, back, ctx("lifecycle"))).rejects.toMatchObject({ code: "not_due" });
    await exec(`UPDATE users SET inactivity_notified_at = now() - interval '12 months 1 day' WHERE id = $1`, [dormant]);
    await pseudonymizeUser(db, dormant, ctx("lifecycle"));
    const entries = await db.select().from(auditLog).where(eq(auditLog.subjectId, dormant));
    expect(entries.filter((e) => e.action === "user.anonymized").map((e) => [e.actorType, e.payload])).toEqual([
      ["system", { userId: dormant, by: "lifecycle" }],
    ]);
  });

  it("writes nothing when GitHub does not take an access away", async () => {
    const seed = await seedLive(db, { students: 1, questions: 0 });
    const [student] = seed.studentIds as [string];
    const before = (await exec("SELECT * FROM users WHERE id = $1", [student])).rows;
    vi.mocked(org.revokeAccountAccess).mockRejectedValueOnce(rosterRefusal("revoke_failed", { repo: "heig/lab-x" }));
    await expect(pseudonymizeUser(db, student, ctx("admin"))).rejects.toMatchObject({ code: "revoke_failed", status: 502 });
    expect((await exec("SELECT * FROM users WHERE id = $1", [student])).rows).toEqual(before);
    expect(await db.select().from(auditLog).where(eq(auditLog.subjectId, student))).toEqual([]);
  });
});

describe("lastActivity", () => {
  it("is the latest of the sign-in, the last own request and the tokens' use; the creation when none", async () => {
    const id = randomUUID();
    await db.insert(users).values({ id, oidcSub: `idle-${id}`, email: `idle-${id}@heig.test`, createdAt: new Date("2023-01-01T00:00:00Z") });
    const last = async () => (await db.select({ at: lastActivity() }).from(users).where(eq(users.id, id)))[0]!.at;
    expect(await last()).toEqual(new Date("2023-01-01T00:00:00Z"));
    await db.update(users).set({ lastLoginAt: new Date("2024-01-01T00:00:00Z") }).where(eq(users.id, id));
    await exec(`INSERT INTO presence_last_seen (user_id, at) VALUES ($1, '2024-06-01T00:00:00Z')`, [id]);
    expect(await last()).toEqual(new Date("2024-06-01T00:00:00Z"));
    await exec(
      `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, last_used_at) VALUES ($1, $2, 'cli', $3, 'q_', 'quiz', '2025-02-01T00:00:00Z')`,
      [randomUUID(), id, randomUUID().replace(/-/g, "").padEnd(64, "0")],
    );
    expect(await last()).toEqual(new Date("2025-02-01T00:00:00Z"));
  });
});
