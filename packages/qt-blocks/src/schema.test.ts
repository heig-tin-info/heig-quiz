import { describe, expect, it } from "vitest";

import { BATTERY_MAX, PROGRAM_LIMITS, type Stmt } from "@quiz/domain/blocks";

import {
  BlocksAnswer,
  BlocksConfig,
  emptyBlocksDraft,
  isBlocksAnswered,
  kindsOutside,
  programFits,
  shownProgram,
  storedProgram,
} from "./schema.js";
import { SECRET_CONFIG } from "./testing.js";

const messages = (result: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.message) ?? [];

/** A `repeat` nested `depth` deep around one move, built without recursion. */
function nested(depth: number): Stmt[] {
  let program: Stmt[] = [{ kind: "forward" }];
  for (let i = 0; i < depth; i++) program = [{ kind: "repeat", times: 1, body: program }];
  return program;
}

const config = (patch: Record<string, unknown>) => ({ ...SECRET_CONFIG, ...patch });

describe("the answer schema", () => {
  it("accepts a program within the limits", () => {
    expect(BlocksAnswer.safeParse({ program: nested(PROGRAM_LIMITS.depth - 1) }).success).toBe(true);
    const long = Array.from({ length: PROGRAM_LIMITS.nodes }, (): Stmt => ({ kind: "forward" }));
    expect(BlocksAnswer.safeParse({ program: long }).success).toBe(true);
  });

  it("refuses a program one node or one level too many, with a key", () => {
    const long = Array.from({ length: PROGRAM_LIMITS.nodes + 1 }, (): Stmt => ({ kind: "forward" }));
    expect(messages(BlocksAnswer.safeParse({ program: long }))).toEqual(["blocks.program_too_long"]);
    expect(messages(BlocksAnswer.safeParse({ program: nested(PROGRAM_LIMITS.depth) }))).toEqual(["blocks.program_too_deep"]);
  });

  /*
   * D18: the guard is iterative and runs BEFORE the recursive parse. A body
   * nested 20 000 deep (about 720 KB of JSON, under Fastify's 1 MB) would
   * overflow the stack of a recursive schema; here it is a 422 with a key.
   */
  it("refuses a body nested 20 000 deep without overflowing the stack", () => {
    // Written as the wire carries it: `JSON.stringify` itself recurses.
    const body = `${'{"kind":"repeat","times":1,"body":['.repeat(20_000)}{"kind":"forward"}${"]}".repeat(20_000)}`;
    const wire = `{"program":[${body}]}`;
    expect(wire.length).toBeLessThan(1_000_000);
    expect(messages(BlocksAnswer.safeParse(JSON.parse(wire)))).toEqual(["blocks.program_too_deep"]);
    expect(messages(BlocksAnswer.safeParse({ program: nested(20_000) }))).toEqual(["blocks.program_too_deep"]);
  });

  it("measures malformed nodes too, and refuses them by shape", () => {
    expect(BlocksAnswer.safeParse({ program: [{ kind: "jump" }] }).success).toBe(false);
    expect(BlocksAnswer.safeParse({ program: [{ kind: "repeat", times: 0, body: [] }] }).success).toBe(false);
    expect(BlocksAnswer.safeParse({ program: [{ kind: "repeat", times: 41, body: [] }] }).success).toBe(false);
    expect(BlocksAnswer.safeParse({ program: [{ kind: "repeat", times: 2.5, body: [] }] }).success).toBe(false);
    expect(BlocksAnswer.safeParse({ program: "forward" }).success).toBe(false);
    expect(BlocksAnswer.safeParse({ program: [{ kind: "turn", dir: "up" }] }).success).toBe(false);
  });

  it("drops what a statement does not hold", () => {
    const parsed = BlocksAnswer.parse({ program: [{ kind: "forward", x: 3, y: 4 }] });
    expect(parsed).toEqual({ program: [{ kind: "forward" }] });
  });
});

describe("the config schema", () => {
  it("accepts the full fixture and keeps it as written", () => {
    expect(BlocksConfig.parse(SECRET_CONFIG)).toEqual(SECRET_CONFIG);
  });

  it("refuses an empty draft: no statement, no name (D16)", () => {
    expect(BlocksConfig.safeParse(emptyBlocksDraft()).success).toBe(false);
  });

  it("refuses a map with the key of the domain", () => {
    const withMap = (map: string[]) => config({ cases: [{ ...SECRET_CONFIG.cases[0]!, map }] });
    expect(messages(BlocksConfig.safeParse(withMap([">.D", "...", "..D"])))).toEqual(["blocks.map_two_docks"]);
    expect(messages(BlocksConfig.safeParse(withMap([">.D", "..."])))).toEqual(["blocks.map_too_small"]);
    expect(messages(BlocksConfig.safeParse(withMap([">.D", "...", "..x"])))).toEqual(["blocks.map_bad_char"]);
    expect(BlocksConfig.safeParse(withMap([">.D", "...", "..x"])).error?.issues[0]?.path).toEqual(["cases", 0, "map"]);
  });

  it("holds the battery to 1..BATTERY_MAX and the cases to 1..8 (D14)", () => {
    const withBattery = (battery: number) => config({ cases: [{ ...SECRET_CONFIG.cases[0]!, battery }] });
    expect(BlocksConfig.safeParse(withBattery(BATTERY_MAX)).success).toBe(true);
    for (const battery of [0, BATTERY_MAX + 1, 2.5]) {
      expect(messages(BlocksConfig.safeParse(withBattery(battery)))).toEqual(["blocks.battery_out_of_range"]);
    }
    expect(messages(BlocksConfig.safeParse(config({ cases: [] })))).toEqual(["blocks.no_case"]);
    const nine = Array.from({ length: 9 }, () => SECRET_CONFIG.cases[0]!);
    expect(messages(BlocksConfig.safeParse(config({ cases: nine })))).toEqual(["blocks.too_many_cases"]);
  });

  it("keeps the starter and the reference inside the toolbox (D15)", () => {
    const narrow = config({ toolbox: ["forward", "turn", "repeat"] });
    expect(messages(BlocksConfig.safeParse(narrow))).toEqual(["blocks.reference_outside_toolbox"]);
    const starter = config({ toolbox: ["forward", "turn", "repeat_until_dock", "if_sensor"] });
    expect(BlocksConfig.safeParse(starter).error?.issues).toEqual([
      expect.objectContaining({ message: "blocks.starter_outside_toolbox", path: ["starter"] }),
    ]);
  });

  it("holds the starter and the reference to the program limits, depth first (D18)", () => {
    expect(messages(BlocksConfig.safeParse(config({ starter: nested(20_000) })))).toEqual(["blocks.program_too_deep"]);
    expect(messages(BlocksConfig.safeParse(config({ referenceSolution: nested(20_000) })))).toEqual([
      "blocks.program_too_deep",
    ]);
  });

  it("fills the defaults of an authored config", () => {
    const { world: _w, toolbox: _t, starter: _s, referenceSolution: _r, allOrNothing: _a, ...bare } = SECRET_CONFIG;
    const parsed = BlocksConfig.parse(bare);
    expect(parsed).toMatchObject({
      world: { kind: "warehouse" },
      toolbox: ["forward", "turn", "repeat", "repeat_until_dock", "if_sensor"],
      starter: [],
      referenceSolution: null,
      allOrNothing: false,
    });
  });
});

describe("programFits, the player's check before it sends", () => {
  it("says what the schema says", () => {
    expect(programFits(nested(PROGRAM_LIMITS.depth - 1))).toBe(true);
    expect(programFits(nested(PROGRAM_LIMITS.depth))).toBe(false);
    expect(programFits(Array.from({ length: PROGRAM_LIMITS.nodes + 1 }, (): Stmt => ({ kind: "forward" })))).toBe(false);
  });
});

describe("the starter is no answer (ADR-103 §10, spec 4.17)", () => {
  const starter = SECRET_CONFIG.starter;
  const other: Stmt[] = [{ kind: "forward" }];

  it("stores the starter as the empty program, anything else as it is", () => {
    expect(storedProgram(starter, starter)).toEqual([]);
    expect(storedProgram(structuredClone(starter), starter)).toEqual([]);
    expect(storedProgram(other, starter)).toBe(other);
    expect(storedProgram([], [])).toEqual([]);
  });

  it("shows the starter for no answer and for the empty program, the program otherwise", () => {
    expect(shownProgram(null, starter)).toBe(starter);
    expect(shownProgram({ program: [] }, starter)).toBe(starter);
    expect(shownProgram({ program: other }, starter)).toBe(other);
  });

  it("round-trips: what is shown is stored back unchanged, and an untouched question is unanswered", () => {
    for (const answer of [null, { program: [] }, { program: other }]) {
      const stored = { program: storedProgram(shownProgram(answer, starter), starter) };
      expect(shownProgram(stored, starter)).toEqual(shownProgram(answer, starter));
    }
    expect(isBlocksAnswered({ program: storedProgram(shownProgram(null, starter), starter) })).toBe(false);
  });

  it("counts a starter sent as such: a client that bypasses the player is answered", () => {
    expect(isBlocksAnswered({ program: starter })).toBe(true);
  });
});

describe("isBlocksAnswered and kindsOutside", () => {
  it("answers only for a program that holds a block", () => {
    expect(isBlocksAnswered({ program: [] })).toBe(false);
    expect(isBlocksAnswered({ program: [{ kind: "forward" }] })).toBe(true);
  });

  it("lists the kinds a program uses beyond a toolbox, in toolbox order", () => {
    expect(kindsOutside(SECRET_CONFIG.referenceSolution!, ["forward"])).toEqual(["turn", "repeat_until_dock", "if_sensor"]);
    expect(kindsOutside(SECRET_CONFIG.referenceSolution!, SECRET_CONFIG.toolbox)).toEqual([]);
  });
});
