import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { AssistAsk } from "@quiz/contracts";
import { ASSIST_REFUSAL } from "@quiz/domain";

/**
 * The offline evaluation set (ADR-080, Consequences) stays usable: every case
 * is a question the API accepts, in a language the prompt states its refusal in.
 * The set itself is run against a real model elsewhere, never in CI.
 */
const set = JSON.parse(readFileSync(new URL("./eval-prompts.json", import.meta.url), "utf8")) as {
  cases: { id: string; context: unknown; message: string; expect: string; language: string }[];
};

describe("the assistant's evaluation prompts", () => {
  it("are questions the API accepts, in both languages, of both kinds", () => {
    for (const c of set.cases) {
      expect(AssistAsk.safeParse({ message: c.message, context: c.context }).success, c.id).toBe(true);
      expect(["answer", "refuse"], c.id).toContain(c.expect);
    }
    expect(new Set(set.cases.map((c) => `${c.expect}-${c.language}`)).size).toBe(4);
    expect(new Set(set.cases.map((c) => c.id)).size).toBe(set.cases.length);
  });

  it("refuse only in a language the prompt states its refusal in", () => {
    for (const c of set.cases) expect(Object.keys(ASSIST_REFUSAL), c.id).toContain(c.language);
  });
});
