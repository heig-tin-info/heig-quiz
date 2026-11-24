/**
 * Invariant 4, the provided documents' exit (ADR-144 §7, F-LIVE-15, 05
 * §5.7): a document of a course's library reaches a student only through the
 * student view of the `library` module, for a document the evaluation of
 * their own attempt selected, while the read rule holds.
 *
 * Over the real application: every refusal answers, on both routes, exactly
 * what a random document id asked on the caller's own open attempt answers;
 * the positives serve the exact bytes, with `Range`; and every student
 * response of the flow is searched for what must never leave — the hash, the
 * uploaded file name, the uploader, the Markdown source, its warnings and an
 * unselected document's title.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AttemptView, CSRF_COOKIE, type FeedbackPolicy } from "@quiz/contracts";
import { GRACE_MS } from "@quiz/domain";
import { registerForTests } from "@quiz/registry/server";

import { createSession, SESSION_COOKIE } from "../../auth/session.js";
import { attempts, courseDocuments, courseStaff, evaluations, users } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { type Actor, sessionOf, testServer, type TestServer } from "../../test/http.js";
import { kioskStation } from "../../test/kiosk.js";
import { pdfBytes, uploadDocument } from "../../test/library.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState, setAfterDue } from "../evaluation/service.js";
import { releaseResults } from "../results/service.js";

type Headers = Record<string, string>;
type Route = "file" | "html";

let server: TestServer;
let restore: () => void;
let owner: Actor;
let uploader: Actor;
let student: Actor;
let seated: Actor;
let outsider: Actor;

const MARKDOWN_SOURCE = "# Formulaire\n\nLa loi **gras-du-source** : U = R I.\n\n<div>brut</div>\n";
/** Everything a student response must never carry, filled as the worlds are built. */
const secrets = new Set<string>();
/** Every student response of the flow, by who asked what. */
const responses: { who: string; body: string }[] = [];

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer({ KIOSK_ATTESTATION: "mock" });
  server.clock.set("2026-11-24T08:00:00.000Z");
  owner = await server.signIn("teacher");
  uploader = await server.signIn("teacher");
  await server.app.db.update(users).set({ givenName: "Ulla", familyName: "Uploaderova" }).where(eq(users.id, uploader.id));
  student = await server.signIn("student");
  seated = await server.signIn("student");
  outsider = await server.signIn("student");
  secrets.add(uploader.id).add("Uploaderova").add(MARKDOWN_SOURCE).add("**gras-du-source**").add("raw_html");
});
afterAll(async () => {
  await server.close();
  restore();
});

const db = () => server.app.db;
const call = (method: "GET" | "POST" | "PATCH", url: string, headers: Headers, payload?: object) =>
  server.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
/** A student response, kept for the search at the end. */
async function read(who: string, method: "GET" | "POST", url: string, headers: Headers, payload?: object) {
  const res = await call(method, url, headers, payload);
  responses.push({ who: `${who} ${method} ${url}`, body: `${JSON.stringify(res.headers)}\n${res.body}` });
  return res;
}
const documentUrl = (attemptId: string, documentId: string, route: Route) =>
  `/app/api/attempts/${attemptId}/documents/${documentId}/${route}`;

/** One exam or exercise of its own course, with three documents — two selected — and the seated students. */
async function world(options: { mode?: "exam" | "exercise"; settings?: Record<string, unknown>; feedback?: FeedbackPolicy } = {}) {
  const seed = await seedLive(db(), {
    teacherId: owner.id,
    studentIds: [student.id, seated.id],
    mode: options.mode ?? "exam",
    settings: { timing: "duration", lobby: "skip", ...options.settings },
  });
  if (options.feedback) await db().update(evaluations).set({ feedbackPolicy: options.feedback }).where(eq(evaluations.id, seed.evaluationId));
  await db().insert(courseStaff).values({ courseId: seed.courseId, userId: uploader.id, role: "assistant" });
  const marker = randomUUID();
  const bytes = pdfBytes(marker);
  const pdf = await uploadDocument(server, seed.courseId, uploader, {
    bytes,
    filename: `uploaded-name-${marker}.pdf`,
    title: "Datasheet",
  });
  const markdown = await uploadDocument(server, seed.courseId, uploader, {
    bytes: Buffer.from(MARKDOWN_SOURCE.replace("Formulaire", `Formulaire ${marker}`)),
    filename: `notes-${marker}.md`,
    title: "Formulaire",
  });
  const unselected = await uploadDocument(server, seed.courseId, uploader, {
    bytes: pdfBytes(),
    filename: `hidden-${marker}.pdf`,
    title: `Unselected ${marker}`,
  });
  for (const d of [pdf, markdown, unselected]) {
    const [row] = await db().select().from(courseDocuments).where(eq(courseDocuments.id, d.id));
    secrets.add(row!.sha256).add(row!.filename);
  }
  secrets.add(unselected.title);
  const patched = await call("PATCH", `/app/api/evaluations/${seed.evaluationId}`, owner.headers, {
    documents: [pdf.id, markdown.id],
  });
  expect(patched.statusCode, patched.body).toBe(200);
  return { seed, bytes, pdf, markdown, unselected };
}
type World = Awaited<ReturnType<typeof world>>;

async function start(w: World) {
  const started = await call("POST", `/app/api/evaluations/${w.seed.evaluationId}/start`, owner.headers, { confirm: true });
  expect(started.statusCode, started.body).toBe(200);
}

/** The student enters and starts: their attempt view. */
async function enter(w: World, who: Actor = student, headers: Headers = who.headers): Promise<AttemptView> {
  const res = await read("student", "POST", `/app/api/evaluations/${w.seed.evaluationId}/attempt/start`, headers, {});
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().kind).toBe("attempt");
  return AttemptView.parse(res.json().view);
}

async function attemptView(attemptId: string, headers: Headers = student.headers): Promise<AttemptView> {
  const res = await read("student", "GET", `/app/api/attempts/${attemptId}`, headers);
  expect(res.statusCode, res.body).toBe(200);
  return AttemptView.parse(res.json().view);
}

/** What a random document id asked on the caller's own open attempt answers: THE refusal. */
async function baseline(attemptId: string) {
  const out: Record<Route, { status: number; body: string }> = {} as never;
  for (const route of ["file", "html"] as const) {
    const res = await call("GET", documentUrl(attemptId, randomUUID(), route), student.headers);
    out[route] = { status: res.statusCode, body: res.body };
  }
  expect(out.file).toEqual({ status: 404, body: JSON.stringify({ error: "not_found" }) });
  expect(out.html).toEqual(out.file);
  return out;
}
let refusal: Awaited<ReturnType<typeof baseline>>;

/** Both routes, for the world's PDF and Markdown document, answer exactly the refusal. */
async function expectRefused(label: string, attemptId: string, headers: Headers, ids: { file: string; html: string }) {
  for (const route of ["file", "html"] as const) {
    const res = await read(label, "GET", documentUrl(attemptId, ids[route], route), headers);
    expect({ status: res.statusCode, body: res.body }, `${label} ${route}`).toEqual(refusal[route]);
  }
}
const both = (w: World) => ({ file: w.pdf.id, html: w.markdown.id });

/** Both routes serve the world's documents: the PDF whole, then a range of it, and the Markdown's HTML. */
async function expectServed(label: string, w: World, attemptId: string, headers: Headers) {
  const whole = await read(label, "GET", documentUrl(attemptId, w.pdf.id, "file"), headers);
  expect(whole.statusCode, whole.body).toBe(200);
  expect(whole.rawPayload).toEqual(w.bytes);
  expect(whole.headers).toMatchObject({
    "content-type": "application/pdf",
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "content-disposition": 'attachment; filename="Datasheet.pdf"',
  });
  const part = await read(label, "GET", documentUrl(attemptId, w.pdf.id, "file"), { ...headers, range: "bytes=0-4" });
  expect(part.statusCode).toBe(206);
  expect(part.rawPayload).toEqual(w.bytes.subarray(0, 5));
  expect(part.headers["content-range"]).toBe(`bytes 0-4/${w.bytes.length}`);
  const html = await read(label, "GET", documentUrl(attemptId, w.markdown.id, "html"), headers);
  expect(html.statusCode, html.body).toBe(200);
  expect(html.json()).toMatchObject({ title: "Formulaire", toc: [{ depth: 1 }] });
  expect(html.json().html).toContain("<strong>gras-du-source</strong>");
  // Each route serves its own kind only.
  await expectRefused(`${label}, the other kind`, attemptId, headers, { file: w.markdown.id, html: w.pdf.id });
}

const provided = (w: World) => [
  { id: w.pdf.id, title: "Datasheet", kind: "pdf" },
  { id: w.markdown.id, title: "Formulaire", kind: "markdown" },
];
const documentsLine = (view: AttemptView) => view.conditions.imposed.find((line) => line.key === "documents");

describe("an exam's official attempt (F-LIVE-15)", () => {
  let w: World;
  let attemptId: string;

  beforeAll(async () => {
    w = await world();
    await start(w);
    const view = await enter(w);
    attemptId = view.attempt.id;
    refusal = await baseline(attemptId);
  });

  it("lists the selection in its order and counts it in the conditions, never the titles", async () => {
    const view = await attemptView(attemptId);
    expect(view.documents).toEqual(provided(w));
    expect(documentsLine(view)).toEqual({ key: "documents", kind: "provided", count: 2 });
  });

  it("serves the selected documents while the exam runs", async () => {
    await expectServed("open", w, attemptId, student.headers);
  });

  it("refuses an unselected document and another course's like a missing one", async () => {
    await expectRefused("unselected", attemptId, student.headers, { file: w.unselected.id, html: w.unselected.id });
    const other = await world();
    await expectRefused("another course's", attemptId, student.headers, both(other));
  });

  it("refuses the attempt of another seated student, the staff, a superseded attempt and an impersonation of another student", async () => {
    const theirs = await enter(w, seated);
    await expectRefused("seated, another's attempt", attemptId, seated.headers, both(w));
    await expectRefused("staff, a student's attempt", attemptId, owner.headers, both(w));
    const admin = await server.signInWithSuperPowers();
    const acting = await sessionOf(db(), seated.id, { kind: "impersonation", actorUserId: admin.id });
    await expectRefused("impersonating another student", attemptId, acting, both(w));
    // A paper copy replaced the seated student's attempt (ADR-125 §12): never theirs again.
    await expectServed("seated, before the paper copy", w, theirs.attempt.id, seated.headers);
    await db().update(attempts).set({ supersededBy: attemptId }).where(eq(attempts.id, theirs.attempt.id));
    await expectRefused("superseded", theirs.attempt.id, seated.headers, both(w));
  });

  it("refuses another classroom's student, on their own open attempt and on this one", async () => {
    const elsewhere = await seedLive(db(), { teacherId: owner.id, studentIds: [outsider.id], settings: { lobby: "skip" } });
    expect((await call("POST", `/app/api/evaluations/${elsewhere.evaluationId}/start`, owner.headers, { confirm: true })).statusCode).toBe(200);
    const entered = await read("outsider", "POST", `/app/api/evaluations/${elsewhere.evaluationId}/attempt/start`, outsider.headers, {});
    const theirs = AttemptView.parse(entered.json().view).attempt.id;
    await expectRefused("another classroom, own attempt", theirs, outsider.headers, both(w));
    await expectRefused("another classroom, this attempt", attemptId, outsider.headers, both(w));
  });

  it("refuses a seb and a kiosk session confined to another exam", async () => {
    const seb = await seedLive(db(), { teacherId: owner.id, studentIds: [student.id], settings: { safeExamBrowser: true, lobby: "skip" } });
    await applyState(db(), await reload(db(), seb.evaluationId), "running", server.clock.now());
    await expectRefused("seb of another exam", attemptId, await sessionOf(db(), student.id, { kind: "seb", evaluationId: seb.evaluationId }), both(w));
    const kiosk = await seedLive(db(), { teacherId: owner.id, studentIds: [student.id], settings: { kiosk: true, lobby: "skip" } });
    await applyState(db(), await reload(db(), kiosk.evaluationId), "running", server.clock.now());
    const station = await kioskStation(server.app);
    const opened = await createSession(db(), student.id, 12, {
      kind: "kiosk",
      actorUserId: null,
      evaluationId: kiosk.evaluationId,
      projectId: null,
      deviceId: station.deviceId,
    });
    const headers = { cookie: `${SESSION_COOKIE}=${opened.token}; ${CSRF_COOKIE}=${opened.csrf}; ${station.cookie}`, "x-csrf-token": opened.csrf };
    // The station's session is a real one: it reads its own exam's home.
    expect((await call("GET", "/app/api/me", headers)).statusCode).toBe(200);
    await expectRefused("kiosk of another exam", attemptId, headers, both(w));
  });

  it("stops at a pause and comes back at the resume", async () => {
    expect((await call("POST", `/app/api/evaluations/${w.seed.evaluationId}/pause`, owner.headers, { confirm: true })).statusCode).toBe(200);
    await expectRefused("paused", attemptId, student.headers, both(w));
    const paused = await attemptView(attemptId);
    expect(paused.documents).toEqual([]);
    expect(documentsLine(paused)).toEqual({ key: "documents", kind: "provided", count: 2 });
    expect((await call("POST", `/app/api/evaluations/${w.seed.evaluationId}/resume`, owner.headers, { confirm: true })).statusCode).toBe(200);
    await expectServed("resumed", w, attemptId, student.headers);
  });

  it("stops at the deadline plus the grace, by the server's clock (invariant 5)", async () => {
    const [row] = await db().select().from(attempts).where(eq(attempts.id, attemptId));
    server.clock.set(new Date(row!.deadlineAt!.getTime() + GRACE_MS));
    await expectServed("within the grace", w, attemptId, student.headers);
    server.clock.advance(1);
    await expectRefused("expired", attemptId, student.headers, both(w));
    expect((await attemptView(attemptId)).documents).toEqual([]);
  });
});

describe("an exam that is not running, or an attempt that is over", () => {
  it("refuses an attempt in the lobby, and states the count in the waiting room", async () => {
    const w = await world({ settings: { lobby: "manual" } });
    await applyState(db(), await reload(db(), w.seed.evaluationId), "lobby", server.clock.now());
    const entered = await read("student", "POST", `/app/api/evaluations/${w.seed.evaluationId}/attempt`, student.headers, {});
    expect(entered.json().kind).toBe("lobby");
    expect(entered.json().view.conditions.imposed).toContainEqual({ key: "documents", kind: "provided", count: 2 });
    const [row] = await db().select().from(attempts).where(eq(attempts.evaluationId, w.seed.evaluationId));
    expect(row!.state).toBe("not_started");
    await expectRefused("lobby", row!.id, student.headers, both(w));
  });

  it("refuses a submitted attempt, then a closed exam", async () => {
    const w = await world();
    await start(w);
    const mine = (await enter(w)).attempt.id;
    const theirs = (await enter(w, seated)).attempt.id;
    expect((await call("POST", `/app/api/attempts/${mine}/submit`, student.headers, { confirm: true })).statusCode).toBe(200);
    await expectRefused("submitted", mine, student.headers, both(w));
    expect((await attemptView(mine)).documents).toEqual([]);
    await expectServed("still sitting", w, theirs, seated.headers);
    expect((await call("POST", `/app/api/evaluations/${w.seed.evaluationId}/close`, owner.headers, { confirm: true })).statusCode).toBe(200);
    await expectRefused("closed", theirs, seated.headers, both(w));
    expect((await attemptView(theirs, seated.headers)).documents).toEqual([]);
  });

  it("refuses the blank practice of a released exam (ADR-142), and counts no documents there", async () => {
    const w = await world({
      feedback: {
        when: "on_release",
        showAnswer: true,
        showKey: true,
        showExplanation: false,
        showHiddenCaseNames: false,
        showTeacherComment: true,
        contestationDays: 7,
      },
    });
    await start(w);
    const official = (await enter(w)).attempt.id;
    expect((await call("POST", `/app/api/attempts/${official}/submit`, student.headers, { confirm: true })).statusCode).toBe(200);
    expect((await call("POST", `/app/api/evaluations/${w.seed.evaluationId}/close`, owner.headers, { confirm: true })).statusCode).toBe(200);
    await releaseResults(db(), await reload(db(), w.seed.evaluationId), server.clock.now());
    await setAfterDue(db(), await reload(db(), w.seed.evaluationId), "open", server.clock.now());
    const ready = await read("student", "POST", `/app/api/evaluations/${w.seed.evaluationId}/practice`, student.headers, {});
    expect(ready.statusCode, ready.body).toBe(200);
    expect(ready.json().view.conditions.imposed.map((l: { key: string }) => l.key)).not.toContain("documents");
    const started = await read("student", "POST", `/app/api/evaluations/${w.seed.evaluationId}/practice/start`, student.headers, {});
    expect(started.statusCode, started.body).toBe(200);
    const practice = AttemptView.parse(started.json().view);
    expect(practice.attempt.practice).toBe(true);
    expect(practice.documents).toEqual([]);
    expect(documentsLine(practice)).toBeUndefined();
    await expectRefused("an exam's practice", practice.attempt.id, student.headers, both(w));
  });
});

describe("a trusted client of this exam, and an exercise", () => {
  it("serves the seb session confined to this exam", async () => {
    const w = await world({ settings: { safeExamBrowser: true } });
    await start(w);
    const seb = await sessionOf(db(), student.id, { kind: "seb", evaluationId: w.seed.evaluationId });
    const entered = await read("seb", "POST", `/app/api/evaluations/${w.seed.evaluationId}/attempt`, seb, {});
    expect(entered.statusCode, entered.body).toBe(200);
    const view = AttemptView.parse(entered.json().view);
    expect(view.documents).toEqual(provided(w));
    await expectServed("seb of this exam", w, view.attempt.id, seb);
    // The portal session is refused this exam's sitting routes, its own attempt included.
    await expectRefused("portal on a seb exam", view.attempt.id, student.headers, both(w));
  });

  it("serves an exercise's open attempt, then its practice after the due date (ADR-122)", async () => {
    const w = await world({ mode: "exercise", settings: { timing: "manual" } });
    await start(w);
    const view = await enter(w);
    expect(view.documents).toEqual(provided(w));
    await expectServed("exercise", w, view.attempt.id, student.headers);
    expect((await call("POST", `/app/api/attempts/${view.attempt.id}/submit`, student.headers, { confirm: true })).statusCode).toBe(200);
    expect((await call("POST", `/app/api/evaluations/${w.seed.evaluationId}/close`, owner.headers, { confirm: true })).statusCode).toBe(200);
    await expectRefused("the official attempt, handed in", view.attempt.id, student.headers, both(w));
    const started = await read("student", "POST", `/app/api/evaluations/${w.seed.evaluationId}/practice/start`, student.headers, {});
    expect(started.statusCode, started.body).toBe(200);
    const practice = AttemptView.parse(started.json().view);
    expect(practice.attempt.practice).toBe(true);
    expect(practice.documents).toEqual(provided(w));
    expect(documentsLine(practice)).toEqual({ key: "documents", kind: "provided", count: 2 });
    await expectServed("an exercise's practice", w, practice.attempt.id, student.headers);
  });
});

describe("what never leaves (05 §5.7)", () => {
  it("is in no student response of the flow", async () => {
    for (const who of [student, seated, outsider]) await read("home", "GET", "/app/api/student/home", who.headers);
    // The probe sees what it searches: the selection's titles did leave.
    expect(responses.some((r) => r.body.includes("Datasheet"))).toBe(true);
    expect(secrets.size).toBeGreaterThan(10);
    const leaks = responses.flatMap((r) => [...secrets].filter((s) => r.body.includes(s)).map((s) => `${r.who}: ${s}`));
    expect(leaks).toEqual([]);
  });
});
