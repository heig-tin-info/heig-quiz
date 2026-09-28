import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { HintEvent } from "@quiz/contracts";

import * as keys from "../queryKeys";
import { HINT_ROOTS, hintRoots, invalidateHint } from "./hints";

/** The head of every key `queryKeys.ts` can build, factories called with dummies. */
const KEY_ROOTS = new Set(
  Object.values(keys).map((k) => {
    const key =
      typeof k === "function"
        ? (k as unknown as (...a: string[]) => readonly unknown[])("x", "x", "x", "x")
        : k;
    return String((key as readonly unknown[])[0]);
  }),
);

describe("hint kinds -> query-key roots", () => {
  it("has an entry for every kind the contract names", () => {
    expect(Object.keys(HINT_ROOTS).sort()).toEqual(
      [...HintEvent.shape.kinds.element.options].sort(),
    );
  });

  it("names only roots that queryKeys.ts builds", () => {
    for (const roots of Object.values(HINT_ROOTS)) {
      if (roots === "all") continue;
      for (const root of roots) expect(KEY_ROOTS, root).toContain(root);
    }
  });

  it("maps a known kind to its roots and unions several", () => {
    expect(hintRoots(["notifications"])).toEqual(
      new Set(["notifications", "notification-settings"]),
    );
    const both = hintRoots(["notifications", "admin"]);
    expect(both).not.toBe("all");
    expect([...(both as Set<string>)].sort()).toEqual(
      ["admin-teachers", "me", "notification-settings", "notifications"].sort(),
    );
  });

  it("falls back to everything for mutation, an unknown kind or no kind", () => {
    expect(hintRoots(["mutation"])).toBe("all");
    expect(hintRoots(["pool", "from-a-newer-server"])).toBe("all");
    expect(hintRoots(["toString"])).toBe("all");
    expect(hintRoots([])).toBe("all");
  });
});

describe("invalidateHint", () => {
  function seeded() {
    const qc = new QueryClient();
    for (const key of [
      keys.poolKey("p1"),
      keys.poolQuestionsKey("p1", ""),
      keys.coursesKey,
      keys.notificationsKey,
      keys.meKey,
    ]) {
      qc.setQueryData(key, 1);
    }
    return qc;
  }
  const stale = (qc: QueryClient) =>
    qc
      .getQueryCache()
      .getAll()
      .filter((q) => q.state.isInvalidated)
      .map((q) => q.queryKey[0])
      .sort();

  it("invalidates only the roots of the kind", async () => {
    const qc = seeded();
    await invalidateHint(qc, ["pool"]);
    expect(stale(qc)).toEqual(["pool", "pool"]);
  });

  it("invalidates everything for a catch-all mutation", async () => {
    const qc = seeded();
    await invalidateHint(qc, ["mutation"]);
    expect(stale(qc)).toHaveLength(5);
  });
});
