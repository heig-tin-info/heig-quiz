/**
 * An evaluation's two documents (ADR-121 step 3, ADR-125), over the real
 * application: the staff "statement with key" and the hand-out, as Markdown
 * as PDFs and as their records; the hand-out searched for every secret of
 * its questions (invariant 4, 05 §5.7) and for the paper seed, which it
 * follows and never shows (ADR-125 §8), in its three forms (§19); the
 * refusals of an evaluation that does not print (§5); and who reaches them
 * (invariant 6).
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EvaluationDetail, EvaluationDocumentRecord, HandoutRecord } from "@quiz/contracts";
import { findStudentLeaks } from "@quiz/core/testing";
import { splitFrontMatter } from "@quiz/docrender/frontMatter";

import { evaluations, questions } from "../../db/schema.js";
import { sessionOf, type TestServer, testServer } from "../../test/http.js";
import { reload, seedLive } from "../../test/live.js";
import { publishParameterized } from "../../test/parameterized.js";
import { pdfText, pdfTools } from "../../test/pdf.js";
import * as live from "../live/service.js";
import { typeOf } from "../pool/config.js";
import * as poolService from "../pool/service.js";
import { handout, handoutTree } from "./document.js";
import { addItems, joinedItems, settingsOf } from "./service.js";

/** One question of each printable type, every secret a marker the search finds. */
const QUESTIONS = {
  mcq: {
    configVersion: 2,
    prompt: "Pick MCQ_PROMPT.",
    mode: "single",
    shuffleChoices: true,
    // The editor's default: the key first, which the base order would print at A.
    choices: [
      { text: "MCQ_KEY_CHOICE", correct: true },
      { text: "MCQ_OTHER_ONE", correct: false },
      { text: "MCQ_OTHER_TWO", correct: false },
      { text: "MCQ_OTHER_THREE", correct: false },
    ],
  },
  short: {
    configVersion: 3,
    prompt: "Name SHORT_PROMPT.",
    kind: "text",
    matchers: [{ kind: "exact", value: "SHORT_KEY_SECRET" }],
  },
  cloze: { configVersion: 2, text: "CLOZE_PROMPT {{CLOZE_KEY_SECRET}} end." },
  rich: {
    configVersion: 2,
    prompt: "Explain RICH_PROMPT.",
    rubric: "- 2 pts: RICH_RUBRIC_SECRET",
    reference: "RICH_REFERENCE_SECRET",
    maxChars: 3000,
    format: "markdown",
  },
  math: {
    configVersion: 1,
    prompt: "Expand MATH_PROMPT.",
    symbols: [{ name: "x", min: 1, max: 10 }],
    answers: [{ value: "x^3+11x", points: 1 }],
  },
} as const;

const explanationOf = (type: string) => `EXPLANATION_SECRET_${type}`;
const nameOf = (type: string) => `INTERNAL_NAME_${type}`;

/** Everything of the questions above a student must never read. */
const SECRETS = [
  "SHORT_KEY_SECRET",
  "CLOZE_KEY_SECRET",
  "RICH_RUBRIC_SECRET",
  "RICH_REFERENCE_SECRET",
  "x^3+11x",
  "EXPLANATION_SECRET",
  "INTERNAL_NAME",
];

let server: TestServer;
let teacher: { id: string; headers: Record<string, string> };
let other: { id: string; headers: Record<string, string> };
let student: { id: string; headers: Record<string, string> };
let admin: { id: string; headers: Record<string, string> };

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
  other = await server.signIn("teacher");
  student = await server.signIn("student");
  admin = await server.signIn("admin");
});
afterAll(async () => {
  await server.close();
});

const get = (url: string, headers: Record<string, string>) => server.app.inject({ method: "GET", url, headers });
const url = (id: string, file: string) => `/app/api/evaluations/${id}/${file}`;

/** A published question of `type`, with its explanation. */
async function publish(poolId: string, type: string, config: unknown): Promise<string> {
  const db = server.app.db;
  const { id } = await poolService.createQuestion(db, {
    poolId,
    type,
    internalName: nameOf(type),
    createdBy: teacher.id,
  });
  const [question] = await db.select().from(questions).where(eq(questions.id, id));
  const saved = await poolService.putDraft(db, question!, { config, explanation: explanationOf(type) });
  if (!saved.valid) throw new Error(`${type} is not publishable: ${JSON.stringify(saved.issues)}`);
  await poolService.publishQuestion(db, question!, { userId: teacher.id });
  return id;
}

/** An exam of the printable types (plus `extra`), items and choices shuffled. */
async function exam(extra: (poolId: string) => Promise<string[]> = async () => []) {
  const db = server.app.db;
  const seed = await seedLive(db, {
    teacherId: teacher.id,
    studentIds: [student.id],
    questions: 0,
    settings: { shuffleItems: true, shuffleChoices: true },
  });
  const ids = [];
  for (const [type, config] of Object.entries(QUESTIONS)) ids.push(await publish(seed.poolId, type, config));
  ids.push(...(await extra(seed.poolId)));
  await addItems(db, await reload(db, seed.evaluationId), ids, (type, version) =>
    typeOf(type).defaultPoints(poolService.exampleConfig(type, version)), { attemptCount: 0 });
  return reload(db, seed.evaluationId);
}

/** The stored paper seed, read behind the API's back. */
const storedSeed = async (id: string) => (await reload(server.app.db, id)).paperSeed;

/** Whether `text` shows `seed` as a number of its own (never a digit run inside an id). */
const showsSeed = (text: string, seed: number) => new RegExp(`(?<![\\w-])${seed}(?![\\w])`).test(text);

describe("the statement with key (F-EXP-04)", () => {
  it("serves every item in the base order with its key and explanation, in English", async () => {
    const evaluation = await exam();
    const res = await get(url(evaluation.id, "document.md"), teacher.headers);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="[a-z0-9-]+-key\.md"$/);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { frontMatter, body } = splitFrontMatter(res.body);
    expect(frontMatter).toMatchObject({
      export: { kind: "evaluation-document", format: "md", version: 1 },
      source: { evaluationId: evaluation.id },
      attempts: [],
    });
    for (const marker of ["SHORT_KEY_SECRET", "CLOZE_KEY_SECRET", "x^3+11x", "EXPLANATION_SECRET_mcq", nameOf("rich")]) {
      expect(body).toContain(marker);
    }
    // The base order: the editor's order, the key where it was written.
    const positions = [...body.matchAll(/^## Question (\d+): INTERNAL_NAME_(\w+)/gm)].map((m) => [m[1], m[2]]);
    expect(positions).toEqual(Object.keys(QUESTIONS).map((type, i) => [String(i + 1), type]));
    expect(body).toContain("### Reference solution\n\n**A.** MCQ_KEY_CHOICE");
    // The paper seed is the hand-out's: the staff document never draws it.
    expect(await storedSeed(evaluation.id)).toBeNull();
  });

  it("serves the same as a record", async () => {
    const evaluation = await exam();
    const res = await get(url(evaluation.id, "document.json"), teacher.headers);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/-key\.json"$/);
    const record = EvaluationDocumentRecord.parse(res.json());
    expect(record.items.map((i) => i.type)).toEqual(Object.keys(QUESTIONS));
    expect(record.items.map((i) => i.explanation)).toEqual(Object.keys(QUESTIONS).map(explanationOf));
    expect(record.items[0]!.internalName).toBe(nameOf("mcq"));
  });
});

describe("the hand-out (ADR-125)", () => {
  it("holds the statements and the answer zones, and no secret, in the reader's language", async () => {
    const evaluation = await exam();
    // The seed is drawn by the first print, never before.
    expect(await storedSeed(evaluation.id)).toBeNull();
    const res = await get(url(evaluation.id, "handout.md"), { ...teacher.headers, "accept-language": "fr-CH" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="[a-z0-9-]+-handout\.md"$/);
    const text = res.body;
    for (const prompt of ["MCQ_PROMPT", "SHORT_PROMPT", "CLOZE_PROMPT", "RICH_PROMPT", "MATH_PROMPT"]) {
      expect(text).toContain(prompt);
    }
    // The name frame first, then the questions, numbered on the paper, worded in French.
    expect(splitFrontMatter(text).body.startsWith("Nom")).toBe(true);
    expect(text).toContain("## Question 1 (");
    expect(findStudentLeaks(text, { secrets: SECRETS })).toEqual([]);
    // The front matter names the evaluation and no seed.
    const seed = (await storedSeed(evaluation.id))!;
    expect(seed).not.toBeNull();
    expect(showsSeed(text, seed)).toBe(false);
    expect(text).not.toMatch(/seed/i);
    // A reprint keeps it, and the detail never carries it.
    await get(url(evaluation.id, "handout.json"), teacher.headers);
    expect(await storedSeed(evaluation.id)).toBe(seed);
    const detail = await get(`/app/api/evaluations/${evaluation.id}`, teacher.headers);
    expect(detail.body).not.toMatch(/paperSeed|paper_seed/);
    expect(showsSeed(detail.body, seed)).toBe(false);
  });

  it("builds a document tree with no secret, the third form searched (ADR-125 §19)", async () => {
    const evaluation = await exam();
    const found = await handout(server.app.db, evaluation, { now: server.clock.now() });
    for (const lang of ["en", "fr"] as const) {
      const tree = handoutTree(found, lang);
      expect(findStudentLeaks(tree, { forbiddenKeys: live.FORBIDDEN_STUDENT_KEYS, secrets: SECRETS })).toEqual([]);
      expect(showsSeed(JSON.stringify(tree), (await storedSeed(evaluation.id))!)).toBe(false);
    }
  });

  it("serves the student views as a record, through the one exit", async () => {
    const evaluation = await exam();
    const res = await get(url(evaluation.id, "handout.json"), teacher.headers);
    expect(res.statusCode).toBe(200);
    const record = HandoutRecord.parse(res.json());
    expect(record.items).toHaveLength(5);
    // A printable evaluation offers both on its detail.
    const detail = EvaluationDetail.parse((await get(`/app/api/evaluations/${evaluation.id}`, teacher.headers)).json());
    expect(detail.exports).toEqual({ document: null, handout: null, paper: "paper_not_started" });
    expect(findStudentLeaks(record, { forbiddenKeys: live.FORBIDDEN_STUDENT_KEYS, secrets: SECRETS })).toEqual([]);
    expect(showsSeed(res.body, (await storedSeed(evaluation.id))!)).toBe(false);
  });

  it("follows the paper seed: drawn once, the order and shuffles of a digital attempt of that seed", async () => {
    const db = server.app.db;
    const evaluation = await exam();
    const items = await joinedItems(db, evaluation.id);
    const base = items.map((i) => i.item.id);
    // A seed whose order is not the base order, set before the first print.
    let seed = 1;
    while (live.orderItems(items, settingsOf(evaluation), seed, evaluation.id).every((o, i) => o.item.id === base[i])) {
      seed += 1;
    }
    await db.update(evaluations).set({ paperSeed: seed }).where(eq(evaluations.id, evaluation.id));

    const first = HandoutRecord.parse((await get(url(evaluation.id, "handout.json"), teacher.headers)).json());
    const second = HandoutRecord.parse((await get(url(evaluation.id, "handout.json"), teacher.headers)).json());
    const order = first.items.map((i) => i.id);
    expect(order).not.toEqual(base);
    expect(second.items).toEqual(first.items);
    expect(await storedSeed(evaluation.id)).toBe(seed);
    // Exactly what a digital attempt of the same seed is served, choices included (ADR-097).
    const attempt = await live.previewView(db, await reload(db, evaluation.id), server.clock.now(), seed);
    expect(first.items.map((i) => [i.id, i.statement])).toEqual(attempt.items.map((i) => [i.id, i.student]));
  });

  it("keeps one seed when two first prints race", async () => {
    const evaluation = await exam();
    const [a, b] = await Promise.all([
      get(url(evaluation.id, "handout.json"), teacher.headers),
      get(url(evaluation.id, "handout.json"), teacher.headers),
    ]);
    expect(await storedSeed(evaluation.id)).toEqual(expect.any(Number));
    expect(HandoutRecord.parse(a.json()).items).toEqual(HandoutRecord.parse(b.json()).items);
  });
});

describe("an evaluation that does not print (ADR-125 §5)", () => {
  it("refuses both documents with a parameterized item, and says so in the detail", async () => {
    const evaluation = await exam((poolId) =>
      publishParameterized(server.app.db, { poolId, teacherId: teacher.id, type: "mcq" }).then((id) => [id]),
    );
    for (const file of ["document.md", "document.json", "document.pdf", "handout.md", "handout.json", "handout.pdf"]) {
      const res = await get(url(evaluation.id, file), teacher.headers);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "not_printable", reason: "parameterized", types: [] });
    }
    const detail = EvaluationDetail.parse((await get(`/app/api/evaluations/${evaluation.id}`, teacher.headers)).json());
    expect(detail.exports).toEqual({
      document: { reason: "parameterized", types: [] },
      handout: { reason: "parameterized", types: [] },
      paper: "paper_not_started",
    });
    expect(await storedSeed(evaluation.id)).toBeNull();
  });

  it("refuses the hand-out for a type with no paper form, and serves the statement with key", async () => {
    const code = {
      configVersion: 1,
      prompt: "Return CODE_PROMPT.",
      language: "c",
      runtime: "backend",
      template: "int main(void) { return 0; }\n",
      referenceSolution: "int main(void) { return 1; }",
      tests: { mode: "io", cases: [{ name: "one", stdin: "", expected: "", visible: true, points: 1 }] },
    };
    const evaluation = await exam(async (poolId) => [await publish(poolId, "code", code)]);
    for (const file of ["handout.md", "handout.json", "handout.pdf"]) {
      const res = await get(url(evaluation.id, file), teacher.headers);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "not_printable", reason: "type", types: ["code"] });
    }
    const document = await get(url(evaluation.id, "document.md"), teacher.headers);
    expect(document.statusCode).toBe(200);
    expect(document.body).toContain("CODE_PROMPT");
    const detail = EvaluationDetail.parse((await get(`/app/api/evaluations/${evaluation.id}`, teacher.headers)).json());
    expect(detail.exports).toEqual({ document: null, handout: { reason: "type", types: ["code"] }, paper: "paper_not_started" });
  });

  it("refuses a poll both, whatever its questions", async () => {
    const evaluation = await exam();
    await server.app.db.update(evaluations).set({ mode: "poll" }).where(eq(evaluations.id, evaluation.id));
    for (const file of ["document.md", "handout.json"]) {
      const res = await get(url(evaluation.id, file), teacher.headers);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "not_printable", reason: "poll", types: [] });
    }
  });
});

describe("who reaches them (invariant 6)", () => {
  const FILES = ["document.md", "document.json", "document.pdf", "handout.md", "handout.json", "handout.pdf"];

  it("is the 404 of a missing evaluation for a stranger, and for an unknown id", async () => {
    const evaluation = await exam();
    for (const file of FILES) {
      expect((await get(url(evaluation.id, file), other.headers)).statusCode).toBe(404);
      expect((await get(url(randomUUID(), file), teacher.headers)).statusCode).toBe(404);
    }
    // A stranger's 404 draws no seed.
    expect(await storedSeed(evaluation.id)).toBeNull();
  });

  it("refuses a student, an impersonation and an exam's confined session as the detail does", async () => {
    const evaluation = await exam();
    const sessions = [
      student.headers,
      await sessionOf(server.app.db, student.id, { kind: "impersonation", actorUserId: admin.id }),
      await sessionOf(server.app.db, teacher.id, { kind: "seb", evaluationId: evaluation.id }),
    ];
    for (const headers of sessions) {
      const detail = await get(`/app/api/evaluations/${evaluation.id}`, headers);
      expect(detail.statusCode).not.toBe(200);
      for (const file of FILES) {
        const res = await get(url(evaluation.id, file), headers);
        expect(res.statusCode).toBe(detail.statusCode);
        expect(res.body).not.toContain("PROMPT");
      }
    }
    expect(await storedSeed(evaluation.id)).toBeNull();
  });
});

/*
 * The same documents as PDFs (ADR-125 §3, §19), through the tools of
 * `test/pdf.ts`. A server without Typst answers 503 through the one
 * `sendExport`, proven by the answers export (`itemAnswers.db.test.ts`).
 */
describe("the documents as PDFs (ADR-125)", () => {
  it.skipIf(!pdfTools)("serves the statement with key as a PDF, named like the Markdown", async () => {
    const evaluation = await exam();
    const res = await get(url(evaluation.id, "document.pdf"), teacher.headers);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="[a-z0-9-]+-key\.pdf"$/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.rawPayload.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // Every secret the hand-out's PDF is searched for reads as itself in a PDF's
    // text: else the search below would find nothing for the wrong reason.
    const text = await pdfText(res.rawPayload);
    for (const secret of SECRETS) expect(text).toContain(secret);
  });

  /*
   * The third form of the leak search (05 §5.7, ADR-125 §19): beside the
   * tree and the rendered source above, the text of the PDF itself, as a
   * printer receives it — no secret of the questions, no paper seed.
   */
  it.skipIf(!pdfTools)("serves the hand-out as a PDF whose text holds no secret and no seed, in the reader's language", async () => {
    const evaluation = await exam();
    const res = await get(url(evaluation.id, "handout.pdf"), { ...teacher.headers, "accept-language": "fr-CH" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="[a-z0-9-]+-handout\.pdf"$/);
    const text = await pdfText(res.rawPayload);
    for (const prompt of ["MCQ_PROMPT", "SHORT_PROMPT", "CLOZE_PROMPT", "RICH_PROMPT", "MATH_PROMPT"]) {
      expect(text).toContain(prompt);
    }
    // Worded in the reader's language: the name frame's French words.
    expect(text).toContain("Nom");
    expect(text).toContain("Prénom");
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(showsSeed(text, (await storedSeed(evaluation.id))!)).toBe(false);
  });
});
