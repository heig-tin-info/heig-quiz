/**
 * Invariant 4 for parameterized questions (ADR-056 §4, docs/05 §5.7).
 *
 * One evaluation holds a parameterized `mcq`, `short` and `cloze`, each with
 * variables in its statement, its choices or blanks, its key and its
 * explanation. Two students sit it over HTTP; every student path — the
 * attempt and its reload, the feedback after the release, the teacher's
 * preview "as a student" — is serialized and searched for every trace of the
 * template (`MARKERS`: the `[[`, the names as references, the expressions,
 * the condition, the table's vocabulary) and, where the key must not show,
 * for the student's own instantiated key.
 *
 * Beside the leak: the values are drawn ONCE, at the attempt's creation, and
 * stored (§5) — two attempts get two instances, a reload gets the same one
 * even after the question was republished with another table, the grading
 * reads the student's own numbers, and a regrade keeps them under a version
 * with the same names and refuses one with others. A poll refuses such a
 * question (§10).
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FeedbackPolicy } from "@quiz/contracts";

import { attempts, evaluations, gradings, questions } from "../../db/schema.js";
import { type Payload, testServer, type TestServer } from "../../test/http.js";
import { seedLive, type Seeded } from "../../test/live.js";
import {
  EXPLANATION,
  fallOf,
  markersIn,
  PARAMETERIZED,
  publishParameterized,
  VARIABLES,
} from "../../test/parameterized.js";
import { addItems, byId } from "../evaluation/service.js";
import { createPoll } from "../poll/service.js";
import { exampleConfig, typeOf } from "../pool/service.js";
import * as poolService from "../pool/service.js";

type Kind = "mcq" | "short" | "cloze";
const KINDS: Kind[] = ["mcq", "short", "cloze"];

let server: TestServer;
let teacher: { id: string; headers: Record<string, string> };
let alice: { id: string; headers: Record<string, string> };
let bob: { id: string; headers: Record<string, string> };
let seed: Seeded;
const questionOf = new Map<Kind, string>();
const itemOf = new Map<Kind, string>();
const attemptOf = new Map<string, string>();

const get = (url: string, headers: Record<string, string>) => server.app.inject({ method: "GET", url, headers });
const post = (url: string, headers: Record<string, string>, payload?: Payload) =>
  server.app.inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload }) });

/** The stored values of one item of one attempt, read back from `attempts.instances`. */
async function valuesOf(attemptId: string, kind: Kind) {
  const [row] = await server.app.db.select().from(attempts).where(eq(attempts.id, attemptId));
  return row!.instances[itemOf.get(kind)!]!;
}

async function answer(who: { headers: Record<string, string> }, attemptId: string, kind: Kind, payload: unknown) {
  const res = await server.app.inject({
    method: "PUT",
    url: `/app/api/attempts/${attemptId}/answers/${itemOf.get(kind)}`,
    headers: who.headers,
    payload: { payload, revision: 1, clientTs: server.clock.now().toISOString() },
  });
  expect(res.statusCode).toBe(200);
  // The autosave's answer is a student payload too.
  expect(markersIn(res.body)).toEqual([]);
}

async function setPolicy(patch: Partial<FeedbackPolicy>): Promise<void> {
  await server.app.db
    .update(evaluations)
    .set({ feedbackPolicy: FeedbackPolicy.parse(patch) })
    .where(eq(evaluations.id, seed.evaluationId));
}

async function feedbackOf(who: { headers: Record<string, string> }) {
  const res = await get(`/app/api/attempts/${attemptOf.get(who === alice ? "alice" : "bob")}/feedback`, who.headers);
  expect(res.statusCode).toBe(200);
  expect(res.json().available).toBe(true);
  return res.json() as { items: { itemId: string; points: number | null; explanation: string | null; solution: unknown }[] };
}

/** Publishes a new version of the mcq with `variables`, through the ordinary services. */
async function republishMcq(variables: typeof VARIABLES): Promise<void> {
  const db = server.app.db;
  const [question] = await db.select().from(questions).where(eq(questions.id, questionOf.get("mcq")!));
  const saved = await poolService.putDraft(db, question!, { config: PARAMETERIZED.mcq, variables });
  expect(saved.issues).toEqual([]);
  await poolService.publishQuestion(db, question!, { userId: teacher.id });
}

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
  alice = await server.signIn("student");
  bob = await server.signIn("student");
  const db = server.app.db;
  seed = await seedLive(db, { teacherId: teacher.id, studentIds: [alice.id, bob.id], questions: 0 });
  for (const kind of KINDS) {
    questionOf.set(kind, await publishParameterized(db, { poolId: seed.poolId, teacherId: teacher.id, type: kind }));
  }
  const added = await addItems(
    db,
    (await byId(db, seed.evaluationId))!,
    KINDS.map((k) => questionOf.get(k)!),
    (type, version) => typeOf(type).defaultPoints(exampleConfig(type, version)),
    { attemptCount: 0 },
  );
  // `addItems` keeps the order it was given.
  KINDS.forEach((kind, index) => itemOf.set(kind, added[index]!.id));
  await post(`/app/api/evaluations/${seed.evaluationId}/start`, teacher.headers, { confirm: true });
});
afterAll(async () => {
  await server.close();
});

describe("the attempt (ADR-056 §5, invariant 4)", () => {
  const views = new Map<string, string>();

  it("draws each attempt its own values at its creation, and serves no trace of the template", async () => {
    for (const [name, who] of [["alice", alice], ["bob", bob]] as const) {
      const entered = await post(`/app/api/evaluations/${seed.evaluationId}/attempt`, who.headers, {});
      expect(entered.statusCode).toBe(200);
      const view = entered.json().view as { attempt: { id: string }; items: { id: string; student: unknown }[] };
      attemptOf.set(name, view.attempt.id);
      const serialized = JSON.stringify(view);
      expect(markersIn(serialized)).toEqual([]);
      views.set(name, JSON.stringify(view.items.map((i) => i.student)));
      // Stored for every parameterized item, under the version it was drawn for.
      const [row] = await server.app.db.select().from(attempts).where(eq(attempts.id, view.attempt.id));
      expect(Object.keys(row!.instances).sort()).toEqual([...itemOf.values()].sort());
      for (const kind of KINDS) {
        const stored = row!.instances[itemOf.get(kind)!]!;
        expect(Object.keys(stored.values).sort()).toEqual(["g", "h", "t"]);
        // The key of a short answer or of a blank: never in the paper.
        const own = JSON.stringify(view.items.find((i) => i.id === itemOf.get(kind))!.student);
        if (kind !== "mcq") expect(own).not.toContain(fallOf(stored.values));
        expect(own).toContain(`${stored.values["h"]} m`);
      }
    }
    const a = await Promise.all(KINDS.map((k) => valuesOf(attemptOf.get("alice")!, k)));
    const b = await Promise.all(KINDS.map((k) => valuesOf(attemptOf.get("bob")!, k)));
    expect(JSON.stringify(a.map((s) => s.values))).not.toBe(JSON.stringify(b.map((s) => s.values)));
  });

  it("serves the stored instance again on a reload, even once the question was republished", async () => {
    // Version 2: the same names, another formula. The item keeps its version.
    await republishMcq({ ...VARIABLES, rows: VARIABLES.rows.map((r) => (r.name === "t" ? { ...r, expr: "sqrt(h/g)" } : r)) });
    for (const name of ["alice", "bob"]) {
      const who = name === "alice" ? alice : bob;
      const restored = await get(`/app/api/attempts/${attemptOf.get(name)}`, who.headers);
      expect(restored.json().kind).toBe("attempt");
      const items = restored.json().view.items as { student: unknown }[];
      expect(JSON.stringify(items.map((i) => i.student))).toBe(views.get(name));
    }
  });

  it("grades each answer on the student's own numbers", async () => {
    const aliceAttempt = attemptOf.get("alice")!;
    const bobAttempt = attemptOf.get("bob")!;
    const t = fallOf((await valuesOf(aliceAttempt, "short")).values);
    const tCloze = fallOf((await valuesOf(aliceAttempt, "cloze")).values);
    await answer(alice, aliceAttempt, "mcq", { selected: [0] });
    await answer(alice, aliceAttempt, "short", { text: t });
    await answer(alice, aliceAttempt, "cloze", { blanks: [tCloze] });
    await answer(bob, bobAttempt, "mcq", { selected: [1] });
    await answer(bob, bobAttempt, "short", { text: "0" });
    await answer(bob, bobAttempt, "cloze", { blanks: ["0"] });

    await post(`/app/api/evaluations/${seed.evaluationId}/close`, teacher.headers);
    const rows = await server.app.db.select().from(gradings).where(eq(gradings.attemptId, aliceAttempt));
    expect(rows.map((r) => [r.state, r.points === r.maxPoints])).toEqual(KINDS.map(() => ["validated", true]));
    const wrong = await server.app.db.select().from(gradings).where(eq(gradings.attemptId, bobAttempt));
    expect(wrong.every((r) => r.points === 0)).toBe(true);
    await post(`/app/api/evaluations/${seed.evaluationId}/release`, teacher.headers, { confirm: true });
  });
});

describe("the feedback after the release (invariant 4)", () => {
  it("hides the key — the student's own numbers included — when the policy does", async () => {
    await setPolicy({ showKey: false, showExplanation: false });
    const feedback = await feedbackOf(bob);
    expect(markersIn(JSON.stringify(feedback))).toEqual([]);
    for (const kind of ["short", "cloze"] as const) {
      const t = fallOf((await valuesOf(attemptOf.get("bob")!, kind)).values);
      const item = feedback.items.find((i) => i.itemId === itemOf.get(kind))!;
      expect(JSON.stringify(item)).not.toContain(t);
    }
  });

  it("shows the student's own key and explanation, instantiated, when it does", async () => {
    await setPolicy({ showKey: true, showExplanation: true });
    const feedback = await feedbackOf(alice);
    expect(markersIn(JSON.stringify(feedback))).toEqual([]);
    for (const kind of KINDS) {
      const t = fallOf((await valuesOf(attemptOf.get("alice")!, kind)).values);
      const item = feedback.items.find((i) => i.itemId === itemOf.get(kind))!;
      expect(item.explanation).toBe(EXPLANATION.replace("[[t]]", t));
      if (kind === "short") expect(JSON.stringify(item.solution)).toContain(t);
    }
  });
});

describe("the teacher's preview, as a student (invariant 4)", () => {
  it("renders an instance of its seed through the student view", async () => {
    const started = await post(`/app/api/evaluations/${seed.evaluationId}/preview`, teacher.headers, { seed: 1234 });
    expect(started.statusCode).toBe(200);
    expect(markersIn(JSON.stringify(started.json()))).toEqual([]);
    for (const kind of KINDS) {
      const one = await get(`/app/api/evaluations/${seed.evaluationId}/preview/items/${itemOf.get(kind)}`, teacher.headers);
      expect(one.statusCode).toBe(200);
      expect(markersIn(JSON.stringify(one.json()))).toEqual([]);
      const key = await get(
        `/app/api/evaluations/${seed.evaluationId}/preview/items/${itemOf.get(kind)}/solution`,
        teacher.headers,
      );
      expect(key.statusCode).toBe(200);
      expect(markersIn(JSON.stringify(key.json()))).toEqual([]);
    }
  });
});

describe("a regrade with another version (ADR-056 §5)", () => {
  const regrade = (toVersionNumber: number) =>
    post(`/app/api/evaluations/${seed.evaluationId}/items/${itemOf.get("mcq")}/regrade`, teacher.headers, {
      note: "formula fixed",
      toVersionNumber,
    });

  it("keeps the students' values under the same names, replaying the derived rows", async () => {
    const before = await valuesOf(attemptOf.get("alice")!, "mcq");
    const res = await regrade(2);
    expect(res.statusCode).toBe(202);
    const cells = await server.app.db
      .select()
      .from(gradings)
      .where(and(eq(gradings.itemId, itemOf.get("mcq")!), eq(gradings.state, "validated")));
    expect(cells).toHaveLength(2);
    // The stored values are never rewritten: they stay those the student had.
    expect(await valuesOf(attemptOf.get("alice")!, "mcq")).toEqual(before);
  });

  it("refuses a version whose variables have other names, and leaves the item alone", async () => {
    await republishMcq({ ...VARIABLES, rows: [...VARIABLES.rows, { name: "k", expr: "randint(1, 9)", format: "int" }] });
    const res = await regrade(3);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("variables_changed");
  });
});

describe("a poll (ADR-056 §10)", () => {
  it("refuses a parameterized question", async () => {
    await expect(
      createPoll(server.app.db, {
        classroomId: seed.classroomId,
        questionId: questionOf.get("short")!,
        createdBy: teacher.id,
        now: server.clock.now(),
      }),
    ).rejects.toMatchObject({ code: "poll_parameterized" });
  });
});
