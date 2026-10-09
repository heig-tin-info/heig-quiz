import { expect, it } from "vitest";

import { newId } from "./id.js";

it("mints short opaque ids", () => {
  const ids = new Set(Array.from({ length: 100 }, newId));
  expect(ids.size).toBe(100);
  for (const id of ids) expect(id).toMatch(/^[a-z0-9]{8}$/);
});
