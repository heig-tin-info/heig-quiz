/**
 * Publication of a parameterized question (ADR-056 §1, §3, §6, §7, §10) over
 * the real migrations: the draft stores its table as sent (D16) with its
 * issues; publication refuses a table that cannot draw, an unknown name, a
 * `[[…]]` that does not parse, a type that takes no variables and a computed
 * text key, each with a stable code the editor translates; a published one
 * keeps its template and its table, and `randomizable` follows it.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { ParametersDraft } from "@quiz/contracts";

import type { Db } from "../../db/client.js";
import { pools, questions, users } from "../../db/schema.js";
import { testDb } from "../../test/db.js";
import { EXPLANATION, PARAMETERIZED, VARIABLES } from "../../test/parameterized.js";
import { checkConfig } from "../mcp/questionTypes.js";
import { draw } from "@quiz/domain/parameters";

import { exampleInstance, instanceOf, templateHash } from "./instance.js";
import * as service from "./service.js";

let db: Db;
let ownerId: string;
let poolId: string;

beforeAll(async () => {
  db = await testDb();
  ownerId = randomUUID();
  await db.insert(users).values({ id: ownerId, oidcSub: `t-${ownerId}`, email: `${ownerId}@heig.test`, role: "teacher" });
  poolId = randomUUID();
  await db.insert(pools).values({ id: poolId, name: "Parameterized", ownerId });
});

async function question(type: string) {
  const { id } = await service.createQuestion(db, {
    poolId,
    type,
    internalName: `q-${randomUUID().slice(0, 8)}`,
    createdBy: ownerId,
  });
  const [row] = await db.select().from(questions).where(eq(questions.id, id));
  return row!;
}

/** Saves a draft, then tries to publish it: the issues, or the version published. */
async function attempt(
  type: string,
  draft: { config: unknown; explanation?: string; variables?: ParametersDraft | null },
) {
  const q = await question(type);
  const saved = await service.putDraft(db, q, draft);
  try {
    const version = await service.publishQuestion(db, q, { userId: ownerId });
    return { q, saved, version, refused: null };
  } catch (error) {
    if (!(error instanceof service.DraftInvalid)) throw error;
    return { q, saved, version: null, refused: error.issues };
  }
}

const messages = (issues: { message: string }[] | null) => (issues ?? []).map((i) => i.message);

describe("the draft (D16)", () => {
  it("stores the table as sent, with its issues, and hands it back", async () => {
    const half = { rows: [{ name: "1h", expr: "randint(", format: "?" }] };
    const q = await question("mcq");
    const saved = await service.putDraft(db, q, { config: PARAMETERIZED.mcq, variables: half });
    expect(saved.valid).toBe(false);
    expect(messages(saved.issues)).toContain("parameters.bad_name");
    expect(saved.issues[0]!.path[0]).toBe("variables");
    const detail = await service.questionDetail(db, (await db.select().from(questions).where(eq(questions.id, q.id)))[0]!, "en");
    expect(detail.draft.variables).toEqual(half);
    expect(detail.draft.valid).toBe(false);
    // Absent keeps the stored table; null makes the question static again.
    await service.putDraft(db, q, { config: PARAMETERIZED.mcq });
    expect((await service.draftOf(db, q.id)).variables).toEqual(half);
    await service.putDraft(db, q, { config: PARAMETERIZED.mcq, variables: null });
    expect((await service.draftOf(db, q.id)).variables).toBeNull();
  });
});

describe("publication of a parameterized question", () => {
  it("publishes each v1 type, keeps the template and the table, and derives randomizable", async () => {
    for (const type of ["mcq", "short", "cloze"] as const) {
      const { q, saved, version, refused } = await attempt(type, {
        config: PARAMETERIZED[type],
        explanation: EXPLANATION,
        variables: VARIABLES,
      });
      expect(saved).toMatchObject({ valid: true, issues: [] });
      expect(refused).toBeNull();
      const [row] = await db.select().from(questions).where(eq(questions.id, q.id));
      expect(row!.randomizable).toBe(true);
      const detail = (await service.versionDetail(db, row!, version!.number))!;
      expect(detail.variables).toEqual(VARIABLES);
      // The formulas, never one instance.
      expect(JSON.stringify(detail.config)).toContain("[[t]]");
      expect(detail.explanation).toBe(EXPLANATION);
    }
  });

  it("refuses what cannot draw or render, with stable codes", async () => {
    // Reads `h` only, so the table may declare nothing else.
    const onlyH = {
      configVersion: 2,
      prompt: "From [[h]] m?",
      mode: "single",
      choices: [
        { text: "a", correct: true },
        { text: "b", correct: false },
      ],
    };
    const cases: [ParametersDraft, unknown, string][] = [
      [{ rows: [{ name: "h", expr: "2pi", format: "" }] }, onlyH, "parameters.forbidden_node"],
      [{ rows: [{ name: "h", expr: "", format: "" }] }, onlyH, "parameters.empty_expression"],
      [{ rows: [{ name: "h", expr: "randint(1, 3)", format: "int" }], condition: "h > 5" }, onlyH, "parameters.condition_exhausted"],
      [VARIABLES, { ...(PARAMETERIZED.mcq as object), prompt: "From [[height]] m." }, "parameters.unknown_name"],
      [VARIABLES, { ...(PARAMETERIZED.mcq as object), prompt: "From [[h m." }, "parameters.unterminated"],
      // Two choices that always read alike (ADR-056 §7).
      [
        VARIABLES,
        { ...(PARAMETERIZED.mcq as object), choices: [{ text: "[[t]]", correct: true }, { text: "[[t]]", correct: false }] },
        "parameters.choices_not_distinct",
      ],
    ];
    for (const [variables, config, code] of cases) {
      const { refused } = await attempt("mcq", { config, variables });
      expect(messages(refused)).toContain(code);
    }
  });

  it("points an issue at its row, or at the text that holds the `[[`", async () => {
    const { refused } = await attempt("mcq", {
      config: { ...(PARAMETERIZED.mcq as object), prompt: "From [[height]] m." },
      variables: VARIABLES,
    });
    expect(refused![0]!.path).toEqual(["prompt"]);
    const infinite = { rows: [VARIABLES.rows[0]!, VARIABLES.rows[1]!, { name: "t", expr: "h/0", format: "" }] };
    const row = await attempt("mcq", { config: PARAMETERIZED.mcq, variables: infinite });
    expect(row.refused![0]).toMatchObject({ path: ["variables", "t"], message: "parameters.not_a_number" });
  });

  it("puts the instances through the type's own gate", async () => {
    // Every instance holds 13 choices: one too many, whatever is drawn.
    const choices = Array.from({ length: 13 }, (_, i) => ({ text: `[[h + ${i}]]`, correct: i === 0 }));
    const { refused } = await attempt("mcq", { config: { ...(PARAMETERIZED.mcq as object), choices }, variables: VARIABLES });
    expect(refused![0]!.path).toEqual(["choices"]);
  });

  it("refuses variables on a type that takes none, and a computed text key", async () => {
    const rich = await attempt("rich", {
      config: { configVersion: 1, prompt: "Explain [[h]].", rubric: "r" },
      variables: VARIABLES,
    });
    expect(messages(rich.refused)).toEqual(["parameters.unsupported_type"]);
    const text = await attempt("short", {
      config: { configVersion: 3, prompt: "[[h]]?", matchers: [{ kind: "exact", value: "[[t]]" }] },
      variables: VARIABLES,
    });
    expect(messages(text.refused)).toEqual(["short.computed_text_key"]);
  });

  it("refuses a `[[…]]` key on a question without variables, where nothing will replace it", async () => {
    const { refused } = await attempt("short", {
      config: { configVersion: 3, prompt: "Time?", kind: "number", matchers: [{ kind: "number", value: "[[t]]" }] },
    });
    expect(messages(refused)).toEqual(["short.unresolved_reference"]);
  });

  it("is checked the same way by the MCP's pre-check", () => {
    expect(checkConfig("mcq", PARAMETERIZED.mcq, { explanation: EXPLANATION, variables: VARIABLES })).toBeNull();
    expect(checkConfig("cloze", PARAMETERIZED.cloze, { variables: VARIABLES })).toBeNull();
    expect(checkConfig("mcq", PARAMETERIZED.mcq, { variables: { rows: [{ name: "h", expr: "2pi", format: "" }] } })).toContainEqual({
      path: "variables.h",
      message: "parameters.forbidden_node",
    });
    // A static cloze with the same `{{#[[t]]}}` blank is no number blank at all.
    expect(checkConfig("cloze", PARAMETERIZED.cloze)).not.toBeNull();
  });
});

describe("the instances (ADR-056 §4, §5)", () => {
  it("renders the stored values, replays them under the same names, and never touches a static version", async () => {
    const { q, version } = await attempt("short", { config: PARAMETERIZED.short, explanation: EXPLANATION, variables: VARIABLES });
    const row = (await service.versionRow(db, q.id, version!.number))!;
    const drawn = instanceOf("short", row, { seed: 7, itemId: "item" });
    const again = instanceOf("short", row, {
      seed: 99,
      itemId: "other",
      stored: { versionId: row.id, values: drawn.values! },
    });
    expect(again).toEqual(drawn);
    expect(again.version.variables).toBeNull();
    expect(JSON.stringify(again.version.config)).not.toContain("[[");
    expect(again.explanation).not.toContain("[[");
    // Under another version with the same names: the drawn rows kept, t replayed.
    const other = { ...row, id: randomUUID(), variables: { rows: VARIABLES.rows.map((r) => (r.name === "t" ? { ...r, expr: "h" } : r)) } };
    const replayed = instanceOf("short", other, { seed: 0, itemId: "x", stored: { versionId: row.id, values: drawn.values! } });
    expect(replayed.values).toEqual({ ...drawn.values, t: drawn.values!["h"] });
    const renamed = { ...row, id: randomUUID(), variables: { rows: [{ name: "k", expr: "1", format: "" }] } };
    expect(() => instanceOf("short", renamed, { seed: 0, itemId: "x", stored: { versionId: row.id, values: drawn.values! } })).toThrow(
      service.InstanceMismatch,
    );
    // The example instance is `draw(params, 0)`, the draw publication gated;
    // the template's hash ignores every draw.
    expect(exampleInstance("short", row).values).toEqual(draw(service.parametersOf(row)!, 0).values);
    expect(templateHash("short", row)).toBe(templateHash("short", { ...row }));
    expect(templateHash("short", other)).not.toBe(templateHash("short", row));

    const plain = await attempt("short", { config: { configVersion: 3, prompt: "[[1,2]]?", matchers: [{ kind: "exact", value: "a" }] } });
    const staticRow = (await service.versionRow(db, plain.q.id, plain.version!.number))!;
    const same = instanceOf("short", staticRow, { seed: 1, itemId: "i" });
    expect(same.values).toBeNull();
    expect(same.version.config).toBe(staticRow.config);
    const [plainQuestion] = await db.select().from(questions).where(eq(questions.id, plain.q.id));
    expect(plainQuestion!.randomizable).toBe(false);
  });
});
