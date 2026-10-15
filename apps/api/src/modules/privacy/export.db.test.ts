/**
 * The personal data export (N-DATA-04, ADR-112) over the real application
 * and migrations: the leak test of 05 §5.7 for the whole file — it composes
 * the student exits, so it must carry nothing they would not, whoever asks —
 * and who may ask.
 *
 * Seeded around Alice, a student of classroom A (and of an archived
 * classroom B): a released exam whose policy shows her answer, a released one
 * whose policy hides it, one under the policy `none`, one closed and not
 * released with a teacher's mark and comment, a draft, an open group set
 * with Bob in another group and Carol in none, a released project and a
 * draft one, and every row a teacher sees about her but she does not (the
 * integrity journal, the roster note, the edu-ID claims, an audit row, a
 * kiosk pairing, an LLM call). Searched for in the file of Alice, of a
 * teacher on a staff seat, and of an admin with Super Powers on a seat.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CSRF_COOKIE, PERSONAL_DATA_EXPORT_PATH, PersonalDataExport, type FeedbackPolicy, type SessionKind } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { audit } from "../../audit.js";
import { SESSION_COOKIE, createSession } from "../../auth/session.js";
import { createApiToken } from "../../auth/tokens.js";
import type { Db } from "../../db/client.js";
import {
  attemptEvents,
  attempts,
  auditLog,
  classrooms,
  enrollments,
  evaluationItems,
  evaluations,
  githubAccounts,
  githubOrganizations,
  groupSets,
  kioskPairings,
  llmCalls,
  presenceHours,
  presenceLastSeen,
  projectRepos,
  projects,
  studentGroupMembers,
  studentGroups,
  userEmails,
  userIdpClaims,
  users,
} from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type TestServer } from "../../test/http.js";
import { kioskStation } from "../../test/kiosk.js";
import { reload, seedLive, type Seeded } from "../../test/live.js";
import * as evaluationService from "../evaluation/service.js";
import { applyState, joinedItems } from "../evaluation/service.js";
import * as grading from "../grading/service.js";
import * as live from "../live/service.js";
import { FORBIDDEN_STUDENT_KEYS } from "../live/studentView.js";
import { loadConfig, typeOf } from "../pool/config.js";
import * as results from "../results/service.js";
import { EXPORTS_PER_HOUR } from "./routes.js";
import { ownGroupOnly } from "./service.js";

type Headers = Record<string, string>;
type Signed = { id: string; headers: Headers };

/** What a teacher sees about Alice, or what is not published: never in any file. */
const NEVER = {
  markComment: "MARK-COMMENT-5e1d",
  teacherComment: "TEACHER-ONLY-COMMENT-a2c4",
  seatNote: "SEAT-NOTE-77b0",
  integrity: "INTEGRITY-MARKER-0f9e",
  claim: "CLAIM-MARKER-3d21",
  affiliation: "AFFILIATION-MARKER-c6aa",
  audit: "AUDIT-MARKER-81fe",
  kiosk: "KIOSK-LABEL-MARKER-b912",
  llm: "LLM-MODEL-MARKER-4410",
  unverified: "unverified-marker-19aa@private.test",
  draftEvaluation: "DRAFT-EVAL-MARKER-6c03",
  draftProject: "DRAFT-PROJECT-MARKER-0be7",
  hiddenAnswer: "MINE-HIDDEN-ANSWER-9d3f",
  noneAnswer: "MINE-NONE-ANSWER-1b77",
  unreleasedAnswer: "MINE-UNRELEASED-ANSWER-e5a0",
  bobAnswer: "BOB-ANSWER-MARKER-24c8",
  bobName: "BOB-NAME-MARKER-7a1f",
  bobGroup: "BOB-GROUP-MARKER-5f30",
  bobRepo: "bob-repo-marker-c0d9",
  carolName: "CAROL-NAME-MARKER-e44b",
} as const;
/** Alice's own, published: in her file. */
const OWN = {
  shownAnswer: "MINE-SHOWN-ANSWER-3a90",
  group: "OWN-GROUP-8b52",
  releasedComment: "RELEASED-COMMENT-d7e1",
  verified: "alice-alt-7c3e@heig.test",
  githubLogin: "alice-gh-marker",
  archivedExam: "ARCHIVED-EXAM-4f2b",
} as const;
/** The answer keys of the seeded questions (`publishQuestion`), never shown: no policy here shows the key. */
const KEYS = ["answer-q0"];

let server: TestServer;
let restore: () => void;
let teacher: Signed;
let admin: Signed;
let alice: Signed;
let bob: Signed;
let carol: Signed;
let seed: Seeded;
let archived: Seeded;
let nextOrg = 92_000;
const ids: Record<string, string> = {};
const HOURS = ["2026-10-14T08:00:00.000Z", "2026-10-14T19:00:00.000Z"];
const BOB_HOUR = "2026-10-13T21:00:00.000Z";

const db = (): Db => server.app.db;
const exportOf = (headers: Headers) => server.app.inject({ method: "GET", url: PERSONAL_DATA_EXPORT_PATH, headers });

async function sessionOf(userId: string, auth: { kind: SessionKind; actorUserId?: string; evaluationId?: string; deviceId?: string }) {
  const session = await createSession(db(), userId, 8, {
    kind: auth.kind,
    actorUserId: auth.actorUserId ?? null,
    evaluationId: auth.evaluationId ?? null,
    projectId: null,
    deviceId: auth.deviceId ?? null,
  });
  return { cookie: `${SESSION_COOKIE}=${session.token}; ${CSRF_COOKIE}=${session.csrf}`, "x-csrf-token": session.csrf };
}

/** An evaluation of `classroomId` on the seeded question, worth 10 points, under `policy`. */
async function makeEvaluation(classroomId: string, title: string, policy: Partial<FeedbackPolicy>): Promise<string> {
  const created = await evaluationService.createEvaluation(db(), { classroomId, title, mode: "exam", createdBy: teacher.id });
  const stored = (await evaluationService.byId(db(), created.id))!;
  await evaluationService.addItems(
    db(),
    stored,
    [seed.questionIds[0]!],
    (type, version) => typeOf(type).defaultPoints(loadConfig(type, version)),
    { attemptCount: 0 },
  );
  const [item] = await joinedItems(db(), created.id);
  await db().update(evaluationItems).set({ points: 10 }).where(eq(evaluationItems.id, item!.item.id));
  await db()
    .update(evaluations)
    .set({ feedbackPolicy: { ...(stored.feedbackPolicy as object), ...policy } })
    .where(eq(evaluations.id, created.id));
  return created.id;
}

/** Each taker answers, hands in; the teacher closes, grades (with the key in the details) and releases when asked. */
async function play(id: string, takers: { userId: string; answer: string; points: number }[], release: boolean) {
  const now = server.clock.now();
  let evaluation = await applyState(db(), await reload(db(), id), "running", now);
  const [item] = await joinedItems(db(), id);
  const graded: { attemptId: string; points: number }[] = [];
  for (const { userId, answer, points } of takers) {
    const participant = (await live.participantOf(db(), evaluation, userId))!;
    const created = await live.ensureAttempt(db(), evaluation, participant, now);
    const attempt = await live.beginAttempt(db(), evaluation, created, participant, now);
    await live.saveAnswer(db(), { evaluation, attempt, itemId: item!.item.id, payload: answer, revision: 1, now });
    await live.submitAttempt(db(), evaluation, attempt, now);
    graded.push({ attemptId: attempt.id, points });
  }
  evaluation = await live.closeEvaluation(db(), evaluation, now, "teacher");
  for (const { attemptId, points } of graded) {
    await grading.writeGrading(db(), {
      attemptId,
      itemId: item!.item.id,
      answerId: null,
      points,
      maxPoints: 10,
      source: "manual",
      state: "validated",
      details: { matched: false, expected: KEYS[0] },
      now,
    });
  }
  if (release) await results.releaseResults(db(), await reload(db(), id), now);
  server.clock.advance(60_000);
}

async function seatOf(classroomId: string, userId: string): Promise<string> {
  const [row] = await db()
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(and(eq(enrollments.classroomId, classroomId), eq(enrollments.userId, userId)));
  return row!.id;
}

/** A project of classroom A in `state`, with a repository for each scored user. */
async function makeProject(name: string, state: "draft" | "locked", repos: { userId: string; fullName: string }[]): Promise<string> {
  const n = nextOrg++;
  const orgId = randomUUID();
  await db().insert(githubOrganizations).values({ id: orgId, login: `px-org-${n}`, githubOrgId: n, installationId: n });
  const id = randomUUID();
  const deadline = new Date("2026-10-09T22:00:00Z");
  await db().insert(projects).values({
    id,
    classroomId: seed.classroomId,
    orgId,
    name,
    slug: `px-${n}`,
    state,
    startAt: new Date("2026-10-01T08:00:00Z"),
    deadlineAt: deadline,
    deadlineAppliedAt: deadline,
    sourceRepoId: n,
    sourceFullName: `px-org-${n}/starter`,
    distributionRepoId: n + 1,
    distributionFullName: `px-org-${n}/dist`,
    branches: ["main"],
    protectedFiles: [],
    gradingMode: "auto",
    gradingScale: { kind: "linear", rounding: "nearest" },
    createdBy: teacher.id,
    ...(state === "locked" ? { releasedAt: new Date("2026-10-10T08:00:00Z"), releasedBy: teacher.id } : {}),
  });
  for (const [index, { userId, fullName }] of repos.entries()) {
    await db().insert(projectRepos).values({
      id: randomUUID(),
      projectId: id,
      userId,
      githubRepoId: n * 10 + index,
      fullName,
      defaultBranch: "main",
      provisionStatus: "ok",
      acceptedAt: new Date("2026-10-01T09:00:00Z"),
      invitationStatus: "accepted",
      rulesetId: n,
      deadlineAppliedAt: deadline,
      frozenAt: new Date("2026-10-09T22:30:00Z"),
      teacherPoints: 9,
      teacherMax: 10,
      teacherComment: NEVER.teacherComment,
      releasedPoints: 9,
      releasedMax: 10,
      releasedComment: OWN.releasedComment,
    });
  }
  return id;
}

/**
 * The forbidden keys of 05 §5.7 that hold a value in the question content of
 * the feedback pages: their `solution` and `explanation` slots exist, empty.
 */
function forbiddenValues(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const child of value) forbiddenValues(child, out);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_STUDENT_KEYS.includes(key) && child !== null) out.push(key);
      forbiddenValues(child, out);
    }
  }
  return out;
}

async function fileOf(headers: Headers) {
  const res = await exportOf(headers);
  expect(res.statusCode, res.body).toBe(200);
  return { res, body: res.body, file: PersonalDataExport.parse(res.json()) };
}

let aliceFile: Awaited<ReturnType<typeof fileOf>>;
let aliceAt: string;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  server.clock.set("2026-10-15T09:00:00.000Z");
  teacher = await server.signIn("teacher");
  admin = await server.signInWithSuperPowers();
  alice = await server.signIn("student");
  bob = await server.signIn("student");
  carol = await server.signIn("student");
  await db().update(users).set({ givenName: NEVER.bobName }).where(eq(users.id, bob.id));

  seed = await seedLive(db(), { teacherId: teacher.id, studentIds: [alice.id, bob.id, carol.id], questions: 1 });
  await db().update(enrollments).set({ nom: NEVER.bobName }).where(eq(enrollments.userId, bob.id));
  await db().update(enrollments).set({ nom: NEVER.carolName }).where(eq(enrollments.userId, carol.id));
  await db().update(enrollments).set({ note: NEVER.seatNote }).where(eq(enrollments.userId, alice.id));
  // The teacher on a staff seat (ADR-018), the admin on a student seat of their own.
  await db().insert(enrollments).values([
    { id: randomUUID(), classroomId: seed.classroomId, nom: "Seated", prenom: "Teacher", email: "seated@heig.test", userId: teacher.id, claimedAt: new Date(), staff: true },
    { id: randomUUID(), classroomId: seed.classroomId, nom: "Seated", prenom: "Admin", email: "admin-seat@heig.test", userId: admin.id, claimedAt: new Date() },
  ]);
  // The seeded evaluation stays a draft: nobody's file names it.
  await db().update(evaluations).set({ title: NEVER.draftEvaluation }).where(eq(evaluations.id, seed.evaluationId));

  ids["shown"] = await makeEvaluation(seed.classroomId, "Shown exam", { when: "on_release", showAnswer: true, showKey: false });
  await play(ids["shown"], [{ userId: alice.id, answer: OWN.shownAnswer, points: 8 }, { userId: bob.id, answer: NEVER.bobAnswer, points: 4 }], true);
  ids["hidden"] = await makeEvaluation(seed.classroomId, "Hidden exam", { when: "on_release", showAnswer: false, showKey: false });
  await play(ids["hidden"], [{ userId: alice.id, answer: NEVER.hiddenAnswer, points: 6 }], true);
  ids["none"] = await makeEvaluation(seed.classroomId, "Policy none exam", { when: "none" });
  await play(ids["none"], [{ userId: alice.id, answer: NEVER.noneAnswer, points: 7 }], true);
  // Closed, not released: 3/10 is a grade of 2.5 the student must not read.
  ids["unreleased"] = await makeEvaluation(seed.classroomId, "Unreleased exam", { when: "on_release" });
  await play(ids["unreleased"], [{ userId: alice.id, answer: NEVER.unreleasedAnswer, points: 3 }], false);
  const mark = await server.app.inject({
    method: "PUT",
    url: `/app/api/classrooms/${seed.classroomId}/gradebook/columns/evaluation/${ids["unreleased"]}/marks/${await seatOf(seed.classroomId, alice.id)}`,
    headers: teacher.headers,
    payload: { kind: "score", points: 1, max: 10, comment: NEVER.markComment, override: true },
  });
  expect(mark.statusCode, mark.body).toBe(200);

  // The archived classroom B, with a released exam of Alice's.
  archived = await seedLive(db(), { teacherId: teacher.id, studentIds: [alice.id], questions: 1 });
  await db().update(evaluations).set({ title: OWN.archivedExam, feedbackPolicy: { when: "on_release", showAnswer: true, showKey: false, showExplanation: false, showHiddenCaseNames: true, showTeacherComment: true } }).where(eq(evaluations.id, archived.evaluationId));
  await play(archived.evaluationId, [{ userId: alice.id, answer: "archived-answer", points: 5 }], true);
  await db().update(classrooms).set({ archivedAt: server.clock.now() }).where(eq(classrooms.id, archived.classroomId));

  // An open group set: Alice in her group, Bob in another, Carol in none.
  const setId = randomUUID();
  const at = server.clock.now();
  await db().insert(groupSets).values({ id: setId, classroomId: seed.classroomId, name: "Lab groups", maxSize: 3, openUntil: new Date(at.getTime() + 7 * 86_400_000), createdBy: teacher.id, createdAt: at });
  const own = randomUUID();
  const other = randomUUID();
  await db().insert(studentGroups).values([
    { id: own, setId, name: OWN.group, position: 0, createdAt: at },
    { id: other, setId, name: NEVER.bobGroup, position: 1, createdAt: at },
  ]);
  await db().insert(studentGroupMembers).values([
    { id: randomUUID(), setId, groupId: own, enrollmentId: await seatOf(seed.classroomId, alice.id), addedAt: at },
    { id: randomUUID(), setId, groupId: other, enrollmentId: await seatOf(seed.classroomId, bob.id), addedAt: at },
  ]);

  // Projects: a released one with Alice's and Bob's repositories, and a draft.
  ids["project"] = await makeProject("Released project", "locked", [
    { userId: alice.id, fullName: "px-org/alice-repo" },
    { userId: bob.id, fullName: `px-org/${NEVER.bobRepo}` },
  ]);
  await makeProject(NEVER.draftProject, "draft", []);

  // The drill of classroom A is on.
  const drill = await server.app.inject({ method: "PUT", url: `/app/api/classrooms/${seed.classroomId}/drill`, headers: teacher.headers, payload: { enabled: true } });
  expect(drill.statusCode, drill.body).toBe(200);

  // The three account rows (ADR-112 §2), and Bob's, which never appear in Alice's file.
  await db().insert(userEmails).values([
    { userId: alice.id, email: OWN.verified, source: "swissEduIDLinkedAffiliationMail", verified: true },
    { userId: alice.id, email: NEVER.unverified, source: "login", verified: false },
  ]);
  await db().insert(presenceHours).values([...HOURS.map((h) => ({ userId: alice.id, hour: new Date(h) })), { userId: bob.id, hour: new Date(BOB_HOUR) }]);
  await db().insert(presenceLastSeen).values({ userId: alice.id, at: new Date("2026-10-14T19:42:00.000Z") });
  await db().insert(githubAccounts).values({ userId: alice.id, githubUserId: 4_242_001, login: OWN.githubLogin });

  // What only the staff see about Alice.
  const [aliceAttempt] = await db()
    .select()
    .from(attempts)
    .where(and(eq(attempts.evaluationId, ids["shown"]!), eq(attempts.userId, alice.id)));
  await db().insert(attemptEvents).values({ id: randomUUID(), attemptId: aliceAttempt!.id, kind: "ip_change", details: { marker: NEVER.integrity } });
  await db().insert(userIdpClaims).values({ userId: alice.id, claims: { marker: NEVER.claim }, affiliations: [NEVER.affiliation] });
  await audit(db(), { actorUserId: teacher.id, actorType: "user", action: "roster.claim", subjectType: "user", subjectId: alice.id, payload: { marker: NEVER.audit } });
  const station = await kioskStation(server.app, { label: NEVER.kiosk });
  await db().insert(kioskPairings).values({
    id: randomUUID(),
    deviceId: station.deviceId,
    deviceCodeHash: randomBytes(32).toString("hex"),
    userCodeHash: randomBytes(32).toString("hex"),
    state: "approved",
    userId: alice.id,
    evaluationId: ids["shown"],
    expiresAt: new Date(server.clock.now().getTime() + 600_000),
  });
  await db().insert(llmCalls).values({ id: randomUUID(), userId: alice.id, purpose: "grade", provider: "anthropic", model: NEVER.llm, status: "ok", costUsd: 0.01 });

  aliceAt = server.clock.now().toISOString();
  aliceFile = await fileOf(alice.headers);
});

afterAll(async () => {
  await server.close();
  restore();
});

describe("GET /app/api/me/export — what the file holds (ADR-112 §3)", () => {
  it("is a download, never cached, parsed by its contract", () => {
    const { res, file } = aliceFile;
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="quiz-data-2026-10-15.json"');
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(file.version).toBe(1);
    expect(file.generatedAt).toBe(aliceAt);
  });

  it("holds the account, without its session, and the three account rows", () => {
    const { file, body } = aliceFile;
    expect(file.account.id).toBe(alice.id);
    expect(JSON.parse(body).account).not.toHaveProperty("session");
    expect(file.emails).toEqual([OWN.verified]);
    expect(file.github).toMatchObject({ login: OWN.githubLogin });
    expect(file.activity).toEqual({ hours: HOURS, lastActiveAt: "2026-10-14T19:42:00.000Z" });
  });

  it("lists every classroom of a claimed seat, the archived one included", () => {
    const { file } = aliceFile;
    const rooms = Object.fromEntries(file.classrooms.map((c) => [c.classroom.id, c]));
    expect(rooms[seed.classroomId]?.classroom.archived).toBe(false);
    expect(rooms[archived.classroomId]?.classroom.archived).toBe(true);
    expect(file.grades.flatMap((g) => g.rows).map((r) => r.title)).toContain(OWN.archivedExam);
  });

  it("builds the attempts from the feedback view: the shown answer, never a hidden one", () => {
    const { file, body } = aliceFile;
    const byEvaluation = new Map(file.feedback.map((f) => [f.evaluation.id, f]));
    expect(byEvaluation.get(ids["shown"]!)).toMatchObject({ available: true });
    expect(body).toContain(OWN.shownAnswer);
    // A policy that hides the answer: the title, dates and status, no answer of hers.
    const rows = file.grades.flatMap((g) => g.rows);
    const hidden = rows.find((r) => r.kind === "evaluation" && r.evaluationId === ids["hidden"]);
    expect(hidden).toMatchObject({ title: "Hidden exam", status: "released" });
    // Its feedback page is in the file: the answer is absent because the policy hides it, not because the page is.
    expect(byEvaluation.get(ids["hidden"]!)).toMatchObject({ available: true });
    expect(body).not.toContain(NEVER.hiddenAnswer);
    // The policy `none`: withheld, no feedback page at all.
    expect(rows.find((r) => r.kind === "evaluation" && r.evaluationId === ids["none"])).toMatchObject({ status: "withheld", score: null });
    expect(byEvaluation.has(ids["none"]!)).toBe(false);
    // Not released: no grade, no feedback.
    expect(rows.find((r) => r.kind === "evaluation" && r.evaluationId === ids["unreleased"])).toMatchObject({ status: "pending" });
    expect(byEvaluation.has(ids["unreleased"]!)).toBe(false);
  });

  it("holds her own group of an open set, never another group nor the students in none (§6)", () => {
    const { file, body } = aliceFile;
    const room = file.classrooms.find((c) => c.classroom.id === seed.classroomId)!;
    const [set] = room.groupSets.sets;
    expect(set!.groups.map((g) => g.name)).toEqual([OWN.group]);
    expect(set).not.toHaveProperty("unplaced");
    expect(body).not.toContain(NEVER.bobGroup);
    expect(body).not.toContain(NEVER.carolName);
  });

  it("holds her projects with the released score and comment, never the unreleased one", () => {
    const { file, body } = aliceFile;
    expect(file.projects.map((p) => p.id)).toEqual([ids["project"]]);
    expect(file.projects[0]!.release).toMatchObject({ points: 9, comment: OWN.releasedComment });
    expect(body).not.toContain(NEVER.teacherComment);
  });

  it("holds the drill views", () => {
    const { file } = aliceFile;
    expect(file.drill.classrooms.map((c) => c.classroomId)).toEqual([seed.classroomId]);
    expect(file.drill.calibration).toHaveLength(5);
  });

  it("writes one audit row with counts only", async () => {
    const rows = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "privacy.export"), eq(auditLog.subjectId, alice.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBe(alice.id);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["classrooms", "drillClassrooms", "feedback", "gradeRows", "hours", "projects"]);
    for (const value of Object.values(payload)) expect(typeof value).toBe("number");
    expect(payload).toMatchObject({ classrooms: 2, projects: 1, hours: 2 });
  });
});

describe("the leak test of 05 §5.7, for every caller", () => {
  it("carries no forbidden key with a value, no key, no unreleased grade, nothing only the staff see, nothing of another person", async () => {
    const callers: [string, Headers][] = [
      ["student", alice.headers],
      ["teacher on a staff seat", teacher.headers],
      ["admin with Super Powers", admin.headers],
    ];
    for (const [who, headers] of callers) {
      const { body, file } = who === "student" ? aliceFile : await fileOf(headers);
      // Question content travels in the feedback alone; elsewhere `concepts` (mastery) and `answers` (calibration) are counts and labels of their own views.
      expect(forbiddenValues(file.feedback), who).toEqual([]);
      for (const key of KEYS) expect(body, `${who}: ${key}`).not.toContain(key);
      for (const [name, marker] of Object.entries(NEVER)) expect(body, `${who}: ${name}`).not.toContain(marker);
      // The unreleased exam: 3/10 (grade 2.5), then the mark 1/10 (grade 1.5).
      for (const grade of ['"grade":2.5', '"grade":1.5']) expect(body, `${who}: ${grade}`).not.toContain(grade);
      // Bob's address, as the roster and the account hold it.
      const [bobRow] = await db().select().from(users).where(eq(users.id, bob.id));
      expect(body, who).not.toContain(bobRow!.email);
      expect(body, who).not.toContain(BOB_HOUR);
    }
  });

  it("gives a teacher and an admin their own seats' rows only, Super Powers widening nothing", async () => {
    for (const who of [teacher, admin]) {
      const { body, file } = await fileOf(who.headers);
      expect(file.account.id).toBe(who.id);
      expect(file.classrooms.map((c) => c.classroom.id)).toEqual([seed.classroomId]);
      expect(file.feedback).toEqual([]);
      expect(file.classrooms[0]!.groupSets.sets.flatMap((s) => s.groups)).toEqual([]);
      for (const marker of Object.values(OWN)) expect(body).not.toContain(marker);
    }
  });
});

describe("who may ask (ADR-112 §7)", () => {
  it("refuses an anonymous request, an impersonation, a seb or kiosk session and an API token", async () => {
    expect((await exportOf({})).statusCode).toBe(401);
    const impersonation = await sessionOf(alice.id, { kind: "impersonation", actorUserId: admin.id });
    expect((await exportOf(impersonation)).statusCode).toBe(403);
    const seb = await sessionOf(alice.id, { kind: "seb", evaluationId: ids["shown"]! });
    expect([401, 403]).toContain((await exportOf(seb)).statusCode);
    const station = await kioskStation(server.app);
    const kiosk = await sessionOf(alice.id, { kind: "kiosk", evaluationId: ids["shown"]!, deviceId: station.deviceId });
    expect([401, 403]).toContain((await exportOf({ ...kiosk, cookie: `${kiosk.cookie}; ${station.cookie}` })).statusCode);
    const { token } = await createApiToken(db(), alice.id, { name: "t", expiresInDays: null }, server.clock.now());
    expect([401, 403]).toContain((await exportOf({ authorization: `Bearer ${token}` })).statusCode);
  });

  it(`answers 429 after ${EXPORTS_PER_HOUR} files in an hour, and again after the hour`, async () => {
    const someone = await server.signIn("student");
    for (let i = 0; i < EXPORTS_PER_HOUR; i++) expect((await exportOf(someone.headers)).statusCode).toBe(200);
    const refused = await exportOf(someone.headers);
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    server.clock.advance(3_600_000);
    expect((await exportOf(someone.headers)).statusCode).toBe(200);
  });
});

describe("ownGroupOnly", () => {
  it("keeps the reader's group of each set and drops the others and the unplaced", () => {
    const member = { nom: "N", prenom: "P" };
    const narrowed = ownGroupOnly({
      serverNow: "2026-10-15T09:00:00.000Z",
      sets: [
        {
          set: { id: randomUUID(), name: "S", maxSize: null, openUntil: null, open: true },
          writable: false,
          myGroupId: "g1",
          groups: [
            { id: "g1", name: "mine", size: 1, members: [member] },
            { id: "g2", name: "theirs", size: 1, members: [member] },
          ],
          unplaced: [member],
        },
        {
          set: { id: randomUUID(), name: "T", maxSize: null, openUntil: null, open: false },
          writable: false,
          myGroupId: null,
          groups: [{ id: "g3", name: "other", size: 1, members: [member] }],
        },
      ],
    });
    expect(narrowed.sets.map((s) => s.groups.map((g) => g.name))).toEqual([["mine"], []]);
    expect(narrowed.sets[0]).not.toHaveProperty("unplaced");
  });
});
