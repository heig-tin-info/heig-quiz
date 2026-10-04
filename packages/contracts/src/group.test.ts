import { describe, expect, it } from "vitest";

import { GroupCreate, GroupMemberPut, GroupRandomForm, GroupRename, GroupSetCreate, GroupSetPatch } from "./group.js";

const ID = "11111111-1111-4111-8111-111111111111";

describe("the group routes' bodies (ADR-070)", () => {
  it("takes a set with or without a name and a maximum size, and a patch of either", () => {
    expect(GroupSetCreate.parse({})).toEqual({});
    expect(GroupSetCreate.parse({ name: "  Labo 1 ", maxSize: null })).toEqual({ name: "Labo 1", maxSize: null });
    expect(GroupSetCreate.safeParse({ maxSize: 0 }).success).toBe(false);
    expect(GroupSetCreate.safeParse({ openUntil: "2026-10-04T08:00:00Z" }).success).toBe(false);
    expect(GroupSetPatch.safeParse({}).success).toBe(false);
    expect(GroupSetPatch.safeParse({ maxSize: null }).success).toBe(true);
  });

  it("refuses a name without a letter nor a digit", () => {
    for (const name of ["", "   ", "!!!"]) {
      expect(GroupRename.safeParse({ name }).success, name).toBe(false);
      expect(GroupSetPatch.safeParse({ name }).success, name).toBe(false);
    }
    expect(GroupCreate.parse({})).toEqual({});
    expect(GroupRename.parse({ name: "Les Pandas" })).toEqual({ name: "Les Pandas" });
  });

  it("places a student into a group or out of every group", () => {
    expect(GroupMemberPut.parse({ groupId: null })).toEqual({ groupId: null });
    expect(GroupMemberPut.parse({ groupId: ID })).toEqual({ groupId: ID });
    expect(GroupMemberPut.safeParse({}).success).toBe(false);
  });

  it("forms at random by a size of at least one and a remainder rule", () => {
    expect(GroupRandomForm.parse({ size: 3, remainder: "larger" })).toEqual({ size: 3, remainder: "larger" });
    expect(GroupRandomForm.safeParse({ size: 0, remainder: "smaller" }).success).toBe(false);
    expect(GroupRandomForm.safeParse({ size: 2.5, remainder: "smaller" }).success).toBe(false);
    expect(GroupRandomForm.safeParse({ size: 3, remainder: "even" }).success).toBe(false);
  });
});
