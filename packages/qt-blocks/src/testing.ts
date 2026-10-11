/**
 * `@quiz/qt-blocks/testing` — the full configuration of the leak test
 * (invariant 4, docs/spec/05 §5.7, spec 4.17). TEST-ONLY: nothing in
 * `apps/*` imports it.
 */
import type { StudentLeakFixture } from "@quiz/core/testing";

import { BlocksConfig } from "./schema.js";

/** The wall follower of the spec's example: it solves every warehouse below. */
const REFERENCE = [
  {
    kind: "repeat_until_dock",
    body: [
      {
        kind: "if_sensor",
        sensor: "free",
        where: "front",
        then: [{ kind: "forward" }],
        else: [{ kind: "turn", dir: "right" }],
      },
    ],
  },
];

/**
 * Two visible warehouses and two hidden ones, each hidden one with rows,
 * a name and a battery that appear nowhere in the visible ones, and a
 * starter that shares nothing with the reference.
 */
export const SECRET_CONFIG: BlocksConfig = BlocksConfig.parse({
  configVersion: 1,
  prompt: "Bring the robot to the dock without hitting a rack.",
  world: { kind: "warehouse" },
  toolbox: ["forward", "turn", "repeat", "repeat_until_dock", "if_sensor"],
  starter: [{ kind: "repeat", times: 7, body: [{ kind: "forward" }] }],
  referenceSolution: REFERENCE,
  cases: [
    { name: "Clear aisle", map: ["..#..#..", "........", ">......D", "...#..#."], battery: 40, visible: true, points: 1 },
    { name: "Rack on the aisle", map: ["......D", ">..#...", "......."], battery: 40, visible: true, points: 1 },
    { name: "Hidden north-east", map: ["^...D", ".#.#.", "....."], battery: 23, visible: false, points: 2 },
    {
      name: "Trapped corridor",
      map: ["........", "..#..#..", "...#.#..", ">.##...D", "........"],
      battery: 61,
      visible: false,
      points: 3,
    },
  ],
  allOrNothing: false,
});

/**
 * The key of a `blocks` question is the reference and the hidden warehouses
 * (amendment D7'): the hidden maps' distinctive rows (maps travel as rows),
 * their names, their batteries as they serialize, and the reference itself.
 */
export const blocksLeakFixture: StudentLeakFixture<BlocksConfig> = {
  config: SECRET_CONFIG,
  forbiddenKeys: ["hiddenCases", "cases", "trail"],
  secrets: [
    "^...D",
    ".#.#.",
    ">.##...D",
    "...#.#..",
    "Hidden north-east",
    "Trapped corridor",
    '"battery":23',
    '"battery":61',
    JSON.stringify(SECRET_CONFIG.referenceSolution),
  ],
};
