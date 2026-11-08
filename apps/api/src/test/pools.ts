/**
 * The pool builder of the pool route tests: a pool created through the real
 * route, as a signed-in teacher.
 *
 * Test support only; nothing in the application imports it.
 */
import { expect } from "vitest";

import type { Actor, TestServer } from "./http.js";

/** A pool `name` created by `who` (with `extra` fields of the creation body); its id. */
export async function newPool(server: TestServer, who: Actor, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await server.app.inject({
    method: "POST",
    url: "/app/api/pools",
    headers: who.headers,
    payload: { name, ...extra },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}
