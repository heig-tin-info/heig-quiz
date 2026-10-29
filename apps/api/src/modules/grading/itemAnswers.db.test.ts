/**
 * Every answer to one item as one file (F-EXP-01, ADR-121, issue #972),
 * over the real application: the Markdown and its record, the attempt that
 * counts (ADR-025), the teacher's test walk left out (ADR-018), the students
 * with no attempt or no answer listed, the hidden tests named, the
 * provenance read back by the journal's front-matter parser, and the
 * 404 of anyone the evaluation does not belong to (invariant 6).
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GradingQueue, ItemAnswersRecord } from "@quiz/contracts";
import { splitFrontMatter } from "@quiz/docrender/frontMatter";
import { sha256 } from "@quiz/docexport";
import { splitTemplate } from "@quiz/domain/lockedTemplate";
import { registerForTests } from "@quiz/registry/server";

import { enrollments } from "../../db/schema.js";
import { type TestServer, testServer } from "../../test/http.js";
import { fakeShort } from "../../test/fakeType.js";
import { enterStarted, publishQuestion, reload, seedLive } from "../../test/live.js";
import { addItems, applyState, joinedItems, type EvaluationRecord } from "../evaluation/service.js";
import * as live from "../live/service.js";
import { loadConfig, typeOf } from "../pool/config.js";
import { writeGrading } from "./service.js";

const TEMPLATE = "// @@lock\nint main(void) {\n// @@endlock\n    return 0;\n// @@lock\n}\n// @@endlock\n";
const REFERENCE = "int main(void) { return REFERENCE_MARKER; }";
const HIDDEN = "hidden-case-name";

const CODE = {
  configVersion: 1,
  prompt: "Return the answer.",
  language: "c",
  runtime: "backend",
  template: TEMPLATE,
  referenceSolution: REFERENCE,
  tests: {
    mode: "io",
    cases: [
      { name: "visible-case", stdin: "", expected: "", visible: true, points: 1 },
      { name: HIDDEN, stdin: "", expected: "", visible: false, points: 3 },
    ],
  },
};

let server: TestServer;
let restore: () => void;
let teacher: { id: string; headers: Record<string, string> };
let other: { id: string; headers: Record<string, string> };
let built: Awaited<ReturnType<typeof gradedExercise>>;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  teacher = await server.signIn("teacher");
  other = await server.signIn("teacher");
  built = await gradedExercise();
});
afterAll(async () => {
  await server.close();
  restore();
});

const get = (url: string, headers: Record<string, string>) => server.app.inject({ method: "GET", url, headers });

/** The answer whose editable region holds `marker`, in as many regions as the template has. */
function answerWith(marker: string) {
  const editable = splitTemplate(TEMPLATE, "c").filter((s) => s.kind === "editable").length;
  return { regions: Array.from({ length: editable }, (_, i) => (i === editable - 1 ? `    return ${marker};\n` : "")) };
}

const details = (ok: boolean) => ({
  runner: "ok",
  compile: { ok: true, stderr: "", ms: 1 },
  cases: [
    { name: "visible-case", visible: true, points: 1, ok: true, exitCode: 0, ms: 1, timedOut: false, oom: false },
    { name: HIDDEN, visible: false, points: 3, ok, exitCode: 0, ms: 1, timedOut: false, oom: false },
  ],
  earned: ok ? 4 : 1,
  total: 4,
  sourceSha256: null,
});

/**
 * A running exercise with retakes (best kept), one `code` item and one fake
 * `short` one: student 0 sits twice (the first attempt is the better), student
 * 1 hands in without answering, student 2 never starts, and the teacher takes
 * a test walk on a staff seat.
 */
async function gradedExercise() {
  const db = server.app.db;
  const now = server.clock.now();
  const seed = await seedLive(db, {
    teacherId: teacher.id,
    mode: "exercise",
    students: 3,
    questions: 1,
    durationS: null,
    settings: {
      timing: "manual",
      lobby: "skip",
      retakes: { enabled: true, keep: "best", maxAttempts: null },
    },
  });
  const questionId = await publishQuestion(db, seed.poolId, teacher.id, "sum", { type: "code", config: CODE });
  await addItems(db, await reload(db, seed.evaluationId), [questionId], (type, version) =>
    typeOf(type).defaultPoints(loadConfig(type, version)), { attemptCount: 0 });
  await db.insert(enrollments).values({
    id: randomUUID(),
    classroomId: seed.classroomId,
    nom: "Prof",
    prenom: "Test",
    email: `staff-${seed.classroomId.slice(0, 8)}@heig.test`,
    userId: teacher.id,
    staff: true,
  });
  const evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", now);
  const items = await joinedItems(db, evaluation.id);
  const code = items.find((i) => i.question.type === "code")!;
  const shortItem = items.find((i) => i.question.type === "short")!;

  const sit = async (userId: string, marker: string | null, ok: boolean, retake = false) => {
    const participant = (await live.participantOf(db, evaluation, userId))!;
    const attempt = retake
      ? await live.retakeAttempt(db, { evaluation: await reload(db, evaluation.id), participant, now })
      : (await enterStarted(db, { evaluation, participant, now })).attempt;
    if (marker !== null) {
      await live.saveAnswer(db, { evaluation, attempt, itemId: code.item.id, payload: answerWith(marker), revision: 1, now });
    }
    const submitted = await live.submitAttempt(db, evaluation, attempt, now);
    await writeGrading(db, {
      attemptId: submitted.id,
      itemId: code.item.id,
      answerId: null,
      points: ok ? code.item.points : 0,
      maxPoints: code.item.points,
      source: "auto",
      state: "validated",
      details: details(ok),
      now,
    });
    return submitted;
  };
  const [s0, s1] = seed.studentIds as [string, string, string];
  const best = await sit(s0, "BEST_MARKER", true);
  const worse = await sit(s0, "WORSE_MARKER", false, true);
  const empty = await sit(s1, null, false);
  await sit(teacher.id, "TEACHER_WALK_MARKER", true);
  return { evaluation: evaluation as EvaluationRecord, code, shortItem, best, worse, empty };
}

const url = (itemId: string, ext: "md" | "json") =>
  `/app/api/evaluations/${built.evaluation.id}/items/${itemId}/answers.${ext}`;

describe("every answer to one item (F-EXP-01)", () => {
  it("serves the class's answers as Markdown: the counting attempt, by name", async () => {
    const res = await get(url(built.code.item.id, "md"), teacher.headers);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="[a-z0-9-]+-q\d+\.md"$/);
    const text = res.body;
    expect(text).toContain("# Test évaluation");
    expect(text).toContain("Return the answer.");
    expect(text).toContain("REFERENCE_MARKER");
    // The best attempt counts (ADR-025), not the later, worse one.
    expect(text).toContain("## Nom0 Prenom0");
    expect(text).toContain("return BEST_MARKER;");
    expect(text).not.toContain("WORSE_MARKER");
    // The source as it ran, rebuilt from the stored template (invariant 14).
    expect(text).toContain("```c\n// @@lock\nint main(void) {");
    // Hidden tests by name, with their verdicts and the points.
    expect(text).toContain(`| ${HIDDEN} | hidden | passed | 3 |`);
    expect(text).toMatch(/## Nom1 Prenom1\n\nNo answer\.\n\nPoints: 0 \//);
    expect(text).toMatch(/## Nom2 Prenom2\n\nNo attempt\./);
    // The teacher's test walk is not a student (ADR-018).
    expect(text).not.toContain("TEACHER_WALK_MARKER");
    expect(text).not.toContain("## Prof");
  });

  it("opens with a provenance front matter the journal's parser reads", async () => {
    const res = await get(url(built.code.item.id, "md"), teacher.headers);
    const { frontMatter, body, warnings } = splitFrontMatter(res.body);
    expect(warnings).toEqual([]);
    expect(frontMatter).toMatchObject({
      export: { kind: "item-answers", format: "md", version: 1 },
      source: {
        evaluationId: built.evaluation.id,
        itemId: built.code.item.id,
        questionId: built.code.question.id,
        questionVersionId: built.code.version.id,
      },
      generatedAt: server.clock.now().toISOString(),
      sha256: sha256(body),
    });
    expect(new Set(frontMatter["attempts"] as string[])).toEqual(new Set([built.best.id, built.empty.id]));
    expect(res.body).not.toContain("@heig.test");
  });

  it("serves the same rows as a record", async () => {
    const res = await get(url(built.code.item.id, "json"), teacher.headers);
    expect(res.statusCode).toBe(200);
    const record = ItemAnswersRecord.parse(res.json());
    expect(record.answers.map((a) => a.student.lastName)).toEqual(["Nom0", "Nom1", "Nom2"]);
    expect(record.answers[0]!.attempt!.id).toBe(built.best.id);
    expect(record.answers[1]!.answer).toBeNull();
    expect(record.answers[2]!.attempt).toBeNull();
  });

  it("offers Markdown only for a type that renders as text, the record for every item", async () => {
    const queue = GradingQueue.parse(
      (await get(`/app/api/evaluations/${built.evaluation.id}/grading`, teacher.headers)).json(),
    );
    const exportable = Object.fromEntries(queue.items.map((i) => [i.type, i.exportable]));
    expect(exportable).toEqual({ short: false, code: true });
    const md = await get(url(built.shortItem.item.id, "md"), teacher.headers);
    expect(md.statusCode).toBe(409);
    expect(md.json().error).toBe("not_exportable");
    expect((await get(url(built.shortItem.item.id, "json"), teacher.headers)).statusCode).toBe(200);
  });

  it("is a 404 for another teacher and for an item of another evaluation", async () => {
    expect((await get(url(built.code.item.id, "md"), other.headers)).statusCode).toBe(404);
    expect((await get(url(built.code.item.id, "json"), other.headers)).statusCode).toBe(404);
    expect((await get(url(randomUUID(), "md"), teacher.headers)).statusCode).toBe(404);
  });
});
