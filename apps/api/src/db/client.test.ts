import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { guardPoolErrors } from "./client.js";

describe("guardPoolErrors", () => {
  it("logs an idle client's death on the pool instead of throwing", () => {
    const pool = new EventEmitter();
    const log = { error: vi.fn() };
    guardPoolErrors(pool, log);
    expect(() => pool.emit("error", new Error("terminating connection"))).not.toThrow();
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), "idle database client error");
  });

  it("logs a checked-out client's death on the client itself instead of throwing", () => {
    const pool = new EventEmitter();
    const client = new EventEmitter();
    const log = { error: vi.fn() };
    guardPoolErrors(pool, log);
    pool.emit("connect", client);
    // Without a listener of its own, Node would throw this as an uncaught exception.
    const err = new Error("terminating connection due to idle-in-transaction timeout");
    expect(() => client.emit("error", err)).not.toThrow();
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ err }), "database client error");
  });
});
