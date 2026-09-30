import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { perApp } from "./perApp.js";

describe("perApp", () => {
  it("reads the root's value from a plugin's child instance", async () => {
    const app = Fastify();
    const value = perApp<number>();
    value.set(app, 42);
    let seen: number | undefined;
    await app.register(async (child) => {
      seen = value.get(child);
    });
    await app.ready();
    expect(seen).toBe(42);
    expect(value.get(Fastify())).toBeUndefined();
    await app.close();
  });
});
