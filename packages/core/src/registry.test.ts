import { describe, expect, it } from "vitest";
import { isGraded, isPendingLlm, isPendingRunner, isQuestionTypeId, QUESTION_TYPE_IDS } from "./contract.js";
import type { GradeResult } from "./contract.js";
import { ConfigMigrationError, RunnerBusy, RunnerUnavailable, UnknownQuestionType } from "./errors.js";
import { defineClientRegistry, defineServerRegistry, makeLookup, registeredIds } from "./registry.js";

const fake = { id: "mcq" } as const;

describe("question type ids", () => {
  it("lists the four MVP types and the circuit type", () => {
    expect(QUESTION_TYPE_IDS).toEqual(["mcq", "short", "cloze", "code", "circuit"]);
  });

  it("narrows a raw string", () => {
    expect(isQuestionTypeId("cloze")).toBe(true);
    expect(isQuestionTypeId("rich")).toBe(false);
  });
});

describe("registries", () => {
  it("defineServerRegistry / defineClientRegistry are identities", () => {
    const m = {};
    expect(defineServerRegistry(m)).toBe(m);
    expect(defineClientRegistry(m)).toBe(m);
  });

  it("makeLookup returns the registered entry", () => {
    const lookup = makeLookup({ mcq: fake });
    expect(lookup("mcq")).toBe(fake);
  });

  it("makeLookup throws UnknownQuestionType on an unregistered id", () => {
    const lookup = makeLookup<{ id: string }>({});
    expect(() => lookup("code")).toThrow(UnknownQuestionType);
    expect(() => lookup("code")).toThrow(/unknown question type: code/);
  });

  it("registeredIds lists the keys in registration order", () => {
    expect(registeredIds({ mcq: 1, short: 2 })).toEqual(["mcq", "short"]);
    expect(registeredIds({})).toEqual([]);
  });
});

describe("errors", () => {
  it("carry a stable machine code and a readable name", () => {
    const unknown = new UnknownQuestionType("rich");
    expect([unknown.name, unknown.code, unknown.id]).toEqual([
      "UnknownQuestionType",
      "unknown_question_type",
      "rich",
    ]);

    const migration = new ConfigMigrationError("mcq", 1, 2, "missing choices");
    expect(migration.code).toBe("config_migration_failed");
    expect(migration.message).toContain("from v1 to v2");

    const unavailable = new RunnerUnavailable();
    expect([unavailable.code, unavailable.reason]).toEqual(["runner_unavailable", "not_configured"]);
    expect(new RunnerUnavailable("unhealthy").message).toContain("unhealthy");

    const busy = new RunnerBusy(1500);
    expect([busy.code, busy.retryAfterMs]).toEqual(["runner_busy", 1500]);
    expect(new RunnerBusy().retryAfterMs).toBeNull();
  });
});

describe("GradeResult narrowing", () => {
  const graded: GradeResult<{ f: number }> = {
    kind: "graded",
    points: 1,
    maxPoints: 2,
    details: { f: 0.5 },
  };
  const runner: GradeResult<{ f: number }> = {
    kind: "pending",
    via: "runner",
    request: {
      language: "c",
      files: [{ name: "main.c", content: "" }],
      compileArgs: "",
      action: "run",
      limits: { timeMs: 1000, memoryMb: 64, outputKb: 16 },
      cases: [],
      priority: "grading",
    },
  };
  const llm: GradeResult<{ f: number }> = {
    kind: "pending",
    via: "llm",
    request: { rubric: "r", answer: "a", maxPoints: 2 },
  };

  it("discriminates the three branches", () => {
    expect([isGraded(graded), isPendingRunner(graded), isPendingLlm(graded)]).toEqual([true, false, false]);
    expect([isGraded(runner), isPendingRunner(runner), isPendingLlm(runner)]).toEqual([false, true, false]);
    expect([isGraded(llm), isPendingRunner(llm), isPendingLlm(llm)]).toEqual([false, false, true]);
  });
});
