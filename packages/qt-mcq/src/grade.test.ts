/**
 * The grading truth table, exercised THROUGH `mcqServer.grade()` (PLAN-MVP §8
 * WP2): the formulas themselves are proven in `@quiz/domain`, what is proven
 * here is that the type RESOLVES the right policy, maps an answer onto it and
 * onto the item scale.
 */
import { isGraded } from "@quiz/core/server";
import { describe, expect, it } from "vitest";
import { gradeContext, multipleConfig } from "./test/fixtures.js";
import { resolvePolicy } from "./grade.js";
import {
  MCQ_CONFIG_VERSION,
  McqConfigSchema,
  type McqAnswer,
  type McqConfig,
  type McqPolicy,
} from "./schema.js";
import { mcqServer } from "./server.js";

/** What an evaluation hands the grader: its own policy, for `inherit` configs. */
const withPolicy = (policy: McqPolicy) => ({ mcq: { policy } });

/** The mcq grader is synchronous and always final; anything else is a bug. */
function gradedNow(
  config: McqConfig,
  answer: McqAnswer | null,
  points: number,
  defaults?: Readonly<Record<string, unknown>>,
) {
  const result = mcqServer.grade(config, answer, gradeContext(points, defaults));
  if (result instanceof Promise) throw new Error("the mcq grader must be synchronous");
  if (!isGraded(result)) throw new Error("the mcq grader must never return a pending result");
  return result;
}

function fractionOf(
  config: McqConfig,
  selected: number[] | null,
  points = 10,
  defaults?: Readonly<Record<string, unknown>>,
): number {
  return gradedNow(config, selected === null ? null : { selected }, points, defaults).details
    .fraction;
}

/** Keys are {0,1}, distractors {2,3}: C = 2, W = 2. */
const SELECTIONS: [string, number[] | null][] = [
  ["nothing selected", []],
  ["not answered at all", null],
  ["both keys", [0, 1]],
  ["one key", [0]],
  ["one key and one distractor", [0, 2]],
  ["everything", [0, 1, 2, 3]],
];

describe("the five policies through grade()", () => {
  const expected: Record<McqPolicy, number[]> = {
    // nothing, null, both keys, one key, key+distractor, everything
    all_or_nothing: [0, 0, 1, 0, 0, 0],
    true_false: [0.5, 0.5, 1, 0.75, 0.5, 0.5],
    discordance: [0.2, 0.2, 1, 0.5, 0.2, 0.2],
    symmetric: [0, 0, 1, 0.5, 0, 0],
    ripkey: [0, 0, 1, 0.5, 0, 0],
  };

  for (const policy of Object.keys(expected) as McqPolicy[]) {
    const config = multipleConfig({ policy });
    SELECTIONS.forEach(([name, selected], i) => {
      it(`${policy}: ${name}`, () => {
        expect(fractionOf(config, selected)).toBeCloseTo(expected[policy][i]!, 10);
      });
    });
  }
});

describe("the policy hierarchy", () => {
  it("takes the evaluation's policy when the question says inherit", () => {
    const config = multipleConfig({ policy: "inherit" });
    expect(fractionOf(config, [0], 10, withPolicy("true_false"))).toBeCloseTo(0.75, 10);
    expect(fractionOf(config, [0], 10, withPolicy("discordance"))).toBeCloseTo(0.5, 10);
  });

  it("lets the question override the evaluation", () => {
    const config = multipleConfig({ policy: "ripkey" });
    expect(fractionOf(config, [0, 2], 10, withPolicy("true_false"))).toBe(0);
  });

  /*
   * `POST /questions/:id/try` has no evaluation and therefore no `defaults`:
   * an `inherit` question is graded all or nothing there.
   */
  it("falls back to all_or_nothing with no evaluation (the Try panel)", () => {
    const config = multipleConfig({ policy: "inherit" });
    expect(fractionOf(config, [0])).toBe(0);
    expect(fractionOf(config, [0, 1])).toBe(1);
  });

  it("ignores a defaults entry it cannot read", () => {
    const config = multipleConfig({ policy: "inherit" });
    expect(fractionOf(config, [0], 10, { mcq: { policy: "curve" } })).toBe(0);
    expect(fractionOf(config, [0], 10, { mcq: "true_false" })).toBe(0);
    expect(fractionOf(config, [0], 10, { short: { policy: "true_false" } })).toBe(0);
  });

  it("records the APPLIED policy in the details, inherit resolved", () => {
    const inherit = multipleConfig({ policy: "inherit" });
    expect(gradedNow(inherit, { selected: [0] }, 1, withPolicy("symmetric")).details.policy).toBe(
      "symmetric",
    );
    expect(gradedNow(inherit, { selected: [0] }, 1).details.policy).toBe("all_or_nothing");
    expect(
      gradedNow(multipleConfig({ policy: "ripkey" }), { selected: [0] }, 1, withPolicy("symmetric"))
        .details.policy,
    ).toBe("ripkey");
  });

  it("scores a single question all or nothing, whatever either level says", () => {
    const single = McqConfigSchema.parse({
      configVersion: MCQ_CONFIG_VERSION,
      prompt: "What is `p + 1`?",
      choices: [
        { text: "0x1001", correct: false },
        { text: "0x1004", correct: true },
        { text: "0x1008", correct: false },
      ],
      policy: "true_false",
    });
    expect(resolvePolicy(single, withPolicy("discordance"))).toBe("all_or_nothing");
    expect(fractionOf(single, [1], 10, withPolicy("true_false"))).toBe(1);
    expect(fractionOf(single, [0], 10, withPolicy("true_false"))).toBe(0);
    expect(fractionOf(single, [0, 1], 10, withPolicy("true_false"))).toBe(0);
  });
});

describe("the fraction reaches the item scale", () => {
  it("multiplies by itemPoints and rounds to two decimals", () => {
    const config = multipleConfig({ policy: "symmetric" });
    const result = gradedNow(config, { selected: [0] }, 3);
    expect(result.points).toBe(1.5);
    expect(result.maxPoints).toBe(3);
  });

  it("is born validated: nothing here needs a teacher's eyes", () => {
    expect(gradedNow(multipleConfig(), { selected: [0, 1] }, 1).state).toBe("validated");
  });

  it("gives 0 to an unanswered question (F-GRADE-01)", () => {
    const result = gradedNow(multipleConfig({ policy: "all_or_nothing" }), null, 5);
    expect(result.points).toBe(0);
    expect(result.details.selected).toEqual([]);
  });

  it("never goes below zero: an answer is never worth less than no answer", () => {
    for (const policy of ["symmetric", "ripkey", "discordance", "true_false"] as const) {
      const config = multipleConfig({ policy });
      expect(gradedNow(config, { selected: [2, 3] }, 4).points).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("maxSelections", () => {
  const config = multipleConfig({ policy: "symmetric", maxSelections: 2 });

  it("truncates instead of refusing, and says so in the details", () => {
    const result = gradedNow(config, { selected: [0, 1, 2] }, 2);
    expect(result.details.selected).toEqual([0, 1]);
    expect(result.details.truncated).toBe(true);
  });

  it("leaves a payload within the limit alone", () => {
    expect(gradedNow(config, { selected: [1] }, 2).details.truncated).toBe(false);
  });
});

describe("the details", () => {
  it("carry the counts the teacher panel shows", () => {
    const result = gradedNow(multipleConfig({ policy: "symmetric" }), { selected: [0, 2, 2] }, 1);
    expect(result.details).toMatchObject({
      policy: "symmetric",
      correct: [0, 1],
      selected: [0, 2],
      c: 1,
      w: 1,
      C: 2,
      W: 2,
    });
  });

  it("validate against detailsSchema, which is what the column stores", () => {
    const result = gradedNow(multipleConfig(), { selected: [1] }, 1);
    expect(mcqServer.detailsSchema.safeParse(result.details).success).toBe(true);
  });
});

/**
 * Negative marking (ADR-026, #130): an EVALUATION setting that overrides the
 * policy of every choice question, single and multiple answer.
 */
describe("negative marking", () => {
  const negative = (policy: McqPolicy = "all_or_nothing") => ({
    mcq: { policy, negativeMarking: true },
  });
  const single = McqConfigSchema.parse({
    configVersion: MCQ_CONFIG_VERSION,
    prompt: "What is `p + 1`?",
    choices: [
      { text: "0x1001", correct: false },
      { text: "0x1004", correct: true },
      { text: "0x1008", correct: false },
      { text: "0x1010", correct: false },
    ],
  });

  it("scores a single answer +1, -1/(n-1) or 0, times the item's points", () => {
    expect(gradedNow(single, { selected: [1] }, 3, negative()).points).toBe(3);
    // Four choices: a distractor costs a third of the item.
    expect(gradedNow(single, { selected: [0] }, 3, negative()).points).toBe(-1);
    expect(gradedNow(single, { selected: [0] }, 2, negative()).points).toBe(-0.67);
    expect(gradedNow(single, { selected: [] }, 3, negative()).points).toBe(0);
    expect(gradedNow(single, null, 3, negative()).points).toBe(0);
  });

  it("grades several choices on a single question as a wrong answer, never a hedge", () => {
    // [key, distractor]: 1 - 1/3 unguarded; a wrong answer, −1/3, instead.
    expect(gradedNow(single, { selected: [0, 1] }, 3, negative()).points).toBe(-1);
    expect(gradedNow(single, { selected: [0, 1, 2, 3] }, 3, negative()).points).toBe(-1);
    expect(gradedNow(single, { selected: [0, 1] }, 3, withPolicy("symmetric")).points).toBe(0);
  });

  it("scores a multiple answer c/C - w/W without the floor", () => {
    const config = multipleConfig({ policy: "ripkey" });
    expect(gradedNow(config, { selected: [2, 3] }, 4, negative()).points).toBe(-4);
    expect(gradedNow(config, { selected: [2] }, 4, negative()).points).toBe(-2);
    expect(gradedNow(config, { selected: [0, 2] }, 4, negative()).points).toBe(0);
    expect(gradedNow(config, { selected: [0] }, 4, negative()).points).toBe(2);
    expect(gradedNow(config, { selected: [0, 1] }, 4, negative()).points).toBe(4);
  });

  it("overrides the question's policy and the evaluation's alike", () => {
    for (const policy of ["inherit", "all_or_nothing", "true_false", "discordance", "symmetric", "ripkey"] as const) {
      const config = multipleConfig({ policy });
      expect(fractionOf(config, [2, 3], 1, negative("true_false")), policy).toBe(-1);
    }
  });

  it("records that the negative rule scored the answer", () => {
    const result = gradedNow(single, { selected: [0] }, 1, negative());
    expect(result.details.negativeMarking).toBe(true);
    expect(result.details.fraction).toBeCloseTo(-1 / 3, 10);
    expect(mcqServer.detailsSchema.safeParse(result.details).success).toBe(true);
    expect(gradedNow(single, { selected: [0] }, 1, withPolicy("symmetric")).details).not.toHaveProperty(
      "negativeMarking",
    );
  });

  it("is off when the evaluation says false, or nothing", () => {
    expect(fractionOf(single, [0], 1, { mcq: { policy: "symmetric", negativeMarking: false } })).toBe(0);
    expect(fractionOf(single, [0], 1)).toBe(0);
  });
});
