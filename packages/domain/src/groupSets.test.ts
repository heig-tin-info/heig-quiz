import { describe, expect, it } from "vitest";

import {
  copyFollows,
  defaultGroupName,
  defaultSetName,
  duplicateSetName,
  formRandomGroups,
  freeName,
  freeSlug,
  groupSizes,
  groupSyncPlan,
  isEmptyPlan,
  planReachesRepoGroup,
  type CopyState,
  type SetState,
} from "./groupSets.js";

describe("groupSizes (ADR-070 §3)", () => {
  it("cuts 23 by 3 into seven of 3 and one of 2, or five of 3 and two of 4", () => {
    expect(groupSizes(23, 3, "smaller")).toEqual([3, 3, 3, 3, 3, 3, 3, 2]);
    expect(groupSizes(23, 3, "larger")).toEqual([4, 4, 3, 3, 3, 3, 3]);
  });

  it("cuts 10 by 4 into 4, 3, 3 (never 4, 4, 2), or 5, 5", () => {
    expect(groupSizes(10, 4, "smaller")).toEqual([4, 3, 3]);
    expect(groupSizes(10, 4, "larger")).toEqual([5, 5]);
  });

  it("goes further than one from the size at the edges", () => {
    expect(groupSizes(5, 3, "larger")).toEqual([5]);
    expect(groupSizes(7, 5, "smaller")).toEqual([4, 3]);
    expect(groupSizes(3, 3, "larger")).toEqual([3]);
    expect(groupSizes(4, 1, "smaller")).toEqual([1, 1, 1, 1]);
    expect(groupSizes(0, 3, "smaller")).toEqual([]);
  });

  it("is balanced and sums to n, in the number of groups each rule names", () => {
    for (let n = 1; n <= 60; n++) {
      for (let size = 1; size <= n; size++) {
        for (const remainder of ["smaller", "larger"] as const) {
          const sizes = groupSizes(n, size, remainder);
          const label = `${n} by ${size}, ${remainder}`;
          expect(sizes.reduce((a, b) => a + b, 0), label).toBe(n);
          expect(Math.max(...sizes) - Math.min(...sizes), label).toBeLessThanOrEqual(1);
          expect(sizes.length, label).toBe(remainder === "smaller" ? Math.ceil(n / size) : Math.max(1, Math.floor(n / size)));
        }
      }
    }
  });
});

describe("formRandomGroups", () => {
  const students = Array.from({ length: 23 }, (_, i) => `s${i}`);

  it("places every student once, in groups of the sizes of the rule", () => {
    let seed = 7;
    const randomInt = (max: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % max;
    const groups = formRandomGroups(students, 3, "larger", randomInt);
    expect(groups.map((g) => g.length)).toEqual([4, 4, 3, 3, 3, 3, 3]);
    expect(groups.flat().sort()).toEqual([...students].sort());
  });

  it("shuffles with the randomness it is given", () => {
    const identity = formRandomGroups(["a", "b", "c", "d"], 2, "smaller", (max) => max - 1);
    expect(identity).toEqual([["a", "b"], ["c", "d"]]);
    const swapped = formRandomGroups(["a", "b", "c", "d"], 2, "smaller", () => 0);
    expect(swapped.flat().sort()).toEqual(["a", "b", "c", "d"]);
    expect(swapped.flat()).not.toEqual(["a", "b", "c", "d"]);
    expect(formRandomGroups([], 3, "smaller", () => 0)).toEqual([]);
  });
});

describe("copyFollows (ADR-070 §4)", () => {
  it("follows until the groups stop", () => {
    expect(copyFollows({ groupsStoppedAt: null })).toBe(true);
    expect(copyFollows({ groupsStoppedAt: new Date("2026-10-04T10:00:00Z") })).toBe(false);
  });
});

describe("groupSyncPlan (ADR-070 §4)", () => {
  const set = (groups: [string, string][], members: [string, string][] = []): SetState => ({
    groups: groups.map(([id, name], position) => ({ id, name, position })),
    members: members.map(([enrollmentId, groupId]) => ({ enrollmentId, groupId })),
  });
  const copyOf = (groups: [string, string, string | null, string?][], members: [string, string][] = []): CopyState => ({
    groups: groups.map(([id, name, sourceGroupId, slug], position) => ({ id, name, slug: slug ?? name.toLowerCase().replace(/ /g, "-"), position, sourceGroupId })),
    members: members.map(([enrollmentId, groupId]) => ({ enrollmentId, groupId })),
  });

  it("makes a whole copy from nothing", () => {
    const plan = groupSyncPlan(set([["g1", "Group 1"], ["g2", "Les Castors!"]], [["e1", "g1"], ["e2", "g2"]]), copyOf([]));
    expect(plan.create).toEqual([
      { sourceGroupId: "g1", name: "Group 1", slug: "group-1", position: 0 },
      { sourceGroupId: "g2", name: "Les Castors!", slug: "les-castors", position: 1 },
    ]);
    expect(plan.place).toEqual([
      { enrollmentId: "e1", sourceGroupId: "g1", from: null },
      { enrollmentId: "e2", sourceGroupId: "g2", from: null },
    ]);
    expect([plan.delete, plan.update, plan.unplace]).toEqual([[], [], []]);
  });

  it("changes nothing on a copy in step", () => {
    const plan = groupSyncPlan(set([["g1", "Group 1"]], [["e1", "g1"]]), copyOf([["c1", "Group 1", "g1"]], [["e1", "c1"]]));
    expect(isEmptyPlan(plan)).toBe(true);
  });

  it("follows a rename, its slug with it", () => {
    const plan = groupSyncPlan(set([["g1", "Les Pandas"]]), copyOf([["c1", "Group 1", "g1"]]));
    expect(plan.update).toEqual([{ id: "c1", name: "Les Pandas", slug: "les-pandas", position: 0 }]);
  });

  it("deletes a copy group whose set group is gone, or that has none", () => {
    const plan = groupSyncPlan(set([["g1", "Group 1"]]), copyOf([["c1", "Group 1", "g1"], ["c2", "Group 2", "gone"], ["c3", "Old", null]], [["e2", "c2"]]));
    expect(plan.delete).toEqual(["c2", "c3"]);
    // Its members leave with it: no separate unplace.
    expect(plan.unplace).toEqual([]);
  });

  it("follows a join, a departure and a move", () => {
    const plan = groupSyncPlan(
      set([["g1", "A"], ["g2", "B"]], [["joins", "g1"], ["moves", "g2"], ["stays", "g1"]]),
      copyOf([["c1", "A", "g1"], ["c2", "B", "g2"]], [["moves", "c1"], ["leaves", "c2"], ["stays", "c1"]]),
    );
    expect(plan.place).toEqual([
      { enrollmentId: "joins", sourceGroupId: "g1", from: null },
      { enrollmentId: "moves", sourceGroupId: "g2", from: "c1" },
    ]);
    expect(plan.unplace).toEqual(["leaves"]);
  });

  it("places the members of a deleted copy group as arrivals", () => {
    const plan = groupSyncPlan(set([["g2", "B"]], [["e1", "g2"]]), copyOf([["c1", "A", "gone"]], [["e1", "c1"]]));
    expect(plan.delete).toEqual(["c1"]);
    expect(plan.create).toEqual([{ sourceGroupId: "g2", name: "B", slug: "b", position: 0 }]);
    expect(plan.place).toEqual([{ enrollmentId: "e1", sourceGroupId: "g2", from: null }]);
  });

  it("disambiguates a slug that clashes, and keeps the slug of a group whose name stays", () => {
    const plan = groupSyncPlan(set([["g1", "Group 2!"], ["g2", "Group 2"]]), copyOf([["c1", "Group 2!", "g1", "group-2"]]));
    expect(plan.create).toEqual([{ sourceGroupId: "g2", name: "Group 2", slug: "group-2-2", position: 1 }]);
    expect(plan.update).toEqual([]);
  });

  it("follows the set's order, keeps one copy group per set group, and slugs a name without letters", () => {
    const plan = groupSyncPlan(
      { groups: [{ id: "g1", name: "A", position: 1 }, { id: "g2", name: "!!!", position: 0 }], members: [] },
      copyOf([["c1", "A", "g1"], ["c2", "A twice", "g1"]]),
    );
    expect(plan.delete).toEqual(["c2"]);
    expect(plan.update).toEqual([{ id: "c1", name: "A", slug: "a", position: 1 }]);
    expect(plan.create).toEqual([{ sourceGroupId: "g2", name: "!!!", slug: "group", position: 0 }]);
  });

  it("keeps a fixed slug (a group with a repository): its name alone follows, and no other group takes the slug", () => {
    const copy: CopyState = {
      groups: [{ id: "c1", name: "Group 1", slug: "group-1", position: 0, sourceGroupId: "g1", slugFixed: true }],
      members: [],
    };
    const plan = groupSyncPlan(set([["g1", "Les Pandas"], ["g2", "Group 1"]]), copy);
    expect(plan.update).toEqual([{ id: "c1", name: "Les Pandas", slug: "group-1", position: 0 }]);
    expect(plan.create).toEqual([{ sourceGroupId: "g2", name: "Group 1", slug: "group-1-2", position: 1 }]);
  });

  it("follows a swap of names (applied through temporary names)", () => {
    const plan = groupSyncPlan(set([["g1", "B"], ["g2", "A"]]), copyOf([["c1", "A", "g1"], ["c2", "B", "g2"]]));
    expect(plan.update).toEqual([
      { id: "c1", name: "B", slug: "b", position: 0 },
      { id: "c2", name: "A", slug: "a", position: 1 },
    ]);
  });
});

describe("planReachesRepoGroup (M3-15b)", () => {
  const set = (groups: [string, string][], members: [string, string][] = []): SetState => ({
    groups: groups.map(([id, name], position) => ({ id, name, position })),
    members: members.map(([enrollmentId, groupId]) => ({ enrollmentId, groupId })),
  });
  // c1 (source g1) has a repository, c2 (source g2) has none.
  const copy = (members: [string, string][]): CopyState => ({
    groups: [
      { id: "c1", name: "A", slug: "a", position: 0, sourceGroupId: "g1", slugFixed: true },
      { id: "c2", name: "B", slug: "b", position: 1, sourceGroupId: "g2" },
    ],
    members: members.map(([enrollmentId, groupId]) => ({ enrollmentId, groupId })),
  });
  const reaches = (s: SetState, c: CopyState, exempt?: Set<string>) => planReachesRepoGroup(c, groupSyncPlan(s, c), exempt);

  it("is reached by a member out, a member in, a move either way, and its deletion", () => {
    const base = copy([["e1", "c1"], ["e2", "c2"]]);
    expect(reaches(set([["g1", "A"], ["g2", "B"]], [["e2", "g2"]]), base)).toBe(true);
    expect(reaches(set([["g1", "A"], ["g2", "B"]], [["e1", "g1"], ["e2", "g1"]]), base)).toBe(true);
    expect(reaches(set([["g1", "A"], ["g2", "B"]], [["e1", "g2"], ["e2", "g2"]]), base)).toBe(true);
    expect(reaches(set([["g2", "B"]], [["e2", "g2"]]), copy([["e2", "c2"]]))).toBe(true);
  });

  it("is not reached by its rename, its position, a group without repository, nor an exempt departure", () => {
    const base = copy([["e1", "c1"], ["e2", "c2"]]);
    expect(reaches(set([["g2", "B"], ["g1", "Renamed"]], [["e1", "g1"], ["e2", "g2"]]), base)).toBe(false);
    expect(reaches(set([["g1", "A"], ["g2", "B"]], [["e1", "g1"]]), base)).toBe(false);
    expect(reaches(set([["g1", "A"], ["g2", "B"]], [["e2", "g2"]]), base, new Set(["e1"]))).toBe(false);
    expect(reaches(set([["g1", "A"]], [["e1", "g1"]]), copy([["e1", "c1"]]))).toBe(false);
  });

  it("is never reached in a copy without repository, and a sourceless group is deleted as any", () => {
    const plain: CopyState = { groups: [{ id: "c2", name: "B", slug: "b", position: 0, sourceGroupId: "g2" }], members: [{ enrollmentId: "e2", groupId: "c2" }] };
    expect(reaches(set([], []), plain)).toBe(false);
    const orphan: CopyState = { groups: [{ id: "c9", name: "Old", slug: "old", position: 0, sourceGroupId: null, slugFixed: true }], members: [] };
    expect(reaches(set([["g1", "A"]]), orphan)).toBe(true);
  });
});

describe("names (ADR-070 §1, §2)", () => {
  it("takes the first free name and slug", () => {
    expect(freeName("Group 1", new Set())).toBe("Group 1");
    expect(freeName("Lab", new Set(["Lab", "Lab 2"]))).toBe("Lab 3");
    expect(freeSlug("lab", new Set(["lab"]))).toBe("lab-2");
  });

  it("names a group with the first free k, in the creator's language", () => {
    expect(defaultGroupName(new Set(["Group 1", "Group 3"]), "en")).toBe("Group 2");
    expect(defaultGroupName(new Set(["Group 1"]), "fr")).toBe("Groupe 1");
  });

  it("names a set after its creation on the school's clock", () => {
    // 12:05 UTC is 14:05 in Zurich in October (summer time).
    const at = new Date("2026-10-04T12:05:00Z");
    expect(defaultSetName(at, "en")).toBe("Groups of 2026-10-04 14:05");
    expect(defaultSetName(at, "fr")).toBe("Groupes du 04.10.2026 14:05");
    expect(defaultSetName(new Date("2026-12-31T23:30:00Z"), "en")).toBe("Groups of 2027-01-01 00:30");
  });

  it("names a duplicated set", () => {
    expect(duplicateSetName("Labo 1", "en")).toBe("Labo 1 (copy)");
    expect(duplicateSetName("Labo 1", "fr")).toBe("Labo 1 (copie)");
  });
});
