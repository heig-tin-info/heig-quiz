import { describe, expect, it } from "vitest";

import { Pool, PoolColor, PoolCreate, PoolPatch, POOL_COLORS } from "./pool.js";

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
      ownerId: "00000000-0000-4000-8000-000000000002",
      isPersonal: false,
      createdAt: "2026-09-28T00:00:00.000Z",
      updatedAt: "2026-09-28T00:00:00.000Z",
    };
    expect(Pool.safeParse(pool).success).toBe(false);
    expect(Pool.parse({ ...pool, color: null }).color).toBeNull();
  });
});
