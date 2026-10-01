/**
 * Parameterized questions of the three v1 types (ADR-056), full
 * configurations — variables in the statement, the choices, the key, the
 * blanks and the explanation — for the invariant 4 tests (docs/05 §5.7) and
 * the drill's and the pool's.
 *
 * The ADR's example: a ball dropped from `h` metres on a planet of gravity
 * `g`; the fall lasts `t`. `MARKERS` is everything of the template that must
 * never reach a student: the `[[`, each name as a reference, every
 * expression, the condition and the table's own vocabulary.
 */
import { eq } from "drizzle-orm";

import type { ParametersDraft } from "@quiz/contracts";
import { formatValue, type Values } from "@quiz/domain/parameters";

import type { Db } from "../db/client.js";
import { questions } from "../db/schema.js";
import * as poolService from "../modules/pool/service.js";

export const VARIABLES: ParametersDraft = {
  rows: [
    { name: "h", expr: "randint(10, 100)", format: "int" },
    { name: "g", expr: "choice([3.71, 9.81, 24.79])", format: ".2" },
    { name: "t", expr: "sqrt(2*h/g)", format: ".2" },
  ],
  condition: "t > 1.5",
};

export const EXPLANATION = "The fall lasts [[t]] s.";

export const PARAMETERIZED: Record<"mcq" | "short" | "cloze", unknown> = {
  mcq: {
    configVersion: 2,
    prompt: "A ball is dropped from [[h]] m where g = [[g]] m/s². How long does it fall?",
    mode: "single",
    choices: [
      { text: "[[t]] s", correct: true },
      { text: "[[sqrt(h/g)]] s", correct: false },
      { text: "[[2*h/g]] s", correct: false },
    ],
  },
  short: {
    configVersion: 3,
    prompt: "A ball is dropped from [[h]] m where g = [[g]] m/s². How many seconds does it fall?",
    kind: "number",
    matchers: [{ kind: "number", value: "[[t]]", tolerance: "[[t/100]]" }],
  },
  cloze: {
    configVersion: 2,
    text: "Dropped from [[h]] m where g = [[g]] m/s², the ball falls for {{#[[t]]:1%}} s.",
  },
};

/** What a student payload must never carry of a parameterized template. */
export const MARKERS = [
  // Every name as a reference, and the expressions' own `[[`; a bare `[[`
  // could be JSON's nested array.
  "[[h",
  "[[g",
  "[[t",
  "[[sqrt",
  "[[2",
  "randint",
  "choice(",
  "uniform",
  "sqrt(",
  "2*h/g",
  "h/g",
  "t/100",
  "t > 1.5",
  "variables",
  '"expr"',
];

/** The markers `text` carries; `[]` when it is clean. */
export const markersIn = (text: string): string[] => MARKERS.filter((m) => text.includes(m));

/** `t` as a student reads it in one instance. */
export const fallOf = (values: Values): string => formatValue(values["t"]!, ".2");

/**
 * Whether `text` shows the key `t` as a number of its own: "2.60", "2.6" (a
 * short stores the number) — never as part of another number ("3" in "3.71")
 * or of a word or id ("3" in "3aaab5f6").
 */
export function showsKey(text: string, values: Values): boolean {
  const n = String(Number(fallOf(values))).replace(".", "\\.");
  const fraction = n.includes(".") ? "0*" : "(?:\\.0*)?";
  return new RegExp(`(?<![\\w.])${n}${fraction}(?!\\w|\\.\\d)`).test(text);
}

/** One parameterized question of `type`, published through the ordinary services. */
export async function publishParameterized(
  db: Db,
  input: { poolId: string; teacherId: string; type: "mcq" | "short" | "cloze"; name?: string },
): Promise<string> {
  const { id } = await poolService.createQuestion(db, {
    poolId: input.poolId,
    type: input.type,
    internalName: input.name ?? `parameterized-${input.type}`,
    createdBy: input.teacherId,
  });
  const [question] = await db.select().from(questions).where(eq(questions.id, id));
  const saved = await poolService.putDraft(db, question!, {
    config: PARAMETERIZED[input.type],
    explanation: EXPLANATION,
    variables: VARIABLES,
  });
  if (!saved.valid) throw new Error(`fixture ${input.type} is not publishable: ${JSON.stringify(saved.issues)}`);
  await poolService.publishQuestion(db, question!, { userId: input.teacherId });
  return id;
}
