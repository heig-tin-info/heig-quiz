import { beforeEach, describe, expect, it } from "vitest";

import { errorClass, resetServiceRecords, serviceRecord, tracked } from "./serviceHealth.js";

beforeEach(() => resetServiceRecords());

describe("tracked", () => {
  it("records a success and a failure, and passes both through untouched", async () => {
    expect(await tracked("llm", async () => 42)).toBe(42);
    const boom = Object.assign(new Error("secret words"), { status: 503 });
    await expect(tracked("llm", async () => Promise.reject(boom))).rejects.toBe(boom);
    await expect(tracked("llm", async () => Promise.reject(boom))).rejects.toBe(boom);
    const r = serviceRecord("llm");
    expect(r).toMatchObject({ lastError: "http_503", failuresSinceOk: 2 });
    expect(r.failingSince).not.toBeNull();
    expect(r.lastOkAt).not.toBeNull();
    // Other services are untouched.
    expect(serviceRecord("teams")).toMatchObject({ lastOkAt: null, lastErrorAt: null });
  });

  it("counts an error the service is not to blame for as an answer", async () => {
    await expect(tracked("teams", async () => Promise.reject(new Error("x")), () => false)).rejects.toThrow();
    expect(serviceRecord("teams")).toMatchObject({ lastErrorAt: null, failuresSinceOk: 0 });
    expect(serviceRecord("teams").lastOkAt).not.toBeNull();
  });
});

describe("errorClass", () => {
  it("names a failure by its class, never by its words", () => {
    expect(errorClass(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe("timeout");
    expect(errorClass(Object.assign(new Error("x"), { error: "invalid_grant", status: 400 }))).toBe("invalid_grant");
    // An OAuth "code" that is not one is not kept.
    expect(errorClass(Object.assign(new Error("x"), { error: "ada@heig.test", status: 400 }))).toBe("oauth_error");
    expect(errorClass(Object.assign(new Error("x"), { error: "made_up_word" }))).toBe("oauth_error");
    expect(errorClass(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }))).toBe(
      "network_econnrefused",
    );
    expect(errorClass(new Error("outer", { cause: Object.assign(new Error("in"), { name: "AbortError" }) }))).toBe(
      "timeout",
    );
    expect(errorClass(new Error("anything at all"))).toBe("error");
    expect(errorClass("a string")).toBe("error");
  });
});
