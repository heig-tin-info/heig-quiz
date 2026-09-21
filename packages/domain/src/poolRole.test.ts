import { describe, expect, it } from "vitest";

import { effectivePoolRole, poolRoleAllows, type PoolRoleFacts } from "./poolRole.js";

const nobody: PoolRoleFacts = {
  isAdmin: false,
  isOwner: false,
  memberRole: null,
  isCourseStaff: false,
  isPublic: false,
};

describe("effectivePoolRole", () => {
  it("makes an owner of the pool's owner, of an admin and of a member-owner", () => {
    expect(effectivePoolRole({ ...nobody, isOwner: true })).toBe("owner");
    expect(effectivePoolRole({ ...nobody, isAdmin: true })).toBe("owner");
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
