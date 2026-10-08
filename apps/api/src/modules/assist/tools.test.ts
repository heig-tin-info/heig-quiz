/**
 * The help assistant's data tools without a server (ADR-080 P2): the client
 * they are handed reads only, and a result past about 8k tokens is cut with
 * the "narrow your request" marker.
 */
import { describe, expect, it } from "vitest";

import { ASSIST_TOOL_RESULT_CHARS, ASSIST_TRUNCATED } from "@quiz/domain";

import { ApiError, type Api } from "../mcp/service.js";
import { assistDataTools, readOnly } from "./tools.js";

const id = "0b6f6a52-6c7e-4a0d-9e8e-3a3f1e2b4c5d";

function fakeApi(get: (path: string) => unknown): Api & { writes: string[] } {
  const writes: string[] = [];
  const write = (path: string) => {
    writes.push(path);
    return Promise.resolve({});
  };
  return {
    writes,
    get: (path) => Promise.resolve(get(path)),
    post: write,
    put: write,
    patch: write,
    link: (path) => `https://quiz.test${path}`,
  };
}

describe("readOnly", () => {
  it("lets the GETs through and refuses every write before it is sent", async () => {
    const api = fakeApi(() => ({ ok: true }));
    const reader = readOnly(api);
    expect(await reader.get("/courses")).toEqual({ ok: true });
    await expect(reader.post("/courses", {})).rejects.toThrow("reads only");
    await expect(reader.put("/x", {})).rejects.toThrow("reads only");
    await expect(reader.patch("/x", {})).rejects.toThrow("reads only");
    expect(api.writes).toEqual([]);
  });
});

describe("assistDataTools", () => {
  const tool = (api: Api, name: string) => assistDataTools(api).find((t) => t.name === name)!;

  it("cuts a long result with the narrow-your-request marker", async () => {
    const many = Array.from({ length: 4_000 }, (_, i) => ({ id, name: `Pool number ${i}`, questionCount: i }));
    const out = await tool(fakeApi(() => many), "list_pools").run({});
    expect(out.length).toBeLessThan(ASSIST_TOOL_RESULT_CHARS + 120);
    expect(out).toContain(ASSIST_TRUNCATED);
    expect(out).toContain("Narrow your request");
  });

  it("keeps a short result whole, as JSON", async () => {
    const out = await tool(fakeApi(() => [{ id, name: "Pool" }]), "list_pools").run({});
    expect(JSON.parse(out)).toEqual([{ id, name: "Pool" }]);
  });

  it("tells a 404 as a missing seat and never quotes the route's body", async () => {
    const api = fakeApi(() => {
      throw new ApiError(404, { error: "not_found", secret: "body" });
    });
    await expect(tool(api, "get_course").run({ courseId: id })).rejects.toThrow("no seat on the course");
    await expect(tool(api, "get_course").run({ courseId: id })).rejects.not.toThrow("body");
  });

  it("validates the input before any request", async () => {
    let asked = false;
    const api = fakeApi(() => {
      asked = true;
      return {};
    });
    await expect(tool(api, "get_course").run({ courseId: "nope" })).rejects.toThrow("Invalid arguments");
    expect(asked).toBe(false);
  });
});
