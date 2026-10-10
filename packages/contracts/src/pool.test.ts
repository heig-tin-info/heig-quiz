import { describe, expect, it } from "vitest";

import { Pool, PoolColor, PoolCreate, PoolPatch, POOL_COLORS, QuestionCreate, QuestionPatch } from "./pool.js";

describe("PoolColor — the colour of a pool's icon (#213)", () => {
  it("is a closed set of fifteen names, grey being null and not a name", () => {
    expect(POOL_COLORS).toHaveLength(15);
    expect(PoolColor.safeParse("teal").success).toBe(true);
    expect(PoolColor.safeParse("gray").success).toBe(false);
    // A hex value is exactly what the closed set exists to keep out.
    expect(PoolColor.safeParse("#ff0000").success).toBe(false);
  });

  it("is optional and nullable on create and on patch", () => {
    expect(PoolCreate.parse({ name: "x" }).color).toBeUndefined();
    expect(PoolCreate.parse({ name: "x", color: "blue" }).color).toBe("blue");
    expect(PoolCreate.parse({ name: "x", color: null }).color).toBeNull();
    expect(PoolCreate.safeParse({ name: "x", color: "chartreuse" }).success).toBe(false);

    expect(PoolPatch.parse({ color: "pink" })).toEqual({ color: "pink" });
    // Back to grey is a patch of its own, not "nothing to update".
    expect(PoolPatch.parse({ color: null })).toEqual({ color: null });
    expect(PoolPatch.safeParse({ color: "chartreuse" }).success).toBe(false);
  });

  it("is always present on a pool, null for the default", () => {
    const pool = {
      id: "00000000-0000-4000-8000-000000000001",
      name: "PRG1",
      icon: null,
      visibility: "private",
      isPublic: false,
      description: "",
      descriptionSource: "owner",
      domainFr: "",
      domainEn: "",
      ownerId: "00000000-0000-4000-8000-000000000002",
      isPersonal: false,
      createdAt: "2026-09-28T00:00:00.000Z",
      updatedAt: "2026-09-28T00:00:00.000Z",
    };
    expect(Pool.safeParse(pool).success).toBe(false);
    expect(Pool.parse({ ...pool, color: null }).color).toBeNull();
  });
});

describe("Publication and description of a pool (ADR-013, 2026-10-10)", () => {
  it("creates unpublished by default and takes `isPublic`, no longer a visibility", () => {
    expect(PoolCreate.parse({ name: "P" }).isPublic).toBe(false);
    expect(PoolCreate.parse({ name: "P", isPublic: true }).isPublic).toBe(true);
    expect(PoolPatch.parse({ isPublic: false })).toEqual({ isPublic: false });
    // The derived visibility is read-only: alone, it is an empty patch.
    expect(PoolPatch.safeParse({ visibility: "public" }).success).toBe(false);
  });

  it("limits the description to 280 characters", () => {
    expect(PoolPatch.safeParse({ description: "x".repeat(280) }).success).toBe(true);
    expect(PoolPatch.safeParse({ description: "x".repeat(281) }).success).toBe(false);
  });

  it("accepts an AI description only together with its text", () => {
    expect(PoolPatch.safeParse({ descriptionFromAi: true }).success).toBe(false);
    expect(PoolPatch.safeParse({ description: "Du C.", descriptionFromAi: true }).success).toBe(true);
  });
});

describe("Question writes after the cut-over to concepts (ADR-081 third addendum)", () => {
  const create = { type: "mcq", internalName: "q1" };

  it("refuses `tags` on create and patch rather than ignoring them", () => {
    expect(QuestionCreate.parse({ ...create, concepts: ["boucle"], createMissing: true })).toEqual({
      ...create,
      concepts: ["boucle"],
      createMissing: true,
    });
    const created = QuestionCreate.safeParse({ ...create, tags: ["boucles"] });
    expect(created.success).toBe(false);
    expect(created.error?.issues[0]).toMatchObject({ code: "unrecognized_keys", keys: ["tags"] });

    expect(QuestionPatch.parse({ concepts: [] })).toEqual({ concepts: [] });
    expect(QuestionPatch.safeParse({ tags: ["boucles"] }).success).toBe(false);
  });

  it("finds nothing to update in `createMissing` alone", () => {
    expect(QuestionPatch.safeParse({ createMissing: true }).success).toBe(false);
  });
});
