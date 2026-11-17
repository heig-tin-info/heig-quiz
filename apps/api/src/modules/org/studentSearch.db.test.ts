/**
 * Finding a student already on the platform (ADR-133): the tenant, who may
 * search, what is matched and returned, what is left out, the pick checked
 * again, and the name a claim gives a nameless line.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recordIdpClaims } from "../../auth/claims.js";
import { createApiToken } from "../../auth/tokens.js";
import {
  auditLog,
  classrooms,
  courseStaff,
  courses,
  enrollments,
  shownNom,
  teacherGrants,
  userEmails,
  users,
} from "../../db/schema.js";
import { sessionOf, testServer, type Actor, type TestServer } from "../../test/http.js";
import { claimEnrollments } from "./roster.js";

let server: TestServer;
let courseId: string;
let classroomId: string;
/** A HEIG-VD teacher by staff affiliation, seated on the course. */
let teacher: Actor;

const db = () => server.app.db;

/**
 * An account as a login leaves it: its addresses, and its claims with the
 * institutional ones and the affiliation — or no claims at all.
 */
async function person(
  given: string,
  family: string,
  login: string,
  institutional: string[],
  opts: { affiliation?: string; claims?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await db().insert(users).values({ id, oidcSub: `s-${id}`, email: login, emailVerified: true, givenName: given, familyName: family });
  await db().insert(userEmails).values(
    [login, ...institutional].map((email, i) => ({ userId: id, email, source: i === 0 ? "login" : "swissEduIDLinkedAffiliationMail", verified: true })),
  );
  if (opts.claims !== false) {
    await recordIdpClaims(db(), id, {
      email: login,
      swissEduIDLinkedAffiliationMail: institutional,
      eduPersonScopedAffiliation: [opts.affiliation ?? "student@hes-so.ch"],
    });
  }
  return id;
}

/** A signed-in teacher with `institutional` addresses and `affiliation` (staff by default). */
async function teacherWith(institutional: string[], affiliation = "staff@hes-so.ch"): Promise<Actor> {
  const actor = await server.signIn("teacher");
  await db().insert(userEmails).values(institutional.map((email) => ({ userId: actor.id, email, source: "swissEduIDLinkedAffiliationMail", verified: true })));
  await recordIdpClaims(db(), actor.id, { swissEduIDLinkedAffiliationMail: institutional, eduPersonScopedAffiliation: [affiliation] });
  await db().insert(courseStaff).values({ courseId, userId: actor.id });
  return actor;
}

async function search(headers: Record<string, string>, q: string, room = classroomId) {
  return server.app.inject({ method: "GET", url: `/app/api/classrooms/${room}/roster/candidates?q=${encodeURIComponent(q)}`, headers });
}

async function add(headers: Record<string, string>, body: Record<string, unknown>, room = classroomId) {
  return server.app.inject({ method: "POST", url: `/app/api/classrooms/${room}/roster/line`, headers, payload: body });
}

async function lineOf(email: string, room = classroomId) {
  const [row] = await db()
    .select()
    .from(enrollments)
    .where(and(eq(enrollments.classroomId, room), eq(enrollments.email, email)));
  return row;
}

async function newRoom(): Promise<string> {
  const id = randomUUID();
  await db().insert(classrooms).values({ id, courseId, name: `Room ${id.slice(0, 6)}` });
  return id;
}

let lea: string;

beforeAll(async () => {
  server = await testServer();
  courseId = randomUUID();
  classroomId = randomUUID();
  await db().insert(courses).values({ id: courseId, name: "Programmation C", code: "PRG1" });
  await db().insert(classrooms).values({ id: classroomId, courseId, name: "PRG1-A" });
  teacher = await teacherWith(["prof.demo@heig-vd.ch"]);

  // Léa signs in with a private address; HEIG-VD asserts her school one.
  lea = await person("Léa", "Rochat", "lea.private@gmail.test", ["lea.rochat@heig-vd.ch"]);
  // A homonym of another HES-SO school, and one under a subdomain.
  await person("Léa", "Rochat", "lea.r@outlook.test", ["lea.rochat@hefr.ch"]);
  await person("Noé", "Rochat", "noe@outlook.test", ["noe.rochat@mail.heig-vd.ch"]);
});

afterAll(async () => {
  await server.close();
});

describe("the search (ADR-133)", () => {
  it("finds a student of the caller's school by name, and returns the name and the school address only", async () => {
    const res = await search(teacher.headers, "rochat");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ givenName: "Léa", familyName: "Rochat", email: "lea.rochat@heig-vd.ch" }]);
  });

  it("ignores case, accents and word order; tolerates no typo", async () => {
    expect((await search(teacher.headers, "ROCHAT léa")).json()).toHaveLength(1);
    expect((await search(teacher.headers, "lea rochat@heig")).json()).toHaveLength(1);
    expect((await search(teacher.headers, "rochta")).json()).toEqual([]);
  });

  it("searches nothing under three characters", async () => {
    const res = await search(teacher.headers, "Lé");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("never matches the login address: no oracle on a private address", async () => {
    expect((await search(teacher.headers, "lea.private")).json()).toEqual([]);
    expect((await search(teacher.headers, "gmail")).json()).toEqual([]);
  });

  it("never returns another school's student, even with their full address", async () => {
    expect((await search(teacher.headers, "lea.rochat@hefr.ch")).json()).toEqual([]);
    // Nor a subdomain of the caller's: the domain is matched exactly.
    expect((await search(teacher.headers, "noe")).json()).toEqual([]);
  });

  it("gives a teacher of another school their own school's students only", async () => {
    const hefr = await teacherWith(["prof@hefr.ch"]);
    expect((await search(hefr.headers, "rochat")).json()).toEqual([{ givenName: "Léa", familyName: "Rochat", email: "lea.rochat@hefr.ch" }]);
  });

  it("leaves out pseudonymized, dormant and claimless accounts", async () => {
    const gone = await person("Zoé", "Anonyme", "z1@x.test", ["zoe.anonyme@heig-vd.ch"]);
    await db().update(users).set({ anonymizedAt: new Date() }).where(eq(users.id, gone));
    const asleep = await person("Zoé", "Dormante", "z2@x.test", ["zoe.dormante@heig-vd.ch"]);
    await db().update(users).set({ inactivityNotifiedAt: new Date() }).where(eq(users.id, asleep));
    await person("Zoé", "Placeholder", "z3@x.test", ["zoe.placeholder@heig-vd.ch"], { claims: false });
    await person("Zoé", "Presente", "z4@x.test", ["zoe.presente@heig-vd.ch"]);
    expect((await search(teacher.headers, "zoé")).json()).toEqual([{ givenName: "Zoé", familyName: "Presente", email: "zoe.presente@heig-vd.ch" }]);
  });

  it("leaves out anyone already on this roster, by line or by any verified address, and the course's staff", async () => {
    const room = await newRoom();
    const onLine = await person("Marc", "Ligne", "marc@x.test", ["marc.ligne@heig-vd.ch"]);
    await db().insert(enrollments).values({ id: randomUUID(), classroomId: room, nom: "", prenom: "", email: "x@y.test", userId: onLine });
    await person("Marc", "Prive", "marc.prive@x.test", ["marc.prive@heig-vd.ch"]);
    // A line under the private address leaves the school address out too.
    await db().insert(enrollments).values({ id: randomUUID(), classroomId: room, nom: "P", prenom: "M", email: "marc.prive@x.test" });
    await teacherWith(["marc.collegue@heig-vd.ch"]);
    expect((await search(teacher.headers, "marc", room)).json()).toEqual([]);
    // Another roster of the course still finds the students.
    expect((await search(teacher.headers, "marc")).json()).toHaveLength(2);
  });

  it("offers ten people at most", async () => {
    for (let i = 0; i < 12; i += 1) await person(`Élève${i}`, "Nombreux", `n${i}@x.test`, [`eleve${i}.nombreux@heig-vd.ch`]);
    expect((await search(teacher.headers, "nombreux")).json()).toHaveLength(10);
  });
});

describe("who may search (ADR-133 §3)", () => {
  it("refuses a teacher whose role comes from a course seat alone", async () => {
    const assistant = await teacherWith(["assistant.etudiant@heig-vd.ch"], "student@hes-so.ch");
    const res = await search(assistant.headers, "rochat");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("student_search_unavailable");
  });

  it("refuses a caller with no institutional address, a grant notwithstanding", async () => {
    const granted = await server.signIn("teacher", "granted@private.test");
    await db().insert(userEmails).values({ userId: granted.id, email: "granted@private.test", source: "login", verified: true });
    await db().insert(teacherGrants).values({ id: randomUUID(), email: "granted@private.test", createdBy: granted.id });
    await db().insert(courseStaff).values({ courseId, userId: granted.id });
    expect((await search(granted.headers, "rochat")).statusCode).toBe(403);
  });

  it("refuses a personal token and an impersonation session of an entitled teacher", async () => {
    const { token } = await createApiToken(db(), teacher.id, { name: "cli", expiresInDays: 1, scope: "api" });
    expect((await search({ authorization: `Bearer ${token}` }, "rochat")).statusCode).toBe(403);
    const admin = await server.signIn("admin");
    const delegated = await sessionOf(db(), teacher.id, { kind: "impersonation", actorUserId: admin.id });
    expect((await search(delegated, "rochat")).statusCode).toBe(403);
  });

  it("answers a teacher off the course with the 404 of a missing classroom", async () => {
    const stranger = await server.signIn("teacher");
    expect((await search(stranger.headers, "rochat")).statusCode).toBe(404);
  });
});

describe("adding one student (ADR-133 §5, §6)", () => {
  it("adds a picked result, named from the account, pending, and audits it", async () => {
    const room = await newRoom();
    const res = await add(teacher.headers, { email: "lea.rochat@heig-vd.ch", picked: true, timeBonusPercent: 25 }, room);
    expect(res.statusCode).toBe(201);
    const line = await lineOf("lea.rochat@heig-vd.ch", room);
    expect(line).toMatchObject({ nom: "Rochat", prenom: "Léa", userId: null, timeBonusPercent: 25 });
    const [row] = await db().select().from(auditLog).where(and(eq(auditLog.action, "roster.add"), eq(auditLog.subjectId, line!.id)));
    expect(row?.payload).toEqual({ email: "lea.rochat@heig-vd.ch", picked: true });
  });

  it("checks a pick again: an address the search would not offer is refused, nothing written", async () => {
    const room = await newRoom();
    for (const email of ["lea.rochat@hefr.ch", "lea.private@gmail.test", "noe.rochat@mail.heig-vd.ch"]) {
      const res = await add(teacher.headers, { email, picked: true }, room);
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("student_not_found");
      expect(await lineOf(email, room)).toBeUndefined();
    }
    const assistant = await teacherWith(["assistant2@heig-vd.ch"], "student@hes-so.ch");
    expect((await add(assistant.headers, { email: "lea.rochat@heig-vd.ch", picked: true }, room)).statusCode).toBe(403);
  });

  it("adds a typed address as a nameless line, with the same answer whatever account it belongs to", async () => {
    const room = await newRoom();
    const known = await add(teacher.headers, { email: "Lea.Private@gmail.test" }, room);
    const unknown = await add(teacher.headers, { email: "nobody@nowhere.test" }, room);
    expect(known.statusCode).toBe(201);
    expect(unknown.statusCode).toBe(201);
    expect(known.json()).toEqual(unknown.json());
    expect(await lineOf("lea.private@gmail.test", room)).toMatchObject({ nom: "", prenom: "", userId: null });
    // Any course member may add by address, a seat-only assistant included.
    const assistant = await teacherWith(["assistant3@heig-vd.ch"], "student@hes-so.ch");
    expect((await add(assistant.headers, { email: "other@nowhere.test" }, room)).statusCode).toBe(201);
  });

  it("refuses a pick of someone the roster already holds", async () => {
    const room = await newRoom();
    await add(teacher.headers, { email: "lea.rochat@heig-vd.ch" }, room);
    expect((await add(teacher.headers, { email: "lea.rochat@heig-vd.ch", picked: true }, room)).statusCode).toBe(404);
  });

  it("shows a nameless line as its address to every reader", async () => {
    const room = await newRoom();
    await add(teacher.headers, { email: "shown@nowhere.test" }, room);
    const [row] = await db().select({ nom: shownNom, prenom: enrollments.prenom }).from(enrollments).where(eq(enrollments.classroomId, room));
    expect(row).toEqual({ nom: "shown@nowhere.test", prenom: "" });
  });
});

describe("the name at the claim (ADR-133 §4)", () => {
  it("fills a nameless line from the account, and never overwrites a typed name", async () => {
    const nameless = await newRoom();
    const named = await newRoom();
    await add(teacher.headers, { email: "lea.rochat@heig-vd.ch" }, nameless);
    await db().insert(enrollments).values({ id: randomUUID(), classroomId: named, nom: "Rochat-GAPS", prenom: "Léa Marie", email: "lea.rochat@heig-vd.ch" });

    expect(await claimEnrollments(db(), { id: lea })).toBeGreaterThanOrEqual(2);
    expect(await lineOf("lea.rochat@heig-vd.ch", nameless)).toMatchObject({ nom: "Rochat", prenom: "Léa", userId: lea });
    expect(await lineOf("lea.rochat@heig-vd.ch", named)).toMatchObject({ nom: "Rochat-GAPS", prenom: "Léa Marie", userId: lea });
  });

});
