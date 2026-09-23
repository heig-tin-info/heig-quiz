/**
 * The parameterised sentences used to be FUNCTIONS; they are templates now,
 * filled by `fmt` / `plural` (`@quiz/core/client`). This suite pins that the
 * move changed no text: each former function is kept here verbatim and its
 * output compared with the template's, for two inputs (both branches of a
 * count-dependent one).
 */
import { describe, expect, it } from "vitest";

import { fmt, plural } from "@quiz/core/client";

import { EDITOR_STRINGS, PLAYER_STRINGS, REVIEW_STRINGS } from "./strings.js";

type Arg = string | number;
type Row = [
  dict: Record<string, string>,
  key: string,
  params: string[],
  before: (...args: never[]) => string,
  samples: Arg[][],
];

const E = EDITOR_STRINGS as unknown as Record<string, string>;
const P = PLAYER_STRINGS as unknown as Record<string, string>;
const R = REVIEW_STRINGS as unknown as Record<string, string>;

const ROWS: Row[] = [
  [E, "lockedRegions", ["n"], (n: number) => (n === 1 ? "1 locked region" : `${n} locked regions`), [[1], [3]]],
  [E, "tryResult", ["passed", "total"], (passed: number, total: number) => `${passed} of ${total} cases pass.`, [[2, 3], [0, 1]]],
  [E, "case", ["n"], (n: number) => `Case ${n}`, [[1], [12]]],
  [E, "removeCase", ["name"], (name: string) => `Remove the case ${name}`, [["stdin"], ["big input"]]],
  [E, "totalPoints", ["n"], (n: number) => (n === 1 ? "1 point in total" : `${n} points in total`), [[1], [4.5]]],
  [P, "editableRegion", ["n"], (n: number) => `Your code, region ${n}`, [[1], [2]]],
  [
    P,
    "hiddenCases",
    ["count", "points"],
    (count: number, points: number) =>
      count === 1
        ? `1 hidden case, worth ${points} point(s).`
        : `${count} hidden cases, worth ${points} point(s) in total.`,
    [[1, 2], [3, 6]],
  ],
  [P, "command", ["args"], (args: string) => `$ program ${args}`, [["-v 3"], [""]]],
  [P, "exitMismatch", ["got", "want"], (got: string, want: number) => `exit ${got} ≠ ${want}`, [["1", 0], ["139", 2]]],
  [P, "limits", ["timeMs", "memoryMb"], (timeMs: number, memoryMb: number) => `${timeMs} ms · ${memoryMb} MB`, [[2000, 128], [500, 64]]],
  [P, "exitCode", ["code"], (code: string) => `exit ${code}`, [["0"], ["1"]]],
  [R, "score", ["points", "max"], (points: number, max: number) => `${points} / ${max} points`, [[2, 3], [0, 1.5]]],
  [R, "exitMismatch", ["got", "want"], (got: string, want: number) => `exit ${got} ≠ ${want}`, [["1", 0], ["139", 2]]],
  [R, "hiddenSummary", ["passed", "count"], (passed: number, count: number) => `Hidden cases: ${passed} of ${count} passed.`, [[1, 2], [0, 5]]],
];

describe("the parameterised strings of the code type", () => {
  for (const [dict, key, params, before, samples] of ROWS) {
    it(`${key} renders as the function did`, () => {
      for (const args of samples) {
        const vars = Object.fromEntries(params.map((name, i) => [name, args[i]!]));
        const after =
          `${key}.one` in dict ? plural(dict, key, args[0] as number, vars) : fmt(dict[key]!, vars);
        expect(after, `${key}(${args.join(", ")})`).toBe((before as (...a: Arg[]) => string)(...args));
      }
    });
  }
});
