import { describe, expect, it } from "vitest";

import { ANSWER_SUMMARY_MAX, ConfigMigrationError } from "@quiz/core/server";

import { circuitServer } from "./server.js";
import { CIRCUIT_CONFIG_VERSION, EMPTY_SCHEMATIC, emptyCircuitConfig } from "./schema.js";
import { circuitConfig, rcAnswer, rcLowPass } from "./test/fixtures.js";

describe("circuitServer: the contract", () => {
  it("is registered under its own id and version", () => {
    expect(circuitServer.id).toBe("circuit");
    expect(circuitServer.configVersion).toBe(CIRCUIT_CONFIG_VERSION);
  });

  it("emits a blank draft stamped with its configVersion", () => {
    const draft = circuitServer.emptyDraft() as Record<string, unknown>;
    expect(draft["configVersion"]).toBe(circuitServer.configVersion);
    expect(draft["prompt"]).toBe("");
  });

  it("migrates its own current version by identity, draft included", () => {
    const draft = circuitServer.emptyDraft();
    expect(circuitServer.migrate(draft, CIRCUIT_CONFIG_VERSION)).toStrictEqual(draft);
    const config = circuitConfig();
    expect(circuitServer.migrate(config, CIRCUIT_CONFIG_VERSION)).toStrictEqual(config);
  });

  it("refuses a config written by a newer platform", () => {
    expect(() => circuitServer.migrate(emptyCircuitConfig(), CIRCUIT_CONFIG_VERSION + 1)).toThrow(
      ConfigMigrationError,
    );
  });

  it("weighs the question by its stimuli, and falls back to one point", () => {
    expect(circuitServer.defaultPoints(circuitConfig())).toBe(4);
    expect(circuitServer.defaultPoints(emptyCircuitConfig())).toBe(1);
  });

  it("has nothing to shuffle", () => {
    expect(circuitServer.shuffleable(circuitConfig())).toBe(false);
  });

  it("indexes the prompt and the stimulus names", () => {
    const text = circuitServer.searchText(circuitConfig());
    expect(text).toContain("low-pass");
    expect(text).toContain("circuit");
    expect(text).toContain("1 kHz sine");
  });
});

describe("circuitServer.summarizeAnswer", () => {
  it("previews the size of the drawing, within the cell's budget", () => {
    const summary = circuitServer.summarizeAnswer?.(circuitConfig(), rcAnswer()) ?? "";
    expect(summary).toBe("3 parts · 4 wires");
    expect(summary.length).toBeLessThanOrEqual(ANSWER_SUMMARY_MAX);
  });

  it("stays inside the budget for the biggest schematic the schema allows", () => {
    const big = {
      schematic: {
        components: Array.from({ length: 40 }, (_x, i) => ({
          ...rcLowPass().schematic.components[0],
          id: `c${i + 1}`,
        })),
        wires: Array.from({ length: 80 }, (_x, i) => ({
          ...rcLowPass().schematic.wires[0],
          id: `w${i + 1}`,
        })),
      },
    } as Parameters<NonNullable<typeof circuitServer.summarizeAnswer>>[1];
    const summary = circuitServer.summarizeAnswer?.(circuitConfig(), big) ?? "";
    expect(summary.length).toBeLessThanOrEqual(ANSWER_SUMMARY_MAX);
  });

  it("says nothing of an empty canvas but its emptiness", () => {
    expect(circuitServer.summarizeAnswer?.(circuitConfig(), { schematic: EMPTY_SCHEMATIC })).toBe(
      "0 parts · 0 wires",
    );
  });
});

describe("circuitServer: the hooks the platform calls", () => {
  it("exposes an interactive request, a grader and a finalizer", () => {
    expect(typeof circuitServer.interactiveRequest).toBe("function");
    expect(typeof circuitServer.finalizeRunner).toBe("function");
    expect(typeof circuitServer.studentDetails).toBe("function");
    expect(typeof circuitServer.toCanonical).toBe("function");
    expect(typeof circuitServer.fromCanonical).toBe("function");
  });

  it("parses its own five schemas", () => {
    const config = circuitConfig();
    expect(circuitServer.configSchema.safeParse(config).success).toBe(true);
    expect(circuitServer.answerSchema.safeParse(rcAnswer()).success).toBe(true);
    expect(
      circuitServer.studentSchema.safeParse(
        circuitServer.toStudent(config, { seed: 1, itemId: "i", shuffle: false }),
      ).success,
    ).toBe(true);
    expect(
      circuitServer.solutionSchema.safeParse(
        circuitServer.toSolution(config, { seed: 1, itemId: "i", shuffle: false }),
      ).success,
    ).toBe(true);
  });
});
