/**
 * The per-question check of an exercise (ADR-124 §3) over the REAL
 * application, and invariant 4 for it (docs/05 §5.7).
 *
 * One running exercise holds a static `short`, a parameterized `short`
 * (ADR-056 §5), a `code` question with a HIDDEN test case, and an essay
 * (`rich`) with a model answer and grading criteria. Every question carries
 * recognisable markers in its key and its explanation. For every student
 * response — the attempt, its resume, an autosave, a check, a teacher in the
 * student view, an impersonation, a practice attempt after the due date — the
 * keys of the questions NOT checked are searched for twice: by the
 * forbidden-key list, and by their answer-key values in the serialized
 * output. A checked question shows its correction, through the one exit
 * (`studentItemCorrection`), and nothing of an essay's criteria (ADR-037).
 *
 * Beside the leak: an exam refuses the check, an empty question cannot be
 * checked, a checked one refuses every later write and a second check, a
 * reopen keeps it locked and graded, the hand-in pass leaves its grading
 * alone, another student's attempt is a 404, and a check after the deadline
 * plus the grace is the 410 of every write (invariant 5). The runner's
 * verdict of a checked `code` question lands after the check, on a queue the
 * test drains itself.
 */
import { and, eq, ne } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultFeedbackPolicy, type AttemptItem, type AttemptView, type CheckResponse } from "@quiz/contracts";
import type { RunnerService } from "@quiz/core/server";
import { CodeConfig, finalizeRunnerCode } from "@quiz/qt-code/server";
import { registerForTests } from "@quiz/registry/server";

import { answers, attempts, evaluations, gradings, questions } from "../../db/schema.js";
import { GRADING_EVALUATION_QUEUE, GRADING_RUNNER_QUEUE, type JobQueue } from "../../jobs.js";
import { codeConfig } from "../../test/codeFixture.js";
import { testApp } from "../../test/db.js";
import { fakeRunnableCode, fakeShort } from "../../test/fakeType.js";
import { type Payload, sessionOf, testServer, type TestServer } from "../../test/http.js";
import { keysOf } from "../../test/keys.js";
import { enterStarted, reload, seedLive, type Seeded } from "../../test/live.js";
import { EXPLANATION, fallOf, markersIn, PARAMETERIZED, showsKey, VARIABLES } from "../../test/parameterized.js";
import { addItems, applyState, byId, joinedItems } from "../evaluation/service.js";
import { registerGradingJobs } from "../grading/jobs.js";
import { writeGrading } from "../grading/service.js";
import { exampleConfig, typeOf } from "../pool/service.js";
import * as poolService from "../pool/service.js";
import { FORBIDDEN_STUDENT_KEYS } from "./studentView.js";
import * as live from "./service.js";

type Kind = "short" | "param" | "code" | "rich";
type Who = { id: string; headers: Record<string, string> };

const TEMPLATE = "// @@lock\nint main(void) {\n// @@endlock\n    return 0;\n// @@lock\n}\n// @@endlock\n";

/** What each question's key and explanation hold, and nothing else does. */
const SECRETS: Record<Exclude<Kind, "param">, string[]> = {
  short: ["SECRET-SHORT-KEY", "SECRET-SHORT-EXPLANATION"],
  code: ["REFERENCE-MARKER", "hidden-case-secret", "HIDDEN-EXPECTED-OUT", "HIDDEN-STDIN-MARKER", "SECRET-CODE-EXPLANATION"],
  rich: ["MODEL-ANSWER-MARKER", "RUBRIC-MARKER", "CRITERION-TITLE-MARKER", "CRITERION-PROMPT-MARKER", "SECRET-RICH-EXPLANATION"],
};
/** What a code question's correction never carries, checked or not: its hidden case (#998, D15). */
const HIDDEN_CASE = ["hidden-case-secret", "HIDDEN-EXPECTED-OUT", "HIDDEN-STDIN-MARKER"];
/** What an essay's correction never carries, checked or not (ADR-037). */
const GRADERS_ONLY = ["RUBRIC-MARKER", "CRITERION-TITLE-MARKER", "CRITERION-PROMPT-MARKER"];

const CONTENT: Record<Exclude<Kind, "param">, { type: string; config: unknown; explanation: string }> = {
  short: {
    type: "short",
    config: { configVersion: 3, prompt: "Name it.", kind: "text", matchers: [{ kind: "exact", value: "SECRET-SHORT-KEY" }] },
    explanation: "SECRET-SHORT-EXPLANATION",
  },
  code: {
    type: "code",
    config: {
      configVersion: 1,
      prompt: "Return the answer.",
      language: "c",
      runtime: "backend",
      template: TEMPLATE,
      referenceSolution: "int main(void) { return REFERENCE-MARKER; }",
      tests: {
        mode: "io",
        cases: [
          { name: "visible-case", stdin: "", expected: "", visible: true, points: 1 },
          { name: "hidden-case-secret", stdin: "HIDDEN-STDIN-MARKER", expected: "HIDDEN-EXPECTED-OUT", visible: false, points: 3 },
        ],
      },
    },
    explanation: "SECRET-CODE-EXPLANATION",
  },
  rich: {
    type: "rich",
    config: {
      configVersion: 2,
      prompt: "Discuss.",
      rubric: "RUBRIC-MARKER",
      criteria: [{ id: "thesis", title: "CRITERION-TITLE-MARKER", weight: 1, prompt: "CRITERION-PROMPT-MARKER" }],
      reference: "MODEL-ANSWER-MARKER",
      format: "plain",
    },
    explanation: "SECRET-RICH-EXPLANATION",
  },
};

let server: TestServer;
let teacher: Who;
let alice: Who;
let bob: Who;
let admin: Who;
let seed: Seeded;
const itemOf = new Map<Kind, string>();
const attemptOf = new Map<string, string>();

const get = (url: string, headers: Record<string, string>) => server.app.inject({ method: "GET", url, headers });
const post = (url: string, headers: Record<string, string>, payload?: Payload) =>
  server.app.inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload }) });
const now = () => server.clock.now().toISOString();

/** The autosave's body, which the check takes too. */
const body = (payload: unknown, revision: number) => ({ payload, revision, clientTs: now(), coordinates: "position" });

async function publish(kind: Exclude<Kind, "param">): Promise<string> {
  const db = server.app.db;
  const { type, config, explanation } = CONTENT[kind];
  const { id } = await poolService.createQuestion(db, { poolId: seed.poolId, type, internalName: kind, createdBy: teacher.id });
  const [question] = await db.select().from(questions).where(eq(questions.id, id));
  const saved = await poolService.putDraft(db, question!, { config, explanation });
  if (!saved.valid) throw new Error(`fixture ${kind}: ${JSON.stringify(saved.issues)}`);
  await poolService.publishQuestion(db, question!, { userId: teacher.id });
  return id;
}

async function publishParam(): Promise<string> {
  const db = server.app.db;
  const { id } = await poolService.createQuestion(db, { poolId: seed.poolId, type: "short", internalName: "param", createdBy: teacher.id });
  const [question] = await db.select().from(questions).where(eq(questions.id, id));
  await poolService.putDraft(db, question!, { config: PARAMETERIZED.short, explanation: EXPLANATION, variables: VARIABLES });
  await poolService.publishQuestion(db, question!, { userId: teacher.id });
  return id;
}

/** The parameterized question's key as one attempt drew it. */
async function drawOf(attemptId: string) {
  const [row] = await server.app.db.select().from(attempts).where(eq(attempts.id, attemptId));
  return row!.instances[itemOf.get("param")!]!.values;
}

/**
 * What of the key of question `kind`, drawn for `attemptId`, `text` shows:
 * the markers of a static question; the drawn value, the template's
 * markers and the explanation of the parameterized one.
 *
 * The drawn value is a bare number ("3" when it falls on 3.00), which a
 * neighbour's own payload may hold for its own reasons (a case worth 3
 * points): it is searched in `numeric`, the parameterized question's own
 * payload and the reply's envelope, never in another question's.
 */
async function keyShown(kind: Kind, attemptId: string, text: string, numeric = text): Promise<string[]> {
  if (kind !== "param") return SECRETS[kind].filter((s) => text.includes(s));
  const found = markersIn(text);
  if (showsKey(numeric, await drawOf(attemptId))) found.push("drawn key");
  if (text.includes("The fall lasts")) found.push("explanation");
  return found;
}

/** Forbidden keys anywhere in `value`. */
const forbiddenIn = (value: unknown) => [...keysOf(value)].filter((k) => FORBIDDEN_STUDENT_KEYS.includes(k));

/**
 * Invariant 4 on one attempt view: nothing forbidden outside a correction,
 * and no key of a question that shows none — searched in the WHOLE view,
 * so a key cannot travel on a neighbour. Returns the items, by kind.
 */
async function assertClean(view: AttemptView, attemptId: string): Promise<Map<Kind, AttemptItem>> {
  const byKind = new Map<Kind, AttemptItem>();
  for (const [kind, id] of itemOf) byKind.set(kind, view.items.find((i) => i.id === id)!);
  const withoutCorrections = { ...view, items: view.items.map(({ correction: _c, ...rest }) => rest) };
  expect(forbiddenIn(withoutCorrections)).toEqual([]);
  // The ids and counters of an item are no key ("position": 2): what is searched is what a student reads.
  const read = (i: AttemptItem) => JSON.stringify({ student: i.student, answer: i.answer, correction: i.correction });
  const text = JSON.stringify(view.items.map(read));
  for (const [kind, item] of byKind) {
    if (item.correction === null) {
      expect({ kind, shown: await keyShown(kind, attemptId, text, read(item)) }).toEqual({ kind, shown: [] });
    }
    else expect(item.checked || view.attempt.state !== "in_progress").toBe(true);
  }
  for (const item of byKind.values()) expect(markersIn(JSON.stringify(item.student))).toEqual([]);
  // An essay's criteria and rubric never travel, its correction included.
  expect(GRADERS_ONLY.filter((s) => text.includes(s))).toEqual([]);
  return byKind;
}

async function attemptViewOf(who: Who, attemptId: string): Promise<AttemptView> {
  const res = await get(`/app/api/attempts/${attemptId}`, who.headers);
  expect(res.statusCode).toBe(200);
  expect(res.json().kind).toBe("attempt");
  return res.json().view as AttemptView;
}

async function check(who: Who | Record<string, string>, attemptId: string, kind: Kind, payload: unknown, revision: number) {
  const headers = "headers" in who ? (who.headers as Record<string, string>) : who;
  return post(`/app/api/attempts/${attemptId}/answers/${itemOf.get(kind)}/check`, headers, body(payload, revision));
}

/** A check's reply, clean of every key but the checked question's own. */
async function assertCheckClean(res: { body: string; json: () => unknown }, attemptId: string, checked: readonly Kind[]) {
  const reply = res.json() as CheckResponse;
  const { correction, ...rest } = reply;
  expect(forbiddenIn(rest)).toEqual([]);
  for (const kind of itemOf.keys()) {
    if (checked.includes(kind)) continue;
    expect({ kind, shown: await keyShown(kind, attemptId, res.body, JSON.stringify(rest)) }).toEqual({ kind, shown: [] });
  }
  expect(GRADERS_ONLY.filter((s) => res.body.includes(s))).toEqual([]);
  return correction;
}

const save = (who: Who, attemptId: string, kind: Kind, payload: unknown, revision: number) =>
  server.app.inject({
    method: "PUT",
    url: `/app/api/attempts/${attemptId}/answers/${itemOf.get(kind)}`,
    headers: who.headers,
    payload: body(payload, revision),
  });

beforeAll(async () => {
  server = await testServer();
  server.clock.set("2026-11-02T09:00:00.000Z");
  teacher = await server.signIn("teacher");
  alice = await server.signIn("student");
  bob = await server.signIn("student");
  admin = await server.signIn("admin");
  const db = server.app.db;
  seed = await seedLive(db, {
    teacherId: teacher.id,
    studentIds: [alice.id, bob.id],
    questions: 0,
    mode: "exercise",
    durationS: null,
    settings: { timing: "manual", lobby: "skip" },
  });
  // Stored `none`: an exercise shows its correction whatever it stores (ADR-124 §1).
  await db
    .update(evaluations)
    .set({ feedbackPolicy: { ...defaultFeedbackPolicy(), when: "none", showKey: false, showExplanation: false } })
    .where(eq(evaluations.id, seed.evaluationId));
  const kinds: Kind[] = ["short", "param", "code", "rich"];
  const ids = [await publish("short"), await publishParam(), await publish("code"), await publish("rich")];
  const added = await addItems(
    db,
    (await byId(db, seed.evaluationId))!,
    ids,
    (type, version) => typeOf(type).defaultPoints(exampleConfig(type, version)),
    { attemptCount: 0 },
  );
  kinds.forEach((kind, index) => itemOf.set(kind, added[index]!.id));
  await applyState(db, await reload(db, seed.evaluationId), "running", server.clock.now());
});
afterAll(async () => {
  await server.close();
});

describe("checking a question of an exercise (ADR-124 §3, invariant 4)", () => {
  it("serves an attempt with nothing checked and no key", async () => {
    for (const [name, who] of [["alice", alice], ["bob", bob]] as const) {
      const entered = await post(`/app/api/evaluations/${seed.evaluationId}/attempt/start`, who.headers, {});
      expect(entered.statusCode).toBe(200);
      const view = entered.json().view as AttemptView;
      attemptOf.set(name, view.attempt.id);
      const items = await assertClean(view, view.attempt.id);
      for (const item of items.values()) expect(item).toMatchObject({ checked: false, correction: null });
    }
  });

  it("refuses an empty question, and an autosave's reply carries no key", async () => {
    const attemptId = attemptOf.get("alice")!;
    const empty = await check(alice, attemptId, "rich", { text: "" }, 1);
    expect(empty.statusCode).toBe(422);
    expect(empty.json().error).toBe("nothing_to_check");
    const saved = await save(alice, attemptId, "short", { text: "wrong" }, 1);
    expect(saved.statusCode).toBe(200);
    for (const kind of itemOf.keys()) expect(await keyShown(kind, attemptId, saved.body)).toEqual([]);
    const [row] = await server.app.db
      .select()
      .from(answers)
      .where(and(eq(answers.attemptId, attemptId), eq(answers.itemId, itemOf.get("rich")!)));
    expect(row?.checkedAt ?? null).toBeNull();
  });

  it("checks a deterministic question: the verdict, the points, the key and the explanation at once", async () => {
    const attemptId = attemptOf.get("alice")!;
    server.clock.advance(1000);
    // The answer on screen travels with the check, under the revision guard.
    const res = await check(alice, attemptId, "short", { text: "still wrong" }, 2);
    expect(res.statusCode).toBe(200);
    const correction = await assertCheckClean(res, attemptId, ["short"]);
    expect(res.json()).toMatchObject({ accepted: true, revision: 2 });
    expect(correction).toMatchObject({ verdict: "wrong", points: 0, explanation: "SECRET-SHORT-EXPLANATION" });
    // The breakdown the review draws from, as the feedback page reads it.
    expect(correction.details).not.toBeNull();
    expect(JSON.stringify(correction.solution)).toContain("SECRET-SHORT-KEY");
    // Persisted as the item's automatic grading, validated.
    const rows = await server.app.db
      .select()
      .from(gradings)
      .where(and(eq(gradings.attemptId, attemptId), eq(gradings.itemId, itemOf.get("short")!)));
    expect(rows).toMatchObject([{ state: "validated", source: "auto", points: 0 }]);
  });

  it("locks the checked question: every later write and a second check are refused", async () => {
    const attemptId = attemptOf.get("alice")!;
    const saved = await save(alice, attemptId, "short", { text: "SECRET-SHORT-KEY" }, 3);
    expect(saved.statusCode).toBe(409);
    expect(saved.json().error).toBe("item_checked");
    const again = await check(alice, attemptId, "short", { text: "SECRET-SHORT-KEY" }, 4);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("item_checked");
    for (const path of ["skip", "flag"]) {
      const res = await post(`/app/api/attempts/${attemptId}/answers/${itemOf.get("short")}/${path}`, alice.headers, {
        [path === "skip" ? "skipped" : "flagged"]: true,
      });
      expect(res.statusCode).toBe(409);
    }
    const [row] = await server.app.db
      .select()
      .from(answers)
      .where(and(eq(answers.attemptId, attemptId), eq(answers.itemId, itemOf.get("short")!)));
    expect(row!.payload).toEqual({ text: "still wrong" });
  });

  it("checks a parameterized question on the student's own draw, and no one else's", async () => {
    const attemptId = attemptOf.get("alice")!;
    const t = fallOf(await drawOf(attemptId));
    const res = await check(alice, attemptId, "param", { text: t }, 1);
    expect(res.statusCode).toBe(200);
    const correction = await assertCheckClean(res, attemptId, ["short", "param"]);
    expect(correction.verdict).toBe("correct");
    expect(correction.explanation).toBe(EXPLANATION.replace("[[t]]", t));
    expect(showsKey(JSON.stringify(correction.solution), await drawOf(attemptId))).toBe(true);
    expect(markersIn(res.body)).toEqual([]);
    // Bob's draw is not alice's key, and his paper shows nothing.
    const bobView = await attemptViewOf(bob, attemptOf.get("bob")!);
    await assertClean(bobView, attemptOf.get("bob")!);
  });

  it("checks an essay: the model answer and the explanation, never the criteria, the verdict pending", async () => {
    const attemptId = attemptOf.get("alice")!;
    const res = await check(alice, attemptId, "rich", { text: "An essay." }, 2);
    expect(res.statusCode).toBe(200);
    const correction = await assertCheckClean(res, attemptId, ["short", "param", "rich"]);
    expect(correction).toMatchObject({ verdict: "pending", points: null, explanation: "SECRET-RICH-EXPLANATION" });
    expect(correction.solution).toEqual({ reference: "MODEL-ANSWER-MARKER" });
    // No model was asked, nothing was written: the hand-in grades it.
    const rows = await server.app.db
      .select()
      .from(gradings)
      .where(and(eq(gradings.attemptId, attemptId), eq(gradings.itemId, itemOf.get("rich")!)));
    expect(rows).toEqual([]);
  });

  it("shows the checked questions' corrections again on a resume, and no other key", async () => {
    const attemptId = attemptOf.get("alice")!;
    const items = await assertClean(await attemptViewOf(alice, attemptId), attemptId);
    expect(items.get("short")).toMatchObject({ checked: true, correction: { verdict: "wrong", points: 0 } });
    expect(items.get("param")).toMatchObject({ checked: true, correction: { verdict: "correct" } });
    expect(items.get("rich")).toMatchObject({ checked: true, correction: { verdict: "pending" } });
    // The code question is not checked: its hidden case and its reference stay closed.
    expect(items.get("code")).toMatchObject({ checked: false, correction: null });
  });

  it("serves an impersonation the student's own view, and refuses its check", async () => {
    const attemptId = attemptOf.get("alice")!;
    const as = await sessionOf(server.app.db, alice.id, { kind: "impersonation", actorUserId: admin.id });
    const view = await attemptViewOf({ id: alice.id, headers: as }, attemptId);
    const items = await assertClean(view, attemptId);
    expect(items.get("code")!.correction).toBeNull();
    const acted = await check(as, attemptId, "code", { regions: ["    return 1;\n"] }, 1);
    expect(acted.statusCode).toBe(403);
  });

  it("answers another student's attempt the 404 of a missing one", async () => {
    const attemptId = attemptOf.get("alice")!;
    expect((await get(`/app/api/attempts/${attemptId}`, bob.headers)).statusCode).toBe(404);
    const res = await check(bob, attemptId, "code", { regions: ["    return 1;\n"] }, 1);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("REFERENCE-MARKER");
  });

  it("checks a code question: locked, the key at once, the runner's verdict pending", async () => {
    const attemptId = attemptOf.get("alice")!;
    const res = await check(alice, attemptId, "code", { regions: ["    return 1;\n"] }, 1);
    expect(res.statusCode).toBe(200);
    const correction = await assertCheckClean(res, attemptId, ["short", "param", "rich", "code"]);
    // The test server's runner is the stub: the cell ends as a proposal, still pending.
    expect(correction).toMatchObject({ verdict: "pending", points: null, explanation: "SECRET-CODE-EXPLANATION", details: null });
    expect(JSON.stringify(correction.solution)).toContain("REFERENCE-MARKER");
    // The key shown is the reference and the visible case, never the hidden one (#998, D15).
    expect(HIDDEN_CASE.filter((s) => res.body.includes(s))).toEqual([]);
    expect((correction.solution as { cases: { name: string }[] }).cases.map((c) => c.name)).toEqual(["visible-case"]);
    const saved = await save(alice, attemptId, "code", { regions: ["    return 2;\n"] }, 2);
    expect(saved.json().error).toBe("item_checked");
  });

  it("keeps the hidden case out of a checked code question's breakdown once the runner's verdict lands (#998)", async () => {
    const db = server.app.db;
    const attemptId = attemptOf.get("alice")!;
    // The runner's verdict, as `finalizeRunnerCode` writes it: the hidden case
    // echoes its stdin, which the teacher's breakdown keeps.
    const config = CodeConfig.parse(CONTENT.code.config);
    const run = (stdout: string) => ({ exitCode: 0, stdout, stderr: stdout, ms: 1, timedOut: false, oom: false, truncated: false });
    const { details } = finalizeRunnerCode(
      config,
      { regions: ["    return 1;\n"] },
      { seed: 0, itemId: itemOf.get("code")!, attemptId, itemPoints: 4, now: server.clock.now() },
      { compile: { ok: true, stdout: "", stderr: "", ms: 1 }, cases: [run(""), run("HIDDEN-STDIN-MARKER HIDDEN-ACTUAL-OUT")] },
    );
    await writeGrading(db, {
      attemptId,
      itemId: itemOf.get("code")!,
      answerId: null,
      points: 1,
      maxPoints: 4,
      source: "auto",
      state: "validated",
      details,
      now: server.clock.now(),
    });
    const res = await get(`/app/api/attempts/${attemptId}`, alice.headers);
    expect(res.statusCode).toBe(200);
    const code = (res.json().view as AttemptView).items.find((i) => i.id === itemOf.get("code"))!;
    expect(code.correction).toMatchObject({ verdict: "partial" });
    expect(code.correction!.details).not.toBeNull();
    // The whole response is searched: the hidden case's stdin, expected output and run.
    expect(["HIDDEN-EXPECTED-OUT", "HIDDEN-STDIN-MARKER", "HIDDEN-ACTUAL-OUT"].filter((s) => res.body.includes(s))).toEqual([]);
    // Its name keeps the stored setting (ADR-124 §1), open by default.
    expect(code.correction!.details).toMatchObject({ cases: [{ visible: true }, { name: "hidden-case-secret", visible: false, ok: false }] });
  });

  it("lets the hand-in pass leave a checked question's grading alone, and a reopen keep it locked", async () => {
    const db = server.app.db;
    const attemptId = attemptOf.get("alice")!;
    const shortCell = and(eq(gradings.attemptId, attemptId), eq(gradings.itemId, itemOf.get("short")!));
    const [checkedGrading] = await db.select().from(gradings).where(shortCell);
    server.clock.advance(1000);
    expect((await post(`/app/api/attempts/${attemptId}/submit`, alice.headers, { confirm: true })).statusCode).toBe(200);
    const standing = await db.select().from(gradings).where(and(shortCell, ne(gradings.state, "superseded")));
    expect(standing.map((g) => g.id)).toEqual([checkedGrading!.id]);

    const reopened = await post(`/app/api/evaluations/${seed.evaluationId}/attempts/${attemptId}/reopen`, teacher.headers);
    expect(reopened.statusCode).toBe(200);
    // The check's grading survives the stand-down of the hand-in's.
    const after = await db.select().from(gradings).where(and(shortCell, ne(gradings.state, "superseded")));
    expect(after.map((g) => g.id)).toEqual([checkedGrading!.id]);
    const items = await assertClean(await attemptViewOf(alice, attemptId), attemptId);
    expect(items.get("short")).toMatchObject({ checked: true, correction: { verdict: "wrong" } });
    const saved = await save(alice, attemptId, "short", { text: "SECRET-SHORT-KEY" }, 9);
    expect(saved.json().error).toBe("item_checked");
  });

  it("serves a teacher in the student view the same rule (ADR-018)", async () => {
    const enrolled = await post(`/app/api/classrooms/${seed.classroomId}/self-enroll`, teacher.headers);
    expect(enrolled.statusCode).toBe(201);
    const entered = await post(`/app/api/evaluations/${seed.evaluationId}/attempt/start`, teacher.headers, {});
    expect(entered.statusCode).toBe(200);
    const view = entered.json().view as AttemptView;
    await assertClean(view, view.attempt.id);
    const t = fallOf(await drawOf(view.attempt.id));
    const res = await check(teacher, view.attempt.id, "param", { text: t }, 1);
    expect(res.statusCode).toBe(200);
    await assertCheckClean(res, view.attempt.id, ["param"]);
    await assertClean(await attemptViewOf(teacher, view.attempt.id), view.attempt.id);
  });

  it("checks on a practice attempt after the due date, and refuses one past its deadline plus the grace", async () => {
    const db = server.app.db;
    // Bob hands his in; the exercise closes; he practises (ADR-122).
    await post(`/app/api/attempts/${attemptOf.get("bob")}/submit`, bob.headers, { confirm: true });
    await post(`/app/api/attempts/${attemptOf.get("alice")}/submit`, alice.headers, { confirm: true });
    expect((await post(`/app/api/evaluations/${seed.evaluationId}/close`, teacher.headers)).statusCode).toBe(200);
    const started = await post(`/app/api/evaluations/${seed.evaluationId}/practice/start`, bob.headers);
    expect(started.statusCode).toBe(200);
    const view = started.json().view as AttemptView;
    expect(view.attempt.practice).toBe(true);
    const practiceId = view.attempt.id;
    for (const item of (await assertClean(view, practiceId)).values()) expect(item.correction).toBeNull();

    const res = await check(bob, practiceId, "short", { text: "SECRET-SHORT-KEY" }, 1);
    expect(res.statusCode).toBe(200);
    expect((await assertCheckClean(res, practiceId, ["short"])).verdict).toBe("correct");
    await assertClean(await attemptViewOf(bob, practiceId), practiceId);

    const [row] = await db.select().from(attempts).where(eq(attempts.id, practiceId));
    server.clock.set(new Date(row!.deadlineAt!.getTime() + 3_001));
    const late = await check(bob, practiceId, "rich", { text: "Too late." }, 1);
    expect(late.statusCode).toBe(410);
    expect(late.json()).toMatchObject({ error: "attempt_closed", reason: "deadline" });
  });
});

describe("an exam refuses the check (ADR-124 §3)", () => {
  it("answers 409 not_checkable and writes nothing", async () => {
    const db = server.app.db;
    const carol = await server.signIn("student");
    const exam = await seedLive(db, { teacherId: teacher.id, studentIds: [carol.id], questions: 0, mode: "exam" });
    const { type, config } = CONTENT.short;
    const { id } = await poolService.createQuestion(db, { poolId: exam.poolId, type, internalName: "exam-short", createdBy: teacher.id });
    const [question] = await db.select().from(questions).where(eq(questions.id, id));
    await poolService.putDraft(db, question!, { config });
    await poolService.publishQuestion(db, question!, { userId: teacher.id });
    const [item] = await addItems(db, (await byId(db, exam.evaluationId))!, [id], (t, v) => typeOf(t).defaultPoints(exampleConfig(t, v)), {
      attemptCount: 0,
    });
    await applyState(db, await reload(db, exam.evaluationId), "running", server.clock.now());
    const entered = await post(`/app/api/evaluations/${exam.evaluationId}/attempt/start`, carol.headers, {});
    const attemptId = (entered.json().view as AttemptView).attempt.id;
    const res = await post(`/app/api/attempts/${attemptId}/answers/${item!.id}/check`, carol.headers, body({ text: "x" }, 1));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_checkable");
    expect(await db.select().from(answers).where(eq(answers.attemptId, attemptId))).toEqual([]);
    expect((await attemptViewOf(carol, attemptId)).items[0]).toMatchObject({ checked: false, correction: null });
  });
});

describe("a checked code question and the queues (ADR-124 §3)", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = registerForTests(fakeRunnableCode);
  });
  afterAll(() => restore());

  /**
   * One running exercise of one runner-graded question, on an app whose queue
   * records what is sent — with its priority — and a runner that counts its
   * runs. `drain` runs the queued jobs of one queue, highest priority first,
   * then oldest first, as pg-boss takes them one at a time
   * (`GRADING_RUNNER_CONCURRENCY` 1, its default).
   */
  async function queuedWorld() {
    const base = await testApp(server.app.db);
    base.clock.set("2026-11-02T10:00:00.000Z");
    const sent: { name: string; data: unknown; priority: number }[] = [];
    const handlers = new Map<string, (data: unknown) => Promise<void>>();
    const queue: JobQueue = {
      createQueue: async () => {},
      send: async (name, data, options) => void sent.push({ name, data, priority: options?.priority ?? 0 }),
      work: async (name, handler) => void handlers.set(name, handler as (data: unknown) => Promise<void>),
      stop: async () => {},
    };
    const runner: RunnerService & { calls: number } = {
      calls: 0,
      run: async () => {
        runner.calls += 1;
        return {
          compile: { ok: true, stdout: "", stderr: "", ms: 1 },
          cases: [{ exitCode: 0, stdout: "ok", stderr: "", ms: 2, timedOut: false, oom: false, truncated: false }],
        };
      },
      health: async () => ({ ok: true, languages: ["c"], queued: 0, avgMs: 1 }),
    };
    const app = Object.assign(Object.create(base), { boss: queue, runner }) as typeof base;
    await registerGradingJobs(app, queue, { GRADING_RUNNER_CONCURRENCY: 1 });
    const drain = async (name: string) => {
      for (;;) {
        const mine = sent.filter((j) => j.name === name);
        if (mine.length === 0) return;
        const next = mine.reduce((a, b) => (b.priority > a.priority ? b : a));
        sent.splice(sent.indexOf(next), 1);
        await handlers.get(name)!(next.data);
      }
    };

    const db = app.db;
    const world = await seedLive(db, {
      students: 1,
      questions: 0,
      mode: "exercise",
      durationS: null,
      settings: { timing: "manual", lobby: "skip" },
    });
    const { id } = await poolService.createQuestion(db, { poolId: world.poolId, type: "code", internalName: "code", createdBy: world.teacherId });
    const [question] = await db.select().from(questions).where(eq(questions.id, id));
    await poolService.putDraft(db, question!, { config: codeConfig });
    await poolService.publishQuestion(db, question!, { userId: world.teacherId });
    await addItems(db, await reload(db, world.evaluationId), [id], (t, v) => typeOf(t).defaultPoints(exampleConfig(t, v)), {
      attemptCount: 0,
    });
    const evaluation = await applyState(db, await reload(db, world.evaluationId), "running", app.clock.now());
    const [item] = await joinedItems(db, evaluation.id);
    const participant = (await live.participantOf(db, evaluation, world.studentIds[0]!))!;
    const { attempt } = await enterStarted(db, { evaluation, participant, now: app.clock.now() });
    const write = (payload: unknown, revision: number) => ({
      evaluation,
      attempt,
      itemId: item!.item.id,
      payload,
      revision,
      now: app.clock.now(),
    });
    const cell = and(eq(gradings.attemptId, attempt.id), ne(gradings.state, "superseded"));
    return { app, db, sent, drain, runner, evaluation, attempt, item: item!, write, cell };
  }

  it("lands the runner's verdict on the cell while the attempt is still open", async () => {
    const { app, db, sent, drain, evaluation, attempt, item, write } = await queuedWorld();
    const reply = await live.checkItem(app, write({ regions: ["return 0;"] }, 1));
    expect(reply.correction.verdict).toBe("pending");
    expect(sent.map((j) => [j.name, j.priority])).toEqual([[GRADING_RUNNER_QUEUE, 0]]);
    await drain(GRADING_RUNNER_QUEUE);
    const open = await live.attemptView(db, evaluation, (await live.attemptById(db, attempt.id))!, app.clock.now());
    expect(open.attempt.state).toBe("in_progress");
    expect(open.items[0]).toMatchObject({ checked: true, correction: { verdict: "correct", points: item.item.points } });
    // The runner's breakdown travels with it: what the code review draws.
    expect(open.items[0]!.correction?.details).not.toBeNull();
  });

  it("runs once when the attempt is handed in while the check's job still waits", async () => {
    const { app, db, sent, drain, runner, evaluation, attempt, write, cell } = await queuedWorld();
    await live.checkItem(app, write({ regions: ["return 0;"] }, 1));
    // Handed in before the runner took the check's job: the hand-in's pass
    // finds no validated grading and sends a job of its own, at a lower
    // priority — the bounded duplicate `enqueueCheckRun` accepts.
    await live.submitAttempt(db, evaluation, (await live.attemptById(db, attempt.id))!, app.clock.now(), app);
    await drain(GRADING_EVALUATION_QUEUE);
    expect(sent.map((j) => [j.name, j.priority])).toEqual([
      [GRADING_RUNNER_QUEUE, 0],
      [GRADING_RUNNER_QUEUE, -10],
    ]);
    await drain(GRADING_RUNNER_QUEUE);
    // The check's job ran; the pass's found the cell validated and ran nothing.
    expect(runner.calls).toBe(1);
    expect(await db.select().from(gradings).where(cell)).toMatchObject([{ state: "validated", source: "auto" }]);
  });

  it("refuses an autosave that read the question before a check committed (no write over a checked answer)", async () => {
    const { app, db, write, attempt, item } = await queuedWorld();
    await live.saveAnswer(db, write({ regions: ["return 1;"] }, 1));
    // The autosave below passes its gate and reads the row unchecked; the
    // check commits before its transaction starts.
    const racing = Object.assign(Object.create(db) as typeof db, {
      transaction: async (...args: Parameters<typeof db.transaction>) => {
        await live.checkItem(app, write({ regions: ["return 2;"] }, 2));
        return db.transaction(...args);
      },
    });
    await expect(live.saveAnswer(racing, write({ regions: ["return 3;"] }, 3))).rejects.toMatchObject({
      code: "item_checked",
    });
    const [row] = await db
      .select()
      .from(answers)
      .where(and(eq(answers.attemptId, attempt.id), eq(answers.itemId, item.item.id)));
    expect(row).toMatchObject({ payload: { regions: ["return 2;"] }, revision: 2 });
    expect(row!.checkedAt).not.toBeNull();
  });
});

describe("a check whose grading fails after the mark (ADR-124 §3)", () => {
  it("answers the key and pending, keeps the question locked, and the hand-in grades it", async () => {
    const restore = registerForTests(fakeShort);
    try {
      // No queue: the hand-in's pass runs inline.
      const base = await testApp(server.app.db);
      base.clock.set("2026-11-02T11:00:00.000Z");
      const db = base.db;
      const world = await seedLive(db, {
        students: 1,
        questions: 1,
        mode: "exercise",
        durationS: null,
        settings: { timing: "manual", lobby: "skip" },
      });
      const evaluation = await applyState(db, await reload(db, world.evaluationId), "running", base.clock.now());
      const [item] = await joinedItems(db, evaluation.id);
      const participant = (await live.participantOf(db, evaluation, world.studentIds[0]!))!;
      const { attempt } = await enterStarted(db, { evaluation, participant, now: base.clock.now() });
      const write = (payload: unknown, revision: number) => ({
        evaluation,
        attempt,
        itemId: item!.item.id,
        payload,
        revision,
        now: base.clock.now(),
      });

      // The third transaction of the check is the grading's write: the
      // answer's and the mark's commit, then the store fails.
      let transactions = 0;
      const failing = Object.assign(Object.create(db) as typeof db, {
        transaction: async (...args: Parameters<typeof db.transaction>) => {
          transactions += 1;
          if (transactions === 3) throw new Error("the grading store is down");
          return db.transaction(...args);
        },
      });
      const app = Object.assign(Object.create(base), { db: failing }) as typeof base;
      const reply = await live.checkItem(app, write("answer-q0", 1));
      expect(transactions).toBe(3);
      expect(reply.correction).toMatchObject({ verdict: "pending", points: null, solution: { answer: "answer-q0" } });
      const cell = and(eq(gradings.attemptId, attempt.id), ne(gradings.state, "superseded"));
      expect(await db.select().from(gradings).where(cell)).toEqual([]);

      // Still checked: locked, and shown pending on a resume.
      await expect(live.saveAnswer(db, write("other", 2))).rejects.toMatchObject({ code: "item_checked" });
      const open = await live.attemptView(db, evaluation, (await live.attemptById(db, attempt.id))!, base.clock.now());
      expect(open.items[0]).toMatchObject({ checked: true, correction: { verdict: "pending" } });

      // The hand-in's pass grades the cell it finds without a verdict.
      await live.submitAttempt(db, evaluation, (await live.attemptById(db, attempt.id))!, base.clock.now(), base);
      expect(await db.select().from(gradings).where(cell)).toMatchObject([
        { state: "validated", source: "auto", points: item!.item.points },
      ]);
    } finally {
      restore();
    }
  });
});
