/**
 * An evaluation's two documents (ADR-121 step 3, ADR-125), over the real
 * application: the staff "statement with key" and the hand-out, as Markdown
 * as PDFs and as their records; the hand-out searched for every secret of
 * its questions (invariant 4, 05 §5.7) and for its variant's seed, which it
 * follows and never shows (ADR-125 §8, ADR-147), in its three forms (§19);
 * a parameterized evaluation on paper — one variant's values on the
 * hand-out and its key, stored, kept across prints and edits, and no
 * template anywhere (ADR-147, ADR-056 §4); the refusals of an evaluation
 * that does not print (§5); and who reaches them (invariant 6).
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EvaluationDetail, EvaluationDocumentRecord, HandoutRecord } from "@quiz/contracts";
import { findStudentLeaks } from "@quiz/core/testing";
import { markdownBody } from "@quiz/docexport/markdown";
import { renderTypst } from "@quiz/docexport/typst";
import { splitFrontMatter } from "@quiz/docrender/frontMatter";
import { LOCALES } from "@quiz/domain";

import { evaluationItems, evaluations, paperVariants, questions } from "../../db/schema.js";
import { sessionOf, type TestServer, testServer } from "../../test/http.js";
import { reload, seedLive } from "../../test/live.js";
import { fallOf, legibleSeed, markersIn, publishParameterized, showsKey, VARIABLES } from "../../test/parameterized.js";
import { pdfText, pdfTools } from "../../test/pdf.js";
import * as live from "../live/service.js";
import { typeOf } from "../pool/config.js";
import * as poolService from "../pool/service.js";
import { handout, handoutTree } from "./document.js";
import { addItems, joinedItems, latestPublished, patchItem, settingsOf, updateVersions } from "./service.js";

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

/**
 * A Markdown export without the two random hex strings of its front matter,
 * the evaluation's id and the body's digest: a short all-digit secret turns
 * up in them by chance (about one run in 900 for four digits), and that is
 * not a leak. Everything else of the front matter is still searched.
 */
const withoutRandomHex = (markdown: string) => markdown.replace(/^(\s*(?:evaluationId|sha256)):.*$/gm, "$1:");

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

/** Variant 1 of the paper (ADR-147), read behind the API's back; null before the first print. */
const storedVariant = async (id: string) =>
  (await server.app.db.select().from(paperVariants).where(eq(paperVariants.evaluationId, id)))[0] ?? null;
/** Its seed. */
const storedSeed = async (id: string) => (await storedVariant(id))?.seed ?? null;
/** A seed an older server stored on the evaluation, which variant 1 takes when it is created. */
const olderSeed = (id: string, seed: number) =>
  server.app.db.update(evaluations).set({ paperSeed: seed }).where(eq(evaluations.id, id));

/** Whether `text` shows `seed` as a number of its own (never a digit run inside an id). */
const showsSeed = (text: string, seed: number) => new RegExp(`(?<![\\w-])${seed}(?![\\w])`).test(text);

describe("the statement with key (F-EXP-04)", () => {
  it("is the key of the paper's variant: the hand-out's order, its key and explanation, in the reader's language", async () => {
    const evaluation = await exam();
    const res = await get(url(evaluation.id, "document.md"), teacher.headers);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="[a-z0-9-]+-key\.md"$/);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { frontMatter, body } = splitFrontMatter(res.body);
    expect(frontMatter).toMatchObject({
      export: { kind: "evaluation-document", format: "md", version: 2 },
      source: { evaluationId: evaluation.id },
      attempts: [],
    });
    for (const marker of ["SHORT_KEY_SECRET", "CLOZE_KEY_SECRET", "x^3+11x", "EXPLANATION_SECRET_mcq", nameOf("rich")]) {
      expect(body).toContain(marker);
    }
    // The paper's order (ADR-147), numbered as the hand-out numbers it: the variant drawn by the key.
    const seed = await storedSeed(evaluation.id);
    expect(seed).toEqual(expect.any(Number));
    const handout = HandoutRecord.parse((await get(url(evaluation.id, "handout.json"), teacher.headers)).json());
    const numbered = [...body.matchAll(/^## Question (\d+): INTERNAL_NAME_(\w+) \(\d+ pt\)$/gm)].map((m) => [m[1], m[2]]);
    expect(numbered).toEqual(handout.items.map((item, rank) => [String(rank + 1), item.type]));
    expect(await storedSeed(evaluation.id)).toBe(seed);
    // Every choice listed in the paper's order, the right one ticked; no rule between the questions.
    expect(body).toMatch(/^### Answer key\n\n(- \[[ x]\] \*\*[A-D]\.\*\* MCQ_\w+\n){4}/m);
    expect(body.match(/- \[x\] \*\*[A-D]\.\*\* (\w+)/)?.[1]).toBe("MCQ_KEY_CHOICE");
    expect(body.match(/- \[x\]/g)).toHaveLength(1);
    expect(body).not.toMatch(/^---$/m);
  });

  it("words the key in French for a French teacher (ADR-121 §4, amended 2026-11-04)", async () => {
    const evaluation = await exam();
    const res = await get(url(evaluation.id, "document.md"), { ...teacher.headers, "accept-language": "fr-CH" });
    expect(res.statusCode).toBe(200);
    const { body } = splitFrontMatter(res.body);
    expect(body).toMatch(/^## Question 1 : INTERNAL_NAME_\w+ \(\d+ pt\)$/m);
    for (const heading of ["### Énoncé", "### Corrigé", "### Explication"]) expect(body).toContain(heading);
    expect(body).not.toMatch(/Statement|Answer key|Explanation/);
  });

  it("indents its record, which still parses", async () => {
    const evaluation = await exam();
    const res = await get(url(evaluation.id, "document.json"), teacher.headers);
    expect(res.body.startsWith('{\n  "kind": "evaluation-document"')).toBe(true);
    expect(EvaluationDocumentRecord.safeParse(JSON.parse(res.body)).success).toBe(true);
  });

  it("serves the same as a record, in the paper's order, each item keeping its canonical place", async () => {
    const evaluation = await exam();
    const res = await get(url(evaluation.id, "document.json"), teacher.headers);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/-key\.json"$/);
    const record = EvaluationDocumentRecord.parse(res.json());
    const handout = HandoutRecord.parse((await get(url(evaluation.id, "handout.json"), teacher.headers)).json());
    expect(record.items.map((i) => [i.id, i.position, i.statement])).toEqual(handout.items.map((i) => [i.id, i.position, i.statement]));
    expect(record.items.map((i) => i.explanation)).toEqual(record.items.map((i) => explanationOf(i.type)));
    expect(record.items.map((i) => i.internalName)).toEqual(record.items.map((i) => nameOf(i.type)));
    expect(record.version).toBe(2);
    expect(res.body).not.toMatch(/seed/i);
    expect(showsSeed(res.body, (await storedSeed(evaluation.id))!)).toBe(false);
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
    expect(text).toMatch(/^## Question 1 \(\d+ pt\)$/m);
    // The choice question is its own zone: a task list of empty boxes, none ticked.
    expect(text).toMatch(/^- \[ \] \*\*A\.\*\* MCQ_/m);
    expect(text).not.toContain("- [x]");
    expect(findStudentLeaks(withoutRandomHex(text), { secrets: SECRETS })).toEqual([]);
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
    for (const lang of LOCALES) {
      const tree = handoutTree(found, lang);
      expect(findStudentLeaks(tree, { forbiddenKeys: live.FORBIDDEN_STUDENT_KEYS, secrets: SECRETS })).toEqual([]);
      // No box ticked on a hand-out: in the tree, its Markdown and its Typst source (invariant 4).
      const boxes = tree.blocks.filter((b) => b.kind === "choices");
      expect(boxes).toHaveLength(1);
      for (const block of boxes) expect(block.checked).toEqual([]);
      expect(markdownBody(tree)).not.toContain("[x]");
      expect(renderTypst(tree).source).not.toContain("-ticked]");
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
    // A seed whose order is not the base order, set before the first print by
    // an older server (`paper_seed`): variant 1 takes it (ADR-147).
    let seed = 1;
    while (live.orderItems(items, settingsOf(evaluation), seed, evaluation.id).every((o, i) => o.item.id === base[i])) {
      seed += 1;
    }
    await olderSeed(evaluation.id, seed);

    const first = HandoutRecord.parse((await get(url(evaluation.id, "handout.json"), teacher.headers)).json());
    const second = HandoutRecord.parse((await get(url(evaluation.id, "handout.json"), teacher.headers)).json());
    const order = first.items.map((i) => i.id);
    expect(order).not.toEqual(base);
    expect(second.items).toEqual(first.items);
    expect(await storedSeed(evaluation.id)).toBe(seed);
    // Exactly what a digital attempt of the same seed is served, choices included (ADR-097).
    const attempt = await live.previewView(db, await reload(db, evaluation.id), server.clock.now(), { seed, instances: {} });
    expect(first.items.map((i) => [i.id, i.statement])).toEqual(attempt.items.map((i) => [i.id, i.student]));
  });

  it("prints a section's text once, at the head of its section in the paper's order (ADR-143)", async () => {
    const db = server.app.db;
    const evaluation = await exam();
    const items = await joinedItems(db, evaluation.id);
    const section = "SECTION_TEXT_143";
    // The section opens on the second item: the first stays a leading item.
    await patchItem(db, evaluation, items[1]!.item.id, { intro: section, introScope: "following" }, { attemptCount: 0 });
    const head = items[1]!.item.id;
    // A seed under which the section's first item is not the one carrying its text.
    let seed = 1;
    const sectioned = await joinedItems(db, evaluation.id);
    while (live.orderItems(sectioned, settingsOf(evaluation), seed, evaluation.id)[1]!.item.id === head) seed += 1;
    await olderSeed(evaluation.id, seed);

    const record = HandoutRecord.parse((await get(url(evaluation.id, "handout.json"), teacher.headers)).json());
    expect(record.items[0]!.id).toBe(items[0]!.item.id);
    expect(record.items.map((i) => i.sectionIntro)).toEqual([null, section, null, null, null]);
    expect(record.items.map((i) => i.intro)).toEqual([null, null, null, null, null]);
    const text = (await get(url(evaluation.id, "handout.md"), teacher.headers)).body;
    expect(text.split(section)).toHaveLength(2);
    expect(text.indexOf(section)).toBeGreaterThan(text.search(/^## Question 1 /m));
    expect(text.indexOf(section)).toBeLessThan(text.search(/^## Question 2 /m));
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

/*
 * A parameterized evaluation on paper (ADR-147): one variant's values,
 * drawn from its seed, stored, shared by the hand-out and the key, kept or
 * drawn again by the keep rule of each side of the opening; and no
 * template in any form of the hand-out (ADR-056 §4; 05 §5.7; ADR-125 §19),
 * no drawn key, nor the variant's seed, version ids or values map.
 */
describe("a parameterized evaluation on paper (ADR-147)", () => {
  /** An exam of the printable static types and one parameterized question of each v1 type. */
  const parameterizedExam = () =>
    exam(async (poolId) => {
      const ids = [];
      for (const type of ["mcq", "short", "cloze"] as const) {
        ids.push(await publishParameterized(server.app.db, { poolId, teacherId: teacher.id, type, name: `PARAM_${type}` }));
      }
      return ids;
    });
  const parameterizedItems = async (id: string) =>
    (await joinedItems(server.app.db, id)).filter((j) => j.version.variables !== null);

  it("prints a hand-out and a key whose values agree, stored once and stable across prints", async () => {
    const db = server.app.db;
    const evaluation = await parameterizedExam();
    const detail = EvaluationDetail.parse((await get(`/app/api/evaluations/${evaluation.id}`, teacher.headers)).json());
    expect(detail.exports).toEqual({ document: null, handout: null, paper: "paper_not_started" });

    const first = HandoutRecord.parse((await get(url(evaluation.id, "handout.json"), teacher.headers)).json());
    const stored = (await storedVariant(evaluation.id))!;
    // Written back for a rolled-back image, which prints from `paper_seed` (ADR-147 §2).
    expect((await reload(db, evaluation.id)).paperSeed).toBe(stored.seed);
    const ids = (await parameterizedItems(evaluation.id)).map((j) => j.item.id);
    expect(Object.keys(stored.instances).sort()).toEqual([...ids].sort());
    server.clock.advance(60_000);
    const key = EvaluationDocumentRecord.parse((await get(url(evaluation.id, "document.json"), teacher.headers)).json());
    const second = HandoutRecord.parse((await get(url(evaluation.id, "handout.json"), teacher.headers)).json());
    expect(second.items).toEqual(first.items);
    // Nothing to draw: nothing written.
    expect(await storedVariant(evaluation.id)).toEqual(stored);
    // The key is the paper's: the same statements, in the same order, with the same values.
    expect(key.items.map((i) => [i.id, i.statement])).toEqual(first.items.map((i) => [i.id, i.statement]));
    for (const id of ids) {
      const values = stored.instances[id]!.values;
      const keyItem = key.items.find((i) => i.id === id)!;
      // The key: the number itself, or for an mcq the choice its position names.
      const choices = (keyItem.statement as { choices?: { text: string }[] }).choices;
      const keyText = choices
        ? JSON.stringify((keyItem.solution as { correct: number[] }).correct.map((at) => choices[at]!.text))
        : JSON.stringify(keyItem.solution);
      expect(showsKey(keyText, values)).toBe(true);
      expect(keyItem.explanation).toBe(`The fall lasts ${fallOf(values)} s.`);
    }
  });

  it("holds no template, no drawn key, no seed, no version id and no values map in any form of the hand-out", async () => {
    const evaluation = await parameterizedExam();
    const keys = await legibleSeed(server.app.db, evaluation.id, server.clock.now());
    const res = await get(url(evaluation.id, "handout.json"), teacher.headers);
    const record = HandoutRecord.parse(res.json());
    const items = await joinedItems(server.app.db, evaluation.id);
    const { seed, instances } = (await storedVariant(evaluation.id))!;
    expect(Object.keys(instances)).toHaveLength(3);
    // The keys searched are the variant's own.
    const stored = (await parameterizedItems(evaluation.id)).filter((j) => j.question.type !== "mcq").map((j) => instances[j.item.id]!.values);
    expect(stored).toEqual(keys);
    const forbidden = [...live.FORBIDDEN_STUDENT_KEYS, "versionId", "instances", "variables", "fallback", "condition"];
    expect(findStudentLeaks(record, { forbiddenKeys: forbidden, secrets: SECRETS })).toEqual([]);
    const markdownExport = (await get(url(evaluation.id, "handout.md"), teacher.headers)).body;
    const found = await handout(server.app.db, evaluation, { now: server.clock.now() });
    const forms = [res.body, withoutRandomHex(markdownExport)];
    for (const lang of LOCALES) {
      const tree = handoutTree(found, lang);
      expect(findStudentLeaks(tree, { forbiddenKeys: forbidden, secrets: SECRETS })).toEqual([]);
      forms.push(JSON.stringify(tree), markdownBody(tree), renderTypst(tree).source);
    }
    for (const text of forms) {
      expect(markersIn(text)).toEqual([]);
      expect(text).not.toContain("The fall lasts");
      for (const values of keys) expect(showsKey(text, values)).toBe(false);
      expect(showsSeed(text, seed)).toBe(false);
      for (const entry of items) expect(text).not.toContain(entry.version.id);
      // The values map: no variable name as a key of its own.
      for (const row of VARIABLES.rows) expect(text).not.toContain(`"${row.name}":`);
    }
  });

  it.skipIf(!pdfTools)("prints the hand-out as a PDF whose text holds no template and no drawn key", async () => {
    const evaluation = await parameterizedExam();
    const keys = await legibleSeed(server.app.db, evaluation.id, server.clock.now());
    const res = await get(url(evaluation.id, "handout.pdf"), teacher.headers);
    expect(res.statusCode).toBe(200);
    const text = await pdfText(res.rawPayload);
    expect(text).toContain("A ball is dropped from");
    expect(markersIn(text)).toEqual([]);
    for (const values of keys) expect(showsKey(text, values)).toBe(false);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(showsSeed(text, (await storedSeed(evaluation.id))!)).toBe(false);
  });

  /** The short's question published again: other names (`height`), or the same names on a corrected range. */
  async function republishShort(evaluationId: string, rename: boolean) {
    const db = server.app.db;
    const short = (await joinedItems(db, evaluationId)).find((j) => j.question.internalName === "PARAM_short")!;
    const h = rename ? "height" : "h";
    const [question] = await db.select().from(questions).where(eq(questions.id, short.question.id));
    const saved = await poolService.putDraft(db, question!, {
      config: {
        configVersion: 3,
        prompt: `A ball is dropped from [[${h}]] m where g = [[g]] m/s². How many seconds does it fall?`,
        kind: "number",
        matchers: [{ kind: "number", value: "[[t]]", tolerance: "[[t/100]]" }],
      },
      explanation: "The fall lasts [[t]] s.",
      variables: {
        rows: [
          { name: h, expr: "randint(200, 300)", format: "int" },
          { name: "g", expr: "choice([3.71, 9.81, 24.79])", format: ".2" },
          { name: "t", expr: `sqrt(2*${h}/g)`, format: ".2" },
        ],
        condition: "t > 1.5",
      },
    });
    expect(saved.valid).toBe(true);
    await poolService.publishQuestion(db, question!, { userId: teacher.id });
    const latest = (await latestPublished(db, [short.question.id])).get(short.question.id)!;
    return { short, latest };
  }

  it("before the opening, draws again an item edited or added, keeping every other item's values", async () => {
    const db = server.app.db;
    const evaluation = await parameterizedExam();
    expect((await get(url(evaluation.id, "handout.json"), teacher.headers)).statusCode).toBe(200);
    const before = (await storedVariant(evaluation.id))!.instances;

    // The short corrected, same names, and the item moved onto it: drawn again, never replayed.
    const { short, latest } = await republishShort(evaluation.id, false);
    await updateVersions(db, await reload(db, evaluation.id), [short.item.id], { attemptCount: 0 });
    // One more parameterized question added.
    const added = await publishParameterized(db, { poolId: short.question.poolId!, teacherId: teacher.id, type: "mcq", name: "PARAM_added" });
    await addItems(db, await reload(db, evaluation.id), [added], (type, version) =>
      typeOf(type).defaultPoints(poolService.exampleConfig(type, version)), { attemptCount: 0 });

    const res = await get(url(evaluation.id, "handout.json"), teacher.headers);
    expect(res.statusCode, res.body).toBe(200);
    const after = (await storedVariant(evaluation.id))!.instances;
    const addedItem = (await joinedItems(db, evaluation.id)).find((j) => j.question.internalName === "PARAM_added")!;
    expect(Object.keys(after).sort()).toEqual([...Object.keys(before), addedItem.item.id].sort());
    for (const [id, kept] of Object.entries(before)) if (id !== short.item.id) expect(after[id]).toEqual(kept);
    // Drawn for the corrected version, in its corrected range.
    expect(after[short.item.id]).toMatchObject({ versionId: latest.id });
    expect(after[short.item.id]!.values["h"]).toBeGreaterThanOrEqual(200);

    // Renamed variables, before the opening: drawn again too, no error.
    const renamed = await republishShort(evaluation.id, true);
    await updateVersions(db, await reload(db, evaluation.id), [short.item.id], { attemptCount: 0 });
    expect((await get(url(evaluation.id, "handout.json"), teacher.headers)).statusCode).toBe(200);
    const third = (await storedVariant(evaluation.id))!.instances[short.item.id]!;
    expect(third.versionId).toBe(renamed.latest.id);
    expect(Object.keys(third.values).sort()).toEqual(["g", "height", "t"]);
  });

  it("after the opening, keeps an entry that replays, and draws again only one that cannot (a lost update)", async () => {
    const db = server.app.db;
    const evaluation = await parameterizedExam();
    expect((await get(url(evaluation.id, "handout.json"), teacher.headers)).statusCode).toBe(200);
    const before = (await storedVariant(evaluation.id))!;
    const { short, latest } = await republishShort(evaluation.id, false);
    // Opened, and the item retargeted onto the corrected version behind the guards (a regrade's retarget keeps the names).
    await db.update(evaluations).set({ state: "running", startedAt: server.clock.now() }).where(eq(evaluations.id, evaluation.id));
    await db.update(evaluationItems).set({ questionVersionId: latest.id }).where(eq(evaluationItems.id, short.item.id));
    server.clock.advance(60_000);
    expect((await get(url(evaluation.id, "handout.json"), teacher.headers)).statusCode).toBe(200);
    // Replayed, never redrawn: the row is untouched.
    expect(await storedVariant(evaluation.id)).toEqual(before);

    // The lost update: values of the old names stored while the item sits on renamed variables.
    const renamed = await republishShort(evaluation.id, true);
    await db.update(evaluationItems).set({ questionVersionId: renamed.latest.id }).where(eq(evaluationItems.id, short.item.id));
    const res = await get(url(evaluation.id, "handout.json"), teacher.headers);
    expect(res.statusCode, res.body).toBe(200);
    const after = (await storedVariant(evaluation.id))!.instances;
    expect(after[short.item.id]).toMatchObject({ versionId: renamed.latest.id });
    expect(Object.keys(after[short.item.id]!.values).sort()).toEqual(["g", "height", "t"]);
    for (const [id, kept] of Object.entries(before.instances)) if (id !== short.item.id) expect(after[id]).toEqual(kept);
  });
});

describe("an evaluation that does not print (ADR-125 §5)", () => {
  it("prints a code question: a ruled frame to write the program by hand (ADR-126 §8, amended 2026-11-04)", async () => {
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
    const handout = await get(url(evaluation.id, "handout.md"), teacher.headers);
    expect(handout.statusCode).toBe(200);
    expect(handout.body).toContain("CODE_PROMPT");
    const detail = EvaluationDetail.parse((await get(`/app/api/evaluations/${evaluation.id}`, teacher.headers)).json());
    expect(detail.exports).toEqual({ document: null, handout: null, paper: "paper_not_started" });
  });

  it("refuses both documents for a type with no paper form, naming it", async () => {
    // `codeimage` writes no document: its statement is a picture to reproduce.
    const codeimage = {
      configVersion: 1,
      prompt: "Draw CODEIMAGE_PROMPT.",
      language: "c",
      template: "// @@lock\n#include <stdio.h>\nint main(void) {\n// @@endlock\n    puts(\"1\");\n// @@lock\n    return 0;\n}\n// @@endlock\n",
      referenceSolution: '    puts("1 0 1 0");\n',
      image: { width: 4, height: 3, palette: "bw" },
      target: { width: 4, height: 3, palette: "bw", pixels: "101001011010" },
    };
    const evaluation = await exam(async (poolId) => [await publish(poolId, "codeimage", codeimage)]);
    for (const file of ["handout.md", "handout.json", "handout.pdf", "document.md"]) {
      const res = await get(url(evaluation.id, file), teacher.headers);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "not_printable", reason: "type", types: ["codeimage"] });
    }
    const detail = EvaluationDetail.parse((await get(`/app/api/evaluations/${evaluation.id}`, teacher.headers)).json());
    const refusal = { reason: "type", types: ["codeimage"] };
    expect(detail.exports).toEqual({ document: refusal, handout: refusal, paper: "paper_not_started" });
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

/**
 * `circuit` and `logic` on paper (ADR-126 step 2), over the real application:
 * an exam of both prints its hand-out and its statement with key, as
 * Markdown and as PDFs. The hand-out holds no secret of the questions, the
 * PDF's text included, which a figure keeps as text (ADR-126 §9); the key's
 * PDF shows the reference designators and values, the positive control of
 * that search. The tree and the Typst source are searched per type
 * (`packages/qt-circuit/src/document.test.ts`, the registry's contract).
 */
describe("circuit and logic documents", () => {
  /** A pin-to-pin or port-to-pin wire along the stored polyline. */
  const wire = (id: string, a: unknown, b: unknown, points: [number, number][]) => ({ id, a, b, via: [], points });
  const pin = (c: string, p: number) => ({ kind: "pin", c, p });

  /** A resistor between `in+` and `out+`: the reference, its designator and value the key's markers. */
  const CIRCUIT = {
    configVersion: 1,
    prompt: "Wire CIRCUIT_PROMPT between the ports.",
    palette: { kinds: ["R", "C", "GND"], maxComponents: 4 },
    stimuli: [
      {
        name: "VISIBLE_STIM",
        source: { kind: "sine", amplitude: 1, frequencyHz: 1000 },
        load: { kind: "open" },
        points: 1,
        visible: true,
      },
      {
        name: "HIDDEN_STIM_SECRET",
        source: { kind: "step", from: 0, to: 5, atMs: 1 },
        load: { kind: "resistor", ohms: 7331 },
        points: 2,
        visible: false,
      },
    ],
    reference: {
      components: [{ id: "c1", kind: "R", x: 400, y: 100, m: [1, 0, 0, 1], name: "RSECRETKEY", value: "47.11k" }],
      wires: [
        wire("w1", { kind: "port", port: "in+" }, pin("c1", 0), [[0, 100], [360, 100]]),
        wire("w2", pin("c1", 1), { kind: "port", port: "out+" }, [[440, 100], [800, 100]]),
      ],
    },
    grading: { mode: "manual", rubric: "CIRCUIT_RUBRIC_SECRET" },
  };

  const part = (id: string, kind: string, x: number, y: number, name: string) => ({ id, kind, x, y, m: [1, 0, 0, 1], name, value: "" });

  /** A half adder whose key is its reference circuit, the gates named for the search. */
  const LOGIC_REFERENCE = {
    configVersion: 1,
    prompt: "Build LOGIC_PROMPT, a half adder.",
    inputs: ["a", "b"],
    outputs: [{ name: "c" }, { name: "s" }],
    keyFrom: "reference",
    palette: { kinds: ["AND", "XOR"], maxGates: 4 },
    reference: {
      components: [
        part("c1", "IN", 100, 100, "a"),
        part("c2", "IN", 100, 300, "b"),
        part("c3", "AND2", 300, 140, "UKEY41"),
        part("c4", "XOR2", 300, 300, "UKEY42"),
        part("c5", "OUT", 500, 140, "c"),
        part("c6", "OUT", 500, 300, "s"),
      ],
      wires: [
        wire("w1", pin("c1", 0), pin("c3", 0), [[100, 100], [180, 100], [180, 120], [260, 120]]),
        wire("w2", pin("c1", 0), pin("c4", 0), [[100, 100], [180, 100], [180, 280], [260, 280]]),
        wire("w3", pin("c2", 0), pin("c3", 1), [[100, 300], [180, 300], [180, 160], [260, 160]]),
        wire("w4", pin("c2", 0), pin("c4", 1), [[100, 300], [180, 300], [180, 320], [260, 320]]),
        wire("w5", pin("c3", 2), pin("c5", 0), [[340, 140], [500, 140]]),
        wire("w6", pin("c4", 2), pin("c6", 0), [[340, 300], [500, 300]]),
      ],
    },
  };

  /** A majority, its expression the key. */
  const LOGIC_EXPRESSIONS = {
    configVersion: 1,
    prompt: "Build LOGIC_MAJORITY_PROMPT.",
    inputs: ["a", "b", "c"],
    outputs: [{ name: "m", expression: "a*b + a*c + b*c" }],
    palette: { kinds: ["AND", "OR"], maxGates: 6 },
  };

  /** Everything above a student must never read. */
  const SECRETS = [
    "RSECRETKEY",
    "47.11k",
    "HIDDEN_STIM_SECRET",
    "7331",
    "7.331k",
    "CIRCUIT_RUBRIC_SECRET",
    "UKEY41",
    "UKEY42",
    "a*b + a*c",
    "EXPLANATION_SECRET",
    "INTERNAL_NAME",
  ];

  let server: TestServer;
  let teacher: { id: string; headers: Record<string, string> };

  beforeAll(async () => {
    server = await testServer();
    teacher = await server.signIn("teacher");
  });
  afterAll(async () => {
    await server.close();
  });

  const get = (url: string, headers: Record<string, string>) => server.app.inject({ method: "GET", url, headers });
  const url = (id: string, file: string) => `/app/api/evaluations/${id}/${file}`;

  async function publish(poolId: string, type: string, config: unknown, tag: string): Promise<string> {
    const db = server.app.db;
    const { id } = await poolService.createQuestion(db, { poolId, type, internalName: `INTERNAL_NAME_${tag}`, createdBy: teacher.id });
    const [question] = await db.select().from(questions).where(eq(questions.id, id));
    const saved = await poolService.putDraft(db, question!, { config, explanation: `EXPLANATION_SECRET_${tag}` });
    if (!saved.valid) throw new Error(`${type} is not publishable: ${JSON.stringify(saved.issues)}`);
    await poolService.publishQuestion(db, question!, { userId: teacher.id });
    return id;
  }

  /** An exam of one circuit and two logic questions. */
  async function exam() {
    const db = server.app.db;
    const seed = await seedLive(db, { teacherId: teacher.id, studentIds: [], questions: 0, settings: { shuffleItems: false } });
    const ids = [
      await publish(seed.poolId, "circuit", CIRCUIT, "circuit"),
      await publish(seed.poolId, "logic", LOGIC_REFERENCE, "logic_reference"),
      await publish(seed.poolId, "logic", LOGIC_EXPRESSIONS, "logic_expressions"),
    ];
    await addItems(db, await reload(db, seed.evaluationId), ids, (type, version) =>
      typeOf(type).defaultPoints(poolService.exampleConfig(type, version)), { attemptCount: 0 });
    return reload(db, seed.evaluationId);
  }

  describe("circuit and logic on paper (ADR-126)", () => {
    it("hand out the statements and no secret, as Markdown", async () => {
      const evaluation = await exam();
      const res = await get(url(evaluation.id, "handout.md"), { ...teacher.headers, "accept-language": "fr-CH" });
      expect(res.statusCode).toBe(200);
      for (const prompt of ["CIRCUIT_PROMPT", "LOGIC_PROMPT", "LOGIC_MAJORITY_PROMPT", "VISIBLE_STIM", "Stimuli cachés"]) {
        expect(res.body).toContain(prompt);
      }
      expect(findStudentLeaks(withoutRandomHex(res.body), { secrets: SECRETS })).toEqual([]);
    });

    it("give the staff the reference designators and the equations in the statement with key", async () => {
      const evaluation = await exam();
      const res = await get(url(evaluation.id, "document.md"), teacher.headers);
      expect(res.statusCode).toBe(200);
      for (const marker of ["RSECRETKEY 47.11k", "UKEY41", "UKEY42", "m = a \\cdot b + a \\cdot c + b \\cdot c"]) {
        expect(res.body).toContain(marker);
      }
    });

    it.skipIf(!pdfTools)("print the key's figures as text a PDF search finds", async () => {
      const evaluation = await exam();
      const res = await get(url(evaluation.id, "document.pdf"), teacher.headers);
      expect(res.statusCode).toBe(200);
      const text = await pdfText(res.rawPayload);
      for (const marker of ["RSECRETKEY", "47.11k", "UKEY41", "UKEY42", "CIRCUIT_PROMPT"]) {
        expect(text).toContain(marker);
      }
    });

    it.skipIf(!pdfTools)("print a hand-out PDF whose text holds no secret, in the reader's language", async () => {
      const evaluation = await exam();
      const res = await get(url(evaluation.id, "handout.pdf"), { ...teacher.headers, "accept-language": "fr-CH" });
      expect(res.statusCode).toBe(200);
      const text = await pdfText(res.rawPayload);
      // The prompts, the visible stimulus and the starter's port and terminal names are there…
      for (const shown of ["CIRCUIT_PROMPT", "LOGIC_PROMPT", "VISIBLE_STIM", "in+", "out-", "Entrées"]) expect(text).toContain(shown);
      // …and nothing of the keys.
      for (const secret of SECRETS) expect(text).not.toContain(secret);
    });
  });
});

/**
 * A diagram on paper (ADR-126 step 3), over the real application: what the
 * package tests cannot prove. The hand-out served over HTTP holds the prompt,
 * the notation and the starter, and no key, in its Markdown and in its PDF's
 * text (ADR-125 §19, ADR-126 §9: an SVG's text stays text in the PDF); the
 * staff "statement with key" PDF reads the reference's names as text.
 */
describe("diagram documents", () => {
  /** A class diagram whose key is all markers; its starter holds one class of its own. */
  const CLASS = {
    configVersion: 1,
    prompt: "Draw DIAGRAM_PROMPT_CLASS.",
    kind: "class",
    reference: {
      nodes: [
        { id: "ref00001", t: "class", x: 40, y: 40, name: "RefSecretShape", abstract: true, body: ["# refSecretOrigin : Point"] },
        { id: "ref00002", t: "class", x: 40, y: 240, name: "RefSecretCircle", body: ["- refSecretRadius : double"] },
      ],
      links: [{ id: "ref00003", type: "inh", a: "ref00002", b: "ref00001", name: "refSecretLink" }],
    },
    starter: { nodes: [{ id: "start001", t: "class", x: 40, y: 40, name: "StarterShape" }], links: [] },
    rubric: "DIAGRAM_RUBRIC_SECRET",
  };

  /** A state machine with no starter. */
  const STATE = {
    configVersion: 1,
    prompt: "Draw DIAGRAM_PROMPT_STATE.",
    kind: "state",
    reference: {
      nodes: [
        { id: "st000001", t: "initial", x: 40, y: 40 },
        { id: "st000002", t: "state", x: 0, y: 140, name: "RefSecretIdle" },
      ],
      links: [{ id: "st000003", type: "strans", a: "st000001", b: "st000002", name: "refSecretGo" }],
    },
    rubric: "",
  };

  /** What a student must never read. */
  const SECRETS = [
    "RefSecretShape",
    "RefSecretCircle",
    "refSecretOrigin",
    "refSecretRadius",
    "refSecretLink",
    "RefSecretIdle",
    "refSecretGo",
    "DIAGRAM_RUBRIC_SECRET",
    "INTERNAL_NAME",
    "EXPLANATION_SECRET",
  ];

  let server: TestServer;
  let teacher: { id: string; headers: Record<string, string> };

  beforeAll(async () => {
    server = await testServer();
    teacher = await server.signIn("teacher");
  });
  afterAll(async () => {
    await server.close();
  });

  const get = (url: string, headers: Record<string, string>) => server.app.inject({ method: "GET", url, headers });
  const url = (id: string, file: string) => `/app/api/evaluations/${id}/${file}`;

  async function publish(poolId: string, config: unknown, name: string): Promise<string> {
    const db = server.app.db;
    const { id } = await poolService.createQuestion(db, { poolId, type: "diagram", internalName: `INTERNAL_NAME_${name}`, createdBy: teacher.id });
    const [question] = await db.select().from(questions).where(eq(questions.id, id));
    const saved = await poolService.putDraft(db, question!, { config, explanation: `EXPLANATION_SECRET_${name}` });
    if (!saved.valid) throw new Error(`not publishable: ${JSON.stringify(saved.issues)}`);
    await poolService.publishQuestion(db, question!, { userId: teacher.id });
    return id;
  }

  /** An exam of the two diagrams. */
  async function exam() {
    const db = server.app.db;
    const seed = await seedLive(db, { teacherId: teacher.id, studentIds: [], questions: 0 });
    const ids = [await publish(seed.poolId, CLASS, "class"), await publish(seed.poolId, STATE, "state")];
    await addItems(db, await reload(db, seed.evaluationId), ids, (type, version) =>
      typeOf(type).defaultPoints(poolService.exampleConfig(type, version)), { attemptCount: 0 });
    return reload(db, seed.evaluationId);
  }

  describe("a diagram on paper (ADR-126)", () => {
    it("hands out the prompts and the notations, and no key, as Markdown", async () => {
      const evaluation = await exam();
      const md = await get(url(evaluation.id, "handout.md"), { ...teacher.headers, "accept-language": "fr-CH" });
      expect(md.statusCode).toBe(200);
      for (const text of ["DIAGRAM_PROMPT_CLASS", "DIAGRAM_PROMPT_STATE", "Diagramme de classes UML", "Machine d'états"]) {
        expect(md.body).toContain(text);
      }
      expect(findStudentLeaks(withoutRandomHex(md.body), { secrets: SECRETS })).toEqual([]);
    });

    it.skipIf(!pdfTools)("serves the hand-out as a PDF whose text holds the starter and no key", async () => {
      const evaluation = await exam();
      const res = await get(url(evaluation.id, "handout.pdf"), teacher.headers);
      expect(res.statusCode).toBe(200);
      const text = await pdfText(res.rawPayload);
      for (const shown of ["DIAGRAM_PROMPT_CLASS", "DIAGRAM_PROMPT_STATE", "StarterShape"]) expect(text).toContain(shown);
      for (const secret of SECRETS) expect(text).not.toContain(secret);
    });

    it.skipIf(!pdfTools)("serves the statement with key as a PDF whose figures' names read as text", async () => {
      const evaluation = await exam();
      const res = await get(url(evaluation.id, "document.pdf"), teacher.headers);
      expect(res.statusCode).toBe(200);
      const text = await pdfText(res.rawPayload);
      for (const secret of SECRETS) expect(text).toContain(secret);
    });
  });
});
