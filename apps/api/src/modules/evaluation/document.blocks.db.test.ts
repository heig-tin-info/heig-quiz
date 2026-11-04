/**
 * A `blocks` question on paper (ADR-126 §8, §9), over the real application:
 * the hand-out draws the visible warehouses and never a hidden one — its
 * map, name or battery — nor the reference program, in the four forms of
 * ADR-125 §19 (the tree, its Typst source, the Markdown, the PDF's text);
 * the staff "statement with key" holds them all (the positive control);
 * and the student's own documents — the blank print of a past series and
 * the copy of a released exam under a shown key — keep the hidden
 * warehouses out.
 *
 * A hidden map is drawn as shapes, not text: its trace in a source is its
 * figure's `viewBox`, whose size no visible warehouse here shares.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FeedbackPolicy } from "@quiz/contracts";
import { findStudentLeaks } from "@quiz/core/testing";
import type { Block, Document } from "@quiz/docexport";
import { renderTypst } from "@quiz/docexport/typst";

import { answers, evaluations, questions } from "../../db/schema.js";
import { type Payload, testServer, type TestServer } from "../../test/http.js";
import { reload, seedLive } from "../../test/live.js";
import { pdfText, pdfTools } from "../../test/pdf.js";
import { findOwnAttempt } from "../guards.js";
import * as live from "../live/service.js";
import { typeOf } from "../pool/config.js";
import * as poolService from "../pool/service.js";
import { studentCopyDocument, studentCopyRecord } from "../results/service.js";
import { handout, handoutTree } from "./document.js";
import { addItems, applyState } from "./service.js";

/** The wall follower: it reaches the dock in every warehouse below. */
const REFERENCE = [
  {
    kind: "repeat_until_dock",
    body: [{ kind: "if_sensor", sensor: "free", where: "front", then: [{ kind: "forward" }], else: [{ kind: "turn", dir: "right" }] }],
  },
];

/** Two visible warehouses, two hidden ones of sizes no visible one has (5×3 and 8×5). */
const BLOCKS = {
  configVersion: 1,
  prompt: "Bring BLOCKS_PROMPT to the dock.",
  world: { kind: "warehouse" },
  toolbox: ["forward", "turn", "repeat", "repeat_until_dock", "if_sensor"],
  starter: [{ kind: "repeat", times: 7, body: [{ kind: "forward" }] }],
  referenceSolution: REFERENCE,
  cases: [
    { name: "Clear aisle", map: ["..#..#..", "........", ">......D", "...#..#."], battery: 40, visible: true, points: 1 },
    { name: "Rack on the aisle", map: ["......D", ">..#...", "......."], battery: 40, visible: true, points: 1 },
    { name: "HIDDEN_CASE_NORTH", map: ["^...D", ".#.#.", "....."], battery: 23, visible: false, points: 2 },
    {
      name: "HIDDEN_CASE_CORRIDOR",
      map: ["........", "..#..#..", "...#.#..", ">.##...D", "........"],
      battery: 61,
      visible: false,
      points: 3,
    },
  ],
  allOrNothing: false,
};

const HIDDEN_NAMES = ["HIDDEN_CASE_NORTH", "HIDDEN_CASE_CORRIDOR"];
/** The hidden maps' figures, by their size in drawing units (44 a cell, a unit of margin). */
const HIDDEN_FIGURES = ['viewBox="-1 -1 222 134"', 'viewBox="-1 -1 354 222"'];
/** A hidden battery, as a statement would print it in either language. */
const HIDDEN_BATTERY = /Batter(y|ie)\W{0,3}(23|61)\b/;
/** The reference's own line, in both languages: no line of the starter or the toolbox reads like it. */
const REFERENCE_LINES = ["if free ahead", "si libre devant"];
const SECRETS = [...HIDDEN_NAMES, ...HIDDEN_FIGURES, ...REFERENCE_LINES, "EXPLANATION_SECRET", "INTERNAL_NAME"];

let server: TestServer;
let teacher: { id: string; headers: Record<string, string> };
let student: { id: string; headers: Record<string, string> };

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
  student = await server.signIn("student");
});
afterAll(async () => {
  await server.close();
});

const get = (url: string, headers: Record<string, string>) => server.app.inject({ method: "GET", url, headers });
const post = (url: string, headers: Record<string, string>, payload?: Payload) =>
  server.app.inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload }) });
const url = (id: string, file: string) => `/app/api/evaluations/${id}/${file}`;

/** A document's Typst source, escapes undone. */
const typstOf = (tree: Document) => renderTypst(tree).source.replace(/\\(.)/g, "$1");

/** What a text holds of the key: the secrets it contains, and a hidden battery. */
const leaksIn = (text: string) => [...SECRETS.filter((s) => text.includes(s)), ...(HIDDEN_BATTERY.test(text) ? ["battery"] : [])];

/**
 * The tree's leaks: secrets and forbidden keys. A frame's `pattern` is its
 * ruling (ADR-126 §3), not a short answer's: the key search skips it.
 */
function treeLeaks(tree: Document): string[] {
  const blocks = tree.blocks.map((b): unknown => {
    if (b.kind !== "answerZone") return b;
    const { pattern: _ruling, ...zone } = b;
    return zone;
  });
  return [...findStudentLeaks(blocks, { forbiddenKeys: live.FORBIDDEN_STUDENT_KEYS }), ...leaksIn(JSON.stringify(tree))];
}

const drawings = (tree: Document) => tree.blocks.filter((b: Block) => b.kind === "drawing");

/** An evaluation of one published blocks question, `student` enrolled. */
async function series(mode: "exam" | "exercise") {
  const db = server.app.db;
  const seed = await seedLive(db, { teacherId: teacher.id, studentIds: [student.id], questions: 0, mode });
  const { id } = await poolService.createQuestion(db, { poolId: seed.poolId, type: "blocks", internalName: "INTERNAL_NAME_blocks", createdBy: teacher.id });
  const [question] = await db.select().from(questions).where(eq(questions.id, id));
  const saved = await poolService.putDraft(db, question!, { config: BLOCKS, explanation: "EXPLANATION_SECRET_blocks" });
  if (!saved.valid) throw new Error(`blocks is not publishable: ${JSON.stringify(saved.issues)}`);
  await poolService.publishQuestion(db, question!, { userId: teacher.id });
  await addItems(db, await reload(db, seed.evaluationId), [id], (type, version) =>
    typeOf(type).defaultPoints(poolService.exampleConfig(type, version)), { attemptCount: 0 });
  return seed;
}

describe("the hand-out of a blocks question (ADR-126 §8)", () => {
  it("prints, and builds a tree and a Typst source with the visible warehouses only, in both languages", async () => {
    const seed = await series("exam");
    const evaluation = await reload(server.app.db, seed.evaluationId);
    const found = await handout(server.app.db, evaluation, { now: server.clock.now() });
    for (const lang of ["en", "fr"] as const) {
      const tree = handoutTree(found, lang);
      expect(treeLeaks(tree)).toEqual([]);
      expect(drawings(tree)).toHaveLength(2);
      const source = typstOf(tree);
      expect(leaksIn(source)).toEqual([]);
      expect(source).toContain("BLOCKS_PROMPT");
      expect(source).toContain('pattern: "lines"');
      expect(source).toContain(lang === "fr" ? ">QUAI</text>" : ">DOCK</text>");
    }
  });

  it("serves its Markdown in the reader's language, no hidden warehouse in it", async () => {
    const seed = await series("exam");
    const res = await get(url(seed.evaluationId, "handout.md"), { ...teacher.headers, "accept-language": "fr-CH" });
    expect(res.statusCode).toBe(200);
    expect(leaksIn(res.body)).toEqual([]);
    for (const word of ["BLOCKS_PROMPT", "Clear aisle", "Rack on the aisle", "Entrepôts cachés", "répéter 7 fois"]) {
      expect(res.body).toContain(word);
    }
  });

  it("serves the statement with key: every warehouse with the reference's walk, and the reference", async () => {
    const seed = await series("exam");
    const res = await get(url(seed.evaluationId, "document.md"), teacher.headers);
    expect(res.statusCode).toBe(200);
    for (const secret of [...HIDDEN_NAMES, "if free ahead", "Battery: 23 · 2 pt · Hidden"]) expect(res.body).toContain(secret);
  });

  it.skipIf(!pdfTools)("prints the hand-out's PDF with no hidden warehouse, and the key's with all of them", async () => {
    const seed = await series("exam");
    const handoutPdf = await get(url(seed.evaluationId, "handout.pdf"), { ...teacher.headers, "accept-language": "fr-CH" });
    expect(handoutPdf.statusCode).toBe(200);
    const text = await pdfText(handoutPdf.rawPayload);
    // SVG text stays text in a PDF (ADR-126 §9): the dock's word of a figure is found.
    for (const word of ["BLOCKS_PROMPT", "Clear aisle", "QUAI", "Prénom"]) expect(text).toContain(word);
    expect(leaksIn(text)).toEqual([]);

    const keyPdf = await get(url(seed.evaluationId, "document.pdf"), teacher.headers);
    expect(keyPdf.statusCode).toBe(200);
    const key = await pdfText(keyPdf.rawPayload);    for (const secret of [...HIDDEN_NAMES, "if free ahead", "DOCK"]) expect(key).toContain(secret);
    expect(key).toMatch(HIDDEN_BATTERY);
  });
});

describe("the student's own documents of a blocks question", () => {
  it("keeps the hidden warehouses out of the blank print of a past series", async () => {
    const db = server.app.db;
    const seed = await series("exercise");
    const running = await applyState(db, await reload(db, seed.evaluationId), "running", server.clock.now());
    await live.closeEvaluation(db, running, server.clock.now());
    const found = await handout(db, await reload(db, seed.evaluationId), { now: server.clock.now() });
    for (const lang of ["en", "fr"] as const) {
      const tree = handoutTree(found, lang);
      expect(treeLeaks(tree)).toEqual([]);
      expect(leaksIn(typstOf(tree))).toEqual([]);
    }
    if (pdfTools) {
      const res = await get(`/app/api/student/evaluations/${seed.evaluationId}/handout.pdf`, student.headers);
      expect(res.statusCode).toBe(200);
      const text = await pdfText(res.rawPayload);
      expect(text).toContain("BLOCKS_PROMPT");
      expect(leaksIn(text)).toEqual([]);
    }
  });

  it("gives a released exam's copy the reference and the visible warehouses only, under a shown key", async () => {
    const db = server.app.db;
    const seed = await series("exam");
    await post(url(seed.evaluationId, "start"), teacher.headers, { confirm: true });
    const entered = await post(url(seed.evaluationId, "attempt/start"), student.headers, {});
    expect(entered.statusCode).toBe(200);
    const view = entered.json().view as { attempt: { id: string }; items: { id: string }[] };
    const attemptId = view.attempt.id;
    // The student's own program: it reaches no dock.
    const saved = await server.app.inject({
      method: "PUT",
      url: `/app/api/attempts/${attemptId}/answers/${view.items[0]!.id}`,
      headers: student.headers,
      payload: { payload: { program: [{ kind: "turn", dir: "left" }, { kind: "forward" }] }, revision: 1, clientTs: server.clock.now().toISOString() },
    });
    expect(saved.statusCode).toBe(200);
    await post(url(seed.evaluationId, "close"), teacher.headers, { confirm: true });
    expect((await post(url(seed.evaluationId, "release"), teacher.headers, { confirm: true })).statusCode).toBe(200);
    await db
      .update(evaluations)
      .set({ feedbackPolicy: FeedbackPolicy.parse({ showKey: true, showHiddenCaseNames: false }) })
      .where(eq(evaluations.id, seed.evaluationId));
    expect(await db.select().from(answers).where(eq(answers.attemptId, attemptId))).toHaveLength(1);

    const evaluation = await reload(db, seed.evaluationId);
    const { attempt } = (await findOwnAttempt(db, student.id, attemptId))!;
    const found = await studentCopyRecord(db, evaluation, attempt, { now: server.clock.now() });
    // The key's own words are shown: the reference is the student's to read.
    const shown = SECRETS.filter((s) => !REFERENCE_LINES.includes(s));
    for (const lang of ["en", "fr"] as const) {
      const tree = studentCopyDocument(found, lang);
      const source = typstOf(tree);
      expect(source).toContain(lang === "fr" ? "si libre devant" : "if free ahead");
      // Their own program, and the hidden warehouses' verdicts by number.
      expect(source).toContain(lang === "fr" ? "tourner à gauche" : "turn left");
      expect(source).toContain("#3");
      for (const form of [JSON.stringify(tree), source]) {
        expect(shown.filter((s) => form.includes(s))).toEqual([]);
        expect(HIDDEN_BATTERY.test(form)).toBe(false);
      }
      // The visible warehouses twice (the statement, the key), never a hidden one.
      expect(drawings(tree)).toHaveLength(4);
    }
    if (pdfTools) {
      const res = await get(`/app/api/attempts/${attemptId}/copy.pdf`, student.headers);
      expect(res.statusCode).toBe(200);
      const text = await pdfText(res.rawPayload);
      expect(text).toContain("if free ahead");
      expect(shown.filter((s) => text.includes(s))).toEqual([]);
      expect(HIDDEN_BATTERY.test(text)).toBe(false);
    }
  });
});
