import { describe, expect, it } from "vitest";

import { effectivePoolRole, heldPoolRole, poolRoleAllows, type PoolRoleFacts } from "./poolRole.js";

const nobody: PoolRoleFacts = {
  reachesAll: false,
  isOwner: false,
  memberRole: null,
  isCourseStaff: false,
  isPublic: false,
};

describe("effectivePoolRole", () => {
  it("makes an owner of the pool's owner, of an admin with Super Powers and of a member-owner", () => {
    expect(effectivePoolRole({ ...nobody, isOwner: true })).toBe("owner");
    expect(effectivePoolRole({ ...nobody, reachesAll: true })).toBe("owner");
    expect(effectivePoolRole({ ...nobody, memberRole: "owner" })).toBe("owner");
  });

  it("gives the member role when there is a seat", () => {
    expect(effectivePoolRole({ ...nobody, memberRole: "contributor" })).toBe("contributor");
    expect(effectivePoolRole({ ...nobody, memberRole: "reader" })).toBe("reader");
  });

  it("keeps the course staff a contributor — they could already write", () => {
    expect(effectivePoolRole({ ...nobody, isCourseStaff: true })).toBe("contributor");
  });

  it("lets an explicit seat override the course-staff rule, in both directions", () => {
    // Naming a colleague `reader` has to mean something, even when they sit on
    // the staff of a course the pool is linked to.
    expect(effectivePoolRole({ ...nobody, isCourseStaff: true, memberRole: "reader" })).toBe(
      "reader",
    );
    expect(effectivePoolRole({ ...nobody, isCourseStaff: true, memberRole: "owner" })).toBe("owner");
  });

  it("reads a public pool and nothing more", () => {
    expect(effectivePoolRole({ ...nobody, isPublic: true })).toBe("reader");
    // A public pool never promotes: only a seat or the course does.
    expect(effectivePoolRole({ ...nobody, isPublic: true, isCourseStaff: true })).toBe(
      "contributor",
    );
  });

  it("falls back to reader and never invents more", () => {
    expect(effectivePoolRole(nobody)).toBe("reader");
  });
});

describe("heldPoolRole", () => {
  it("never makes an owner of Super Powers alone", () => {
    // An admin who is neither owner nor seated sees the role they would hold
    // without Super Powers; the effective role still says owner.
    expect(heldPoolRole({ ...nobody, isPublic: true })).toBe("reader");
    expect(heldPoolRole({ ...nobody, isCourseStaff: true })).toBe("contributor");
    expect(heldPoolRole({ ...nobody, memberRole: "reader", isCourseStaff: true })).toBe("reader");
    expect(effectivePoolRole({ ...nobody, reachesAll: true, isPublic: true })).toBe("owner");
  });

  it("keeps the owner and an owner seat owners", () => {
    expect(heldPoolRole({ ...nobody, isOwner: true })).toBe("owner");
    expect(heldPoolRole({ ...nobody, memberRole: "owner" })).toBe("owner");
  });

  it("agrees with the effective role whenever Super Powers are off", () => {
    const roles = [null, "reader", "contributor", "owner"] as const;
    for (const memberRole of roles)
      for (const isOwner of [false, true])
        for (const isCourseStaff of [false, true])
          for (const isPublic of [false, true]) {
            const facts = { ...nobody, memberRole, isOwner, isCourseStaff, isPublic };
            expect(heldPoolRole(facts)).toBe(effectivePoolRole(facts));
          }
  });
});

describe("poolRoleAllows", () => {
  it("orders reader < contributor < owner", () => {
    expect(poolRoleAllows("owner", "owner")).toBe(true);
    expect(poolRoleAllows("owner", "contributor")).toBe(true);
    expect(poolRoleAllows("contributor", "contributor")).toBe(true);
    expect(poolRoleAllows("contributor", "owner")).toBe(false);
    expect(poolRoleAllows("reader", "contributor")).toBe(false);
    expect(poolRoleAllows("reader", "reader")).toBe(true);
  });
});
