import { describe, expect, it } from "vitest";

import type { ProjectCommit } from "@quiz/contracts";

import { graphLayout, topoOrder } from "./commitGraph";

const commit = (sha: string, parents: string[], minute: number): ProjectCommit => ({
  sha,
  parents,
  message: sha,
  authorName: "A",
  authoredAt: new Date(Date.UTC(2026, 9, 1, 8, minute)).toISOString(),
  member: null,
  receivedAt: null,
  mark: null,
});

// a ← b ← c ← m ; b ← f ← m (a feature branch merged), as GitHub may list them: by date, a parent dated after its child.
const MERGE = [
  commit("m", ["c", "f"], 50),
  commit("f", ["b"], 40),
  commit("c", ["b"], 45),
  commit("b", ["a"], 60), // a clock that lied: dated after its children
  commit("a", [], 0),
];

describe("topoOrder", () => {
  it("never puts a parent above a child, newer first among the ready ones", () => {
    expect(topoOrder(MERGE).map((c) => c.sha)).toEqual(["m", "c", "f", "b", "a"]);
  });
});

describe("graphLayout", () => {
  it("draws a merge: the second parent opens a lane, which converges back on the fork", () => {
    const { rows, lanes } = graphLayout(MERGE);
    const at = Object.fromEntries(rows.map((r) => [r.commit.sha, r]));
    expect(lanes).toBe(2);
    expect(at.m).toMatchObject({ col: 0, incoming: [], through: [], outgoing: [0, 1] });
    expect(at.c).toMatchObject({ col: 0, incoming: [0], through: [1], outgoing: [0] });
    expect(at.f).toMatchObject({ col: 1, incoming: [1], through: [0], outgoing: [1] });
    // Both lanes wait for b: they converge on it.
    expect(at.b).toMatchObject({ col: 0, incoming: [0, 1], through: [], outgoing: [0] });
    expect(at.a).toMatchObject({ col: 0, incoming: [0], outgoing: [] });
  });

  it("keeps a straight history in one lane, and ends a line whose parent was not listed", () => {
    const { rows, lanes } = graphLayout([commit("z", ["y"], 2), commit("y", ["cut"], 1)]);
    expect(lanes).toBe(1);
    expect(rows.map((r) => [r.commit.sha, r.col, r.outgoing])).toEqual([
      ["z", 0, [0]],
      ["y", 0, []],
    ]);
  });

  it("gives two branch heads with no common listed ancestor a lane each", () => {
    const { rows, lanes } = graphLayout([commit("p", [], 5), commit("q", [], 4)]);
    expect(lanes).toBe(1);
    expect(rows.map((r) => r.col)).toEqual([0, 0]);
  });
});
