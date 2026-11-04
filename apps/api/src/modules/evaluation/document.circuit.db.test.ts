/**
 * `circuit` and `logic` on paper (ADR-126 step 2), over the real application:
 * an exam of both prints its hand-out and its statement with key, as
 * Markdown and as PDFs. The hand-out holds no secret of the questions, the
 * PDF's text included, which a figure keeps as text (ADR-126 §9); the key's
 * PDF shows the reference designators and values, the positive control of
 * that search. The tree and the Typst source are searched per type
 * (`packages/qt-circuit/src/document.test.ts`, the registry's contract).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findStudentLeaks } from "@quiz/core/testing";

import { questions } from "../../db/schema.js";
import { type TestServer, testServer } from "../../test/http.js";
import { reload, seedLive } from "../../test/live.js";
import { pdfText, pdfTools } from "../../test/pdf.js";
import { typeOf } from "../pool/config.js";
import * as poolService from "../pool/service.js";
import { addItems } from "./service.js";

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
    expect(findStudentLeaks(res.body, { secrets: SECRETS })).toEqual([]);
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
