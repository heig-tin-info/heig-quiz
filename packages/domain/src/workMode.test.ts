import { describe, expect, it } from "vitest";

import { collaboratorPermission, isOnlineMode, quotaHolder, workModeRefusal, type WorkModeFacts } from "./workMode.js";

const OWNER: WorkModeFacts = { owner: true, granted: true, launched: false, groupMode: false };

describe("collaboratorPermission (ADR-047 §2)", () => {
  it("pushes in the student's own tools, pulls online, invites nobody under SEB", () => {
    expect(collaboratorPermission("free")).toBe("push");
    expect(collaboratorPermission("online")).toBe("pull");
    expect(collaboratorPermission("online_seb")).toBeNull();
    expect([isOnlineMode("free"), isOnlineMode("online"), isOnlineMode("online_seb")]).toEqual([false, true, true]);
  });
});

describe("workModeRefusal", () => {
  it("lets an owner with the grant choose any mode", () => {
    expect(workModeRefusal(OWNER, "free", "online")).toBeNull();
    expect(workModeRefusal(OWNER, "online", "online_seb")).toBeNull();
    expect(workModeRefusal(OWNER, "online", "free")).toBeNull();
  });

  it("refuses an assistant, whatever the mode", () => {
    expect(workModeRefusal({ ...OWNER, owner: false }, "free", "online")).toBe("owner_required");
    expect(workModeRefusal({ ...OWNER, owner: false }, "online", "free")).toBe("owner_required");
  });

  it("needs the grant to go online, not to come back to free", () => {
    const ungranted = { ...OWNER, granted: false };
    expect(workModeRefusal(ungranted, "free", "online")).toBe("codespace_not_granted");
    expect(workModeRefusal(ungranted, "free", "online_seb")).toBe("codespace_not_granted");
    expect(workModeRefusal(ungranted, "online", "free")).toBeNull();
  });

  it("freezes the mode once a workspace was launched", () => {
    const launched = { ...OWNER, launched: true };
    expect(workModeRefusal(launched, "online", "free")).toBe("work_mode_frozen");
    expect(workModeRefusal(launched, "online", "online_seb")).toBe("work_mode_frozen");
  });

  it("keeps a group project in the students' own tools", () => {
    expect(workModeRefusal({ ...OWNER, groupMode: true }, "free", "online")).toBe("work_mode_group");
  });

  it("never refuses the mode the project already has", () => {
    expect(workModeRefusal({ owner: false, granted: false, launched: true, groupMode: true }, "online", "online")).toBeNull();
  });
});

describe("quotaHolder (decision C)", () => {
  const seat = (userId: string, iso: string) => ({ userId, createdAt: new Date(iso) });

  it("is the creator while they hold an owner seat", () => {
    expect(quotaHolder("c", [seat("a", "2026-01-01T00:00:00Z"), seat("c", "2026-05-01T00:00:00Z")])).toBe("c");
  });

  it("falls to the oldest owner seat, ties by user id", () => {
    expect(quotaHolder("gone", [seat("b", "2026-03-01T00:00:00Z"), seat("a", "2026-04-01T00:00:00Z")])).toBe("b");
    expect(quotaHolder("gone", [seat("z", "2026-03-01T00:00:00Z"), seat("y", "2026-03-01T00:00:00Z")])).toBe("y");
  });

  it("is nobody on a course without an owner", () => {
    expect(quotaHolder("c", [])).toBeNull();
  });
});
