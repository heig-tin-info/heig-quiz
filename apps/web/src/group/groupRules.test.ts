import { describe, expect, it } from "vitest";

import { GROUP_REFUSALS, type GroupConsequence } from "@quiz/contracts";

import { ApiError } from "../api";
import { en } from "../i18n/en";
import { fr } from "../i18n/fr";
import { GROUP_1, GROUP_2, makeSet, student } from "../test/group-fixtures";
import {
  consequencesByProject,
  defaultRandomSize,
  gone,
  groupRefusalMessage,
  needsConfirmation,
  overMax,
  placeOf,
  projectsRefusal,
  resyncSections,
  sizesSummary,
  stepZone,
  withMove,
  WriteHeld,
} from "./groupRules";

/** A translator over a dictionary, `{var}` replaced, as `useT` does. */
const tr = (dict: Record<string, string>) => (key: string, vars: Record<string, string | number> = {}) =>
  (dict[key] ?? key).replace(/\{(\w+)\}/g, (_, v: string) => String(vars[v] ?? ""));

describe("where a student is, and the optimistic move", () => {
  it("finds a student in a group, in none, or not in the set", () => {
    const set = makeSet();
    expect(placeOf(set, student(0).enrollmentId)).toBe(GROUP_1);
    expect(placeOf(set, student(2).enrollmentId)).toBeNull();
    expect(placeOf(set, "0190d3c4-0000-7000-8000-00000000e999")).toBeUndefined();
  });

  it("moves a student into a group in name order, out of every group, and ignores an unknown group", () => {
    const set = makeSet();
    const moved = withMove(set, student(4).enrollmentId, GROUP_1);
    expect(moved.groups[0]!.members.map((s) => s.prenom)).toEqual(["Alice", "Benoît", "Emma"]);
    expect(moved.unplaced.map((s) => s.prenom)).toEqual(["Chloé", "David"]);
    const out = withMove(moved, student(0).enrollmentId, null);
    expect(out.unplaced.map((s) => s.prenom)).toEqual(["Alice", "Chloé", "David"]);
    expect(withMove(set, student(0).enrollmentId, "0190d3c4-0000-7000-8000-00000000b999")).toBe(set);
    expect(placeOf(withMove(set, student(0).enrollmentId, GROUP_2), student(0).enrollmentId)).toBe(GROUP_2);
  });

  it("flags a group above the maximum, never one without a maximum", () => {
    expect(overMax(5, 4)).toBe(true);
    expect(overMax(4, 4)).toBe(false);
    expect(overMax(40, null)).toBe(false);
  });
});

describe("the random formation's preview", () => {
  it("counts the sizes as the server will cut them (ADR-070 §3)", () => {
    expect(sizesSummary(23, 3, "smaller")).toEqual([{ size: 3, count: 7 }, { size: 2, count: 1 }]);
    expect(sizesSummary(23, 3, "larger")).toEqual([{ size: 4, count: 2 }, { size: 3, count: 5 }]);
    expect(sizesSummary(10, 4, "smaller")).toEqual([{ size: 4, count: 1 }, { size: 3, count: 2 }]);
    expect(sizesSummary(3, 4, "smaller")).toEqual([]);
  });

  it("opens on the set's maximum, else pairs, never above the students to place", () => {
    expect(defaultRandomSize(23, 4)).toBe(4);
    expect(defaultRandomSize(23, null)).toBe(2);
    expect(defaultRandomSize(3, 4)).toBe(3);
    expect(defaultRandomSize(1, null)).toBe(1);
  });
});

describe("the refusals, worded in both languages", () => {
  it.each(GROUP_REFUSALS)("words %s through the dictionary", (code) => {
    const error = new ApiError(409, { error: code, message: "server words", max: 3 });
    for (const dict of [en, fr] as Record<string, string>[]) {
      const said = groupRefusalMessage(error, tr(dict) as never);
      expect(said).not.toBe("server words");
      expect(Object.values(dict)).toContain(said.replace("3", "{max}"));
    }
  });

  it("never says the server's English: a 404 is something no longer in the set, anything else the generic failure", () => {
    expect(groupRefusalMessage(new ApiError(404, { message: "Not found" }), tr(en) as never)).toBe(en["groups.gone"]);
    expect(groupRefusalMessage(new ApiError(404, { message: "Not found" }), tr(fr) as never)).toBe(fr["groups.gone"]);
    expect(groupRefusalMessage(new ApiError(500, { message: "boom" }), tr(en) as never)).toBe(en["error.save"]);
  });

  it("reads the projects of set_in_use and has_repo (GroupRefusalProjects), and a 404 as an Undo whose group is gone", () => {
    const projects = [{ id: "0190d3c4-0000-7000-8000-0000000000b4", name: "Labo 4" }];
    for (const code of ["set_in_use", "has_repo"] as const) {
      expect(projectsRefusal(new ApiError(409, { error: code, message: "x", projects }))).toEqual({ code, projects });
    }
    expect(projectsRefusal(new ApiError(409, { error: "duplicate_name" }))).toBeNull();
    expect(gone(new ApiError(404, { message: "Not found" }))).toBe(true);
    expect(gone(new ApiError(409, { error: "classroom_archived" }))).toBe(false);
  });
});

describe("the keyboard drag's walk of the zones", () => {
  it("goes to the next zone on → and ↓, the previous on ← and ↑, held at the ends", () => {
    expect(stepZone(4, 0, "ArrowRight")).toBe(1);
    expect(stepZone(4, 1, "ArrowDown")).toBe(2);
    expect(stepZone(4, 3, "ArrowRight")).toBe(3);
    expect(stepZone(4, 2, "ArrowLeft")).toBe(1);
    expect(stepZone(4, 0, "ArrowUp")).toBe(0);
    expect(stepZone(4, 0, "KeyA")).toBeNull();
  });
});

describe("the GitHub consequences of a write (ADR-070 §6, M3-16b)", () => {
  const P1 = "0190d3c4-0000-7000-8000-0000000000b4";
  const P2 = "0190d3c4-0000-7000-8000-0000000000b5";
  const c = (n: number, kind: "lose" | "join", over: Partial<GroupConsequence> = {}): GroupConsequence => ({
    projectId: P1,
    projectName: "Labo 4",
    groupId: GROUP_1,
    groupName: "Groupe 1",
    repo: "org/labo-4-groupe-1",
    enrollmentId: student(n).enrollmentId,
    nom: student(n).nom,
    prenom: student(n).prenom,
    kind,
    frozen: false,
    acceptClosed: false,
    ...over,
  });

  it("reads a 409 needs_confirmation's consequences and digest, strictly, and nothing else", () => {
    const body = { consequences: [c(0, "lose")], digest: "a".repeat(64) };
    expect(needsConfirmation(new ApiError(409, { error: "needs_confirmation", message: "x", ...body }))).toEqual(body);
    expect(needsConfirmation(new ApiError(409, { error: "needs_confirmation", message: "x", consequences: [], digest: "nope" }))).toBeNull();
    expect(needsConfirmation(new ApiError(409, { error: "has_repo", message: "x", projects: [] }))).toBeNull();
    expect(needsConfirmation(new Error("boom"))).toBeNull();
  });

  it("groups them by project, then repository (one being created apart), then who loses and joins, by name", () => {
    const grouped = consequencesByProject([
      c(1, "lose"),
      c(0, "lose"),
      c(2, "join", { groupId: GROUP_2, groupName: "Groupe 2", repo: null }),
      c(0, "join", { projectId: P2, projectName: "Mini-projet", groupId: GROUP_2, groupName: "Groupe 2", repo: "org/mini-groupe-2" }),
    ]);
    expect(grouped).toEqual([
      {
        projectId: P1,
        projectName: "Labo 4",
        repos: [
          { key: `${GROUP_1}:org/labo-4-groupe-1`, repo: "org/labo-4-groupe-1", groupName: "Groupe 1", frozen: false, lose: ["Dupont Alice", "Favre Benoît"], join: [] },
          { key: `${GROUP_2}:`, repo: null, groupName: "Groupe 2", frozen: false, lose: [], join: ["Martin Chloé"] },
        ],
      },
      {
        projectId: P2,
        projectName: "Mini-projet",
        repos: [{ key: `${GROUP_2}:org/mini-groupe-2`, repo: "org/mini-groupe-2", groupName: "Groupe 2", frozen: false, lose: [], join: ["Dupont Alice"] }],
      },
    ]);
  });

  it("lists a resync's distinct frozen repositories first, then the arrivals without a repository, then the rest", () => {
    const sections = resyncSections([
      c(0, "lose", { frozen: true }),
      c(1, "lose", { frozen: true }),
      c(0, "join", { frozen: true, groupId: GROUP_2, groupName: "Groupe 2", repo: "org/labo-4-groupe-2" }),
      c(4, "join", { acceptClosed: true, groupId: GROUP_2, groupName: "Groupe 3", repo: null }),
    ]);
    expect(sections.frozenRepos).toEqual(["org/labo-4-groupe-1", "org/labo-4-groupe-2"]);
    expect(sections.noRepo).toEqual([{ name: "Vuille Emma", groupName: "Groupe 3" }]);
    expect(sections.rest.map((r) => [r.repo, r.frozen, r.lose, r.join])).toEqual([
      ["org/labo-4-groupe-1", true, ["Dupont Alice", "Favre Benoît"], []],
      ["org/labo-4-groupe-2", true, [], ["Dupont Alice"]],
    ]);
  });

  it("words a write held by a confirmation, never sent", () => {
    expect(groupRefusalMessage(new WriteHeld(), tr(en) as never)).toBe(en["groups.confirm.held"]);
    expect(groupRefusalMessage(new WriteHeld(), tr(fr) as never)).toBe(fr["groups.confirm.held"]);
  });
});
