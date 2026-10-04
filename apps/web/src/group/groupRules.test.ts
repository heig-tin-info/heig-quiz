import { describe, expect, it } from "vitest";

import { GROUP_REFUSALS } from "@quiz/contracts";

import { ApiError } from "../api";
import { en } from "../i18n/en";
import { fr } from "../i18n/fr";
import { GROUP_1, GROUP_2, makeSet, student } from "../test/group-fixtures";
import {
  defaultRandomSize,
  gone,
  groupRefusalMessage,
  overMax,
  placeOf,
  setInUseProjects,
  sizesSummary,
  stepZone,
  withMove,
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

  it("reads the projects of a set_in_use, and a 404 as an Undo whose group is gone", () => {
    const inUse = new ApiError(409, { error: "set_in_use", message: "x", projects: [{ id: "p1", name: "Labo 4" }] });
    expect(setInUseProjects(inUse)).toEqual([{ id: "p1", name: "Labo 4" }]);
    expect(setInUseProjects(new ApiError(409, { error: "duplicate_name" }))).toBeNull();
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
