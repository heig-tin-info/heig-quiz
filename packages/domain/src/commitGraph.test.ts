import { describe, expect, it } from "vitest";

import { commitReceiptTimes, reachableCommits, type GraphCommit } from "./commitGraph.js";

// a ← b ← c ← m (merge of c and f) ; b ← f (a side branch); x unrelated, its parent outside the list.
const COMMITS: GraphCommit[] = [
  { sha: "m", parents: ["c", "f"] },
  { sha: "f", parents: ["b"] },
  { sha: "c", parents: ["b"] },
  { sha: "b", parents: ["a"] },
  { sha: "a", parents: [] },
  { sha: "x", parents: ["gone"] },
];
const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 8, minute));

describe("reachableCommits", () => {
  it("walks the parents of every head, through a merge, and stops outside the list", () => {
    expect([...reachableCommits(COMMITS, ["b"])].sort()).toEqual(["a", "b"]);
    expect([...reachableCommits(COMMITS, ["m"])].sort()).toEqual(["a", "b", "c", "f", "m"]);
    expect([...reachableCommits(COMMITS, ["x", "unknown"])]).toEqual(["x"]);
  });
});

describe("commitReceiptTimes", () => {
  it("dates each commit by the earliest push that carried it, whatever the order of the receipts", () => {
    const times = commitReceiptTimes(COMMITS, [
      { headSha: "m", receivedAt: at(30) },
      { headSha: "c", receivedAt: at(10) },
      { headSha: "f", receivedAt: at(20) },
    ]);
    expect(Object.fromEntries([...times].map(([sha, d]) => [sha, d.getUTCMinutes()]))).toEqual({ a: 10, b: 10, c: 10, f: 20, m: 30 });
  });

  it("leaves a commit no receipt reaches without a time", () => {
    expect(commitReceiptTimes(COMMITS, [{ headSha: "b", receivedAt: at(5) }]).has("x")).toBe(false);
    expect(commitReceiptTimes(COMMITS, []).size).toBe(0);
  });
});
