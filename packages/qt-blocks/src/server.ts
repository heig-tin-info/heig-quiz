/**
 * `@quiz/qt-blocks/server` — the server half of the `blocks` type, shown as
 * "Blocks" / « Blocs » (docs/spec/04 §4.17, ADR-103).
 *
 * NOTHING in this module's import graph may reach React or Blockly: the API
 * and the grading worker load it. The program is our own syntax tree and the
 * run is `@quiz/domain/blocks`.
 */
import { reparseMigrate, type PublicationIssue, type QuestionTypeServer } from "@quiz/core/server";
import { programStats } from "@quiz/domain/blocks";

import { answerMisfit, gradeBlocks, runCase, studentDetails } from "./grade.js";
import {
  BLOCKS_CONFIG_VERSION,
  BlocksAnswer,
  BlocksConfig,
  BlocksDetails,
  BlocksSolution,
  BlocksStudent,
  emptyBlocksDraft,
  isBlocksAnswered,
  totalCasePoints,
  type BlocksSolution as BlocksSolutionT,
} from "./schema.js";

export const blocksServer: QuestionTypeServer<
  BlocksConfig,
  BlocksAnswer,
  BlocksStudent,
  BlocksSolutionT,
  BlocksDetails
> = {
  id: "blocks",
  configVersion: BLOCKS_CONFIG_VERSION,

  configSchema: BlocksConfig,
  answerSchema: BlocksAnswer,
  isAnswered: isBlocksAnswered,
  studentSchema: BlocksStudent,
  solutionSchema: BlocksSolution,
  detailsSchema: BlocksDetails,

  emptyDraft: emptyBlocksDraft,

  migrate: reparseMigrate("blocks", BlocksConfig, BLOCKS_CONFIG_VERSION),

  /** The warehouses carry the weight of the question; a teacher may still override it. */
  defaultPoints(config) {
    const total = totalCasePoints(config.cases);
    return total > 0 ? total : 1;
  },

  /** Nothing to shuffle: the warehouses are the teacher's, in the teacher's order. */
  shuffleable: () => false,

  /**
   * The reference is mandatory at publication, not for a draft (ADR-103 §3),
   * and must reach the dock on EVERY warehouse, hidden ones included: an
   * unsolvable map — a walled-in dock, a battery too small — is caught here,
   * before a student meets it.
   */
  publicationIssues(config): PublicationIssue[] {
    const reference = config.referenceSolution;
    if (reference === null || reference.length === 0) {
      return [{ path: ["referenceSolution"], message: "blocks.reference_missing" }];
    }
    return config.cases.flatMap((kase, i) =>
      runCase(reference, kase, { events: false }).ok
        ? []
        : [{ path: ["cases", i], message: "blocks.reference_fails_case" }],
    );
  },

  /**
   * THE single content exit (invariant 4): the visible warehouses whole, the
   * hidden ones as a count and their points. No `referenceSolution` key, no
   * container of hidden cases, no hidden name, map or battery.
   */
  toStudent(config) {
    const visible = config.cases.filter((c) => c.visible);
    const hidden = config.cases.filter((c) => !c.visible);
    return {
      prompt: config.prompt,
      world: { kind: config.world.kind },
      toolbox: [...config.toolbox],
      starter: config.starter,
      visibleCases: visible.map((c) => ({ name: c.name, map: [...c.map], battery: c.battery, points: c.points })),
      hiddenCount: hidden.length,
      hiddenPoints: totalCasePoints(hidden),
      allOrNothing: config.allOrNothing,
    };
  },

  /** The key (amendment D17): the reference and every warehouse, hidden ones included. */
  toSolution(config) {
    return {
      referenceSolution: config.referenceSolution,
      cases: config.cases.map((c) => ({
        name: c.name,
        map: [...c.map],
        battery: c.battery,
        points: c.points,
        visible: c.visible,
      })),
    };
  },

  /**
   * Runs only when the key is NOT shown: `filterDetails` (results module)
   * hands the details over whole under `showKey`, and the hidden maps and
   * the reference then come from `toSolution`.
   */
  studentDetails(details, policy): unknown {
    if (policy.showKey) return details;
    return studentDetails(details, { showHiddenCaseNames: policy.showHiddenCaseNames });
  },

  answerMisfit,

  grade: (config, answer, ctx) => gradeBlocks(config, answer, ctx.itemPoints),

  /** The live grid: the size of the program, never its worth (≤ 24 characters). */
  summarizeAnswer(_config, answer) {
    const { nodes } = programStats(answer.program);
    return nodes === 1 ? "1 block" : `${nodes} blocks`;
  },

  /**
   * How many graded attempts reached the dock in each VISIBLE warehouse
   * (F-RES-03), as `code` counts its cases. A hidden warehouse's pass rate
   * would say how hard a map the class never saw is; it stays out.
   */
  aggregate({ details }) {
    const tally = new Map<string, { name: string; passed: number; total: number }>();
    for (const row of details) {
      const parsed = BlocksDetails.safeParse(row);
      if (!parsed.success) continue;
      for (const c of parsed.data.cases) {
        if (!c.visible) continue;
        const acc = tally.get(c.name) ?? { name: c.name, passed: 0, total: 0 };
        acc.total += 1;
        if (c.ok) acc.passed += 1;
        tally.set(c.name, acc);
      }
    }
    return { casePassRate: [...tally.values()] };
  },

  /** Indexed: what a teacher would type to find the question again. */
  searchText: (config) => [config.prompt, ...config.cases.map((c) => c.name)].join("\n"),

  // ADR-080 P3: the statement and the warehouses' names; never a map, a battery nor the reference.
  assistText: {
    fields: [
      { path: "prompt", label: "statement" },
      { path: "cases.*.name", label: "case" },
    ],
  },
};
