/**
 * The grading truth table, exercised THROUGH `mcqServer.grade()` (PLAN-MVP §8
 * WP2): the policies themselves are proven in `@quiz/domain`, what is proven
 * here is that the type maps an answer onto them and onto the item scale.
 */
import { isGraded } from "@quiz/core/server";
import { describe, expect, it } from "vitest";
import { gradeContext, multipleConfig } from "./fixtures.js";
import { McqConfigSchema, type McqAnswer, type McqConfig } from "./schema.js";
import { mcqServer } from "./server.js";

/** The mcq grader is synchronous and always final; anything else is a bug. */
function gradedNow(config: McqConfig, answer: McqAnswer | null, points: number) {
  const result = mcqServer.grade(config, answer, gradeContext(points));
  if (result instanceof Promise) throw new Error("the mcq grader must be synchronous");
  if (!isGraded(result)) throw new Error("the mcq grader must never return a pending result");
  return result;
}

function fractionOf(config: McqConfig, selected: number[] | null, points = 10): number {
  return gradedNow(config, selected === null ? null : { selected }, points).details.fraction;
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

describe("the three policies through grade()", () => {
  // C = 2 keys, W = 2 distractors; `penalized` is measured at penalty 0.5, the
  // only setting where it differs from `partial` on this fixture.
  const expected: Record<string, number[]> = {
    // nothing, null, both keys, one key, key+distractor, everything
    all_or_nothing: [0, 0, 1, 0, 0, 0],
    partial: [0, 0, 1, 0.5, 0, 0],
    penalized: [0, 0, 1, 0.5, 0.25, 0.5],
  };

  for (const policy of ["all_or_nothing", "partial", "penalized"] as const) {
    const config = multipleConfig({ policy, penalty: policy === "penalized" ? 0.5 : 1 });
    SELECTIONS.forEach(([name, selected], i) => {
      it(`${policy}: ${name}`, () => {
        expect(fractionOf(config, selected)).toBeCloseTo(expected[policy]![i]!, 10);
      });
    });
  }
});

describe("the fraction reaches the item scale", () => {
  it("multiplies by itemPoints and rounds to two decimals", () => {
    const config = multipleConfig({ policy: "partial" });
    const result = gradedNow(config, { selected: [0] }, 3);
    expect(result.points).toBe(1.5);
    expect(result.maxPoints).toBe(3);
  });

  it("is born validated: nothing here needs a teacher's eyes", () => {
    expect(gradedNow(multipleConfig(), { selected: [0, 1] }, 1).state).toBe("validated");
  });

  it("gives 0 to an unanswered question (F-GRADE-01)", () => {
    const result = gradedNow(multipleConfig(), null, 5);
    expect(result.points).toBe(0);
    expect(result.details.selected).toEqual([]);
  });
});

describe("the floor and the ceiling", () => {
  it("clamps at 0 unless allowNegative", () => {
    const config = multipleConfig({ policy: "penalized", penalty: 1 });
    expect(fractionOf(config, [2, 3])).toBe(0);
  });

  it("goes down to -1 with allowNegative, and the points follow", () => {
    const config = multipleConfig({ policy: "penalized", penalty: 1, allowNegative: true });
    expect(fractionOf(config, [2, 3])).toBe(-1);
    expect(gradedNow(config, { selected: [2, 3] }, 4).points).toBe(-4);
  });

  it("applies the penalty factor", () => {
    const config = multipleConfig({ policy: "penalized", penalty: 0.5 });
    // c/C = 1/2, w/W = 1/2 penalised at 0.5 => 0.5 - 0.25
    expect(fractionOf(config, [0, 2])).toBeCloseTo(0.25, 10);
  });
});

describe("maxSelections", () => {
  const config = multipleConfig({ policy: "partial", maxSelections: 1 });

  it("truncates instead of refusing, and says so in the details", () => {
    const result = gradedNow(config, { selected: [0, 1] }, 2);
    expect(result.details.selected).toEqual([0]);
    expect(result.details.truncated).toBe(true);
  });

  it("leaves a payload within the limit alone", () => {
    expect(gradedNow(config, { selected: [1] }, 2).details.truncated).toBe(false);
  });
});

describe("the details", () => {
  it("carry the counts the teacher panel shows", () => {
    const result = gradedNow(multipleConfig(), { selected: [0, 2, 2] }, 1);
    expect(result.details).toMatchObject({
      policy: "partial",
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

describe("a single-answer question", () => {
  const config = McqConfigSchema.parse({
    configVersion: 1,
    prompt: "What is `p + 1`?",
    choices: [
      { text: "0x1001", correct: false },
      { text: "0x1004", correct: true },
      { text: "0x1008", correct: false },
    ],
  });

  it("is all or nothing", () => {
    expect(fractionOf(config, [1])).toBe(1);
    expect(fractionOf(config, [0])).toBe(0);
    expect(fractionOf(config, [0, 1])).toBe(0);
  });
});
