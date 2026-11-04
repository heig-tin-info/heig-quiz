/**
 * A diagram on paper (ADR-126 step 3), over the real application: the
 * hand-out gives the prompt, the notation and a squared frame with the
 * starter in grey, and never the reference nor the rubric — searched in the
 * record, the tree, the Markdown and the PDF's text (ADR-125 §19, ADR-126
 * §9: an SVG's text stays text in the PDF); the staff "statement with key"
 * draws the reference, its names readable in the PDF.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EvaluationDetail, HandoutRecord } from "@quiz/contracts";
import { findStudentLeaks } from "@quiz/core/testing";

import { questions } from "../../db/schema.js";
import { type TestServer, testServer } from "../../test/http.js";
import { reload, seedLive } from "../../test/live.js";
import { pdfText, pdfTools } from "../../test/pdf.js";
import * as live from "../live/service.js";
import { typeOf } from "../pool/config.js";
import * as poolService from "../pool/service.js";
import { handout, handoutTree } from "./document.js";
import { addItems } from "./service.js";

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
  it("prints: both documents offered on the detail", async () => {
    const evaluation = await exam();
    const detail = EvaluationDetail.parse((await get(`/app/api/evaluations/${evaluation.id}`, teacher.headers)).json());
    expect(detail.exports).toMatchObject({ document: null, handout: null });
  });

  it("hands out the prompts, the notation and the frames, and no key, in the record, the tree and the Markdown", async () => {
    const evaluation = await exam();
    const md = await get(url(evaluation.id, "handout.md"), { ...teacher.headers, "accept-language": "fr-CH" });
    expect(md.statusCode).toBe(200);
    for (const text of ["DIAGRAM_PROMPT_CLASS", "DIAGRAM_PROMPT_STATE", "Diagramme de classes UML", "Machine d'états"]) {
      expect(md.body).toContain(text);
    }
    expect(findStudentLeaks(md.body, { secrets: SECRETS })).toEqual([]);

    const record = HandoutRecord.parse((await get(url(evaluation.id, "handout.json"), teacher.headers)).json());
    expect(findStudentLeaks(record, { forbiddenKeys: live.FORBIDDEN_STUDENT_KEYS, secrets: SECRETS })).toEqual([]);

    const found = await handout(server.app.db, evaluation, { now: server.clock.now() });
    for (const lang of ["en", "fr"] as const) {
      const tree = handoutTree(found, lang);
      expect(findStudentLeaks(tree, { forbiddenKeys: live.FORBIDDEN_STUDENT_KEYS, secrets: SECRETS })).toEqual([]);
      const frames = tree.blocks.filter((b) => b.kind === "answerZone" && b.zone === "free");
      expect(frames).toHaveLength(2);
      // The class diagram's starter is drawn under its frame; the state machine has none.
      expect(JSON.stringify(frames)).toContain("StarterShape");
      expect(frames.filter((f) => f.kind === "answerZone" && f.underlay !== undefined)).toHaveLength(1);
    }
  });

  it("draws the reference in the statement with key, with the rubric", async () => {
    const evaluation = await exam();
    const res = await get(url(evaluation.id, "document.md"), teacher.headers);
    expect(res.statusCode).toBe(200);
    for (const secret of SECRETS) expect(res.body).toContain(secret);
    expect(res.body).toContain("```plantuml");
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
