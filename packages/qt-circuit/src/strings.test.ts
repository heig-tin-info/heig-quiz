/**
 * The parameterised sentences of the editor, the player, the review and the
 * canvas used to be FUNCTIONS; they are templates now, filled by `fmt` /
 * `plural` (`@quiz/core/client`). This suite pins that the move changed no
 * text: each former function is kept here verbatim and its output compared
 * with the template's, for two inputs (both branches of a count-dependent
 * one).
 */
import { describe, expect, it } from "vitest";

import { fmt, plural } from "@quiz/core/client";

import { CANVAS_STRINGS } from "./canvas/canvasStrings.js";
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
const C = CANVAS_STRINGS as unknown as Record<string, string>;

const ref = (key: string, before: (ref: string) => string): Row => [
  key.startsWith("p.") ? P : R,
  key.slice(2),
  ["ref"],
  before,
  [["R1.2"], ["in"]],
];

const ROWS: Row[] = [
  [E, "stimulus", ["n"], (n: number) => `Stimulus ${n}`, [[1], [7]]],
  [E, "removeStimulus", ["name"], (name: string) => `Remove the stimulus ${name}`, [["step"], ["DC 5 V"]]],
  [E, "totalPoints", ["n"], (n: number) => (n === 1 ? "1 point in total" : `${n} points in total`), [[1], [2.5]]],
  [E, "tryDone", ["n"], (n: number) => (n === 1 ? "1 stimulus simulated." : `${n} stimuli simulated.`), [[1], [3]]],

  [P, "components", ["n", "max"], (n: number, max: number) => `${n} / ${max} components`, [[3, 10], [0, 4]]],
  ref("p.issueFloatingPin", (ref) => `${ref} is not connected.`),
  ref("p.issueUnconnectedPort", (ref) => `The ${ref} port is not connected.`),
  ref("p.issueDanglingWire", (ref) => `A wire ends in the air (${ref}).`),
  ref("p.issueMissingValue", (ref) => `${ref} has no value.`),
  ref("p.issueInvalidValue", (ref) => `${ref}: this value cannot be read.`),
  ref("p.issueValueOutOfRange", (ref) => `${ref}: this value is out of range.`),
  ref("p.issueDuplicateName", (ref) => `Two components are named ${ref}.`),
  ref("p.issueKindNotAllowed", (ref) => `${ref} is not in the palette of this question.`),
  [
    P,
    "hiddenStimuli",
    ["count", "points"],
    (count: number, points: number) =>
      count === 1
        ? `1 hidden stimulus, worth ${points} point(s).`
        : `${count} hidden stimuli, worth ${points} point(s) in total.`,
    [[1, 2], [3, 6]],
  ],
  [P, "srcDc", ["volts"], (volts: string) => `DC ${volts} V`, [["5"], ["-1.2"]]],
  [P, "srcSine", ["amplitude", "frequency"], (amplitude: string, frequency: string) => `Sine ${amplitude} V @ ${frequency}`, [["1", "1kHz"], ["0.5", "50Hz"]]],
  [
    P,
    "srcPulse",
    ["low", "high", "frequency"],
    (low: string, high: string, frequency: string) => `Pulse ${low} → ${high} V @ ${frequency}`,
    [["0", "5", "1kHz"], ["-1", "1", "10Hz"]],
  ],
  [
    P,
    "srcStep",
    ["from", "to", "atMs"],
    (from: string, to: string, atMs: string) => `Step ${from} → ${to} V at ${atMs} ms`,
    [["0", "5", "1"], ["5", "0", "0.5"]],
  ],
  [P, "loadResistor", ["value"], (value: string) => `load ${value}Ω`, [["10k"], ["1M"]]],
  [P, "loadCapacitor", ["value"], (value: string) => `load ${value}F`, [["100n"], ["1u"]]],
  [P, "window", ["ms"], (ms: string) => `${ms} ms`, [["10"], ["0.5"]]],
  [P, "plot", ["name"], (name: string) => `Output — ${name}`, [["step"], ["sine 1 kHz"]]],

  [R, "score", ["points", "max"], (points: number, max: number) => `${points} / ${max} points`, [[2, 3], [0, 1.5]]],
  [R, "netSummary", ["components", "nets"], (components: number, nets: number) => `Components: ${components} · Nets: ${nets}`, [[4, 5], [0, 1]]],
  ref("r.issueFloatingPin", (ref) => `${ref} was not connected.`),
  ref("r.issueUnconnectedPort", (ref) => `The ${ref} port was not connected.`),
  ref("r.issueDanglingWire", (ref) => `A wire ended in the air (${ref}).`),
  ref("r.issueMissingValue", (ref) => `${ref} had no value.`),
  ref("r.issueInvalidValue", (ref) => `${ref}: this value could not be read.`),
  ref("r.issueValueOutOfRange", (ref) => `${ref}: this value was out of range.`),
  ref("r.issueDuplicateName", (ref) => `Two components were named ${ref}.`),
  ref("r.issueKindNotAllowed", (ref) => `${ref} was not in the palette of this question.`),
  [R, "hiddenStimulus", ["n"], (n: number) => `#${n}`, [[1], [2]]],
  [R, "errorPercent", ["percent"], (percent: string) => `${percent} %`, [["1.5"], ["12"]]],

  [C, "componentCount", ["used", "max"], (used: number, max: number) => `${used} / ${max}`, [[3, 10], [0, 4]]],
  [C, "paletteFull", ["max"], (max: number) => `You may place ${max} components.`, [[10], [1]]],
  [
    C,
    "hintSelection",
    ["n"],
    (n: number) =>
      n === 1
        ? "1 item selected. Drag to move, R to rotate, H or V to mirror."
        : `${n} items selected. Drag to move, R to rotate, H or V to mirror.`,
    [[1], [4]],
  ],
  [C, "hintPlace", ["kind"], (kind: string) => `${kind}: click to place, R to rotate, H or V to mirror, Escape to stop.`, [["Resistor"], ["Op-amp"]]],
  [C, "cursor", ["x", "y"], (x: number, y: number) => `x ${x}  y ${y}`, [[3, 4], [-1, 0]]],
];

describe("the parameterised strings of the circuit type", () => {
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
