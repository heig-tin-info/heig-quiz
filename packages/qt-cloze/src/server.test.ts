/** The contract surface of `clozeServer`. */
import { readFileSync } from "node:fs";
import { ConfigMigrationError } from "@quiz/core/server";
import { describe, expect, it } from "vitest";
import { toCanonical } from "./canonical.js";
import { config, SECRET_CONFIG } from "./test/fixtures.js";
import { CLOZE_CONFIG_VERSION, ClozeConfigSchema, emptyClozeDraft } from "./schema.js";
import { clozeServer, hasSelectBlank } from "./server.js";

describe("the contract", () => {
  /*
   * v1 → v2 is the identity plus the version stamp: the two shapes are the
   * same (schema.ts says why the number moved anyway).
   */
  it("migrates a v1 config by stamping the version, changing nothing else", () => {
    const v1 = { configVersion: 1, text: "{{a}}", caseSensitive: false, shuffleOptions: true };
    const migrated = clozeServer.migrate(v1, 1);
    expect(migrated).toEqual({ ...v1, configVersion: CLOZE_CONFIG_VERSION });
    expect(ClozeConfigSchema.safeParse(migrated).success).toBe(true);
  });

  it("refuses a version it never emitted", () => {
    expect(() => clozeServer.migrate(emptyClozeDraft(), 0)).toThrow(ConfigMigrationError);
  });

  it("defaults to one point per blank", () => {
    expect(clozeServer.defaultPoints(config("{{a}} {{b}} {{c}}"))).toBe(3);
    expect(clozeServer.defaultPoints(emptyClozeDraft())).toBe(1);
  });

  it("is shuffleable only when a dropdown is there to shuffle", () => {
    expect(clozeServer.shuffleable(config("{{=a|b}}"))).toBe(true);
    expect(clozeServer.shuffleable(config("{{a}}"))).toBe(false);
    expect(clozeServer.shuffleable(config("{{=a|b}}", { shuffleOptions: false }))).toBe(false);
    expect(hasSelectBlank(SECRET_CONFIG)).toBe(true);
  });

  it("renders the key blank by blank for the feedback path", () => {
    const solution = clozeServer.toSolution(SECRET_CONFIG, { seed: 1, itemId: "i", shuffle: true });
    expect(solution.blanks[0]).toEqual({ index: 0, expected: "Newton | newton" });
    expect(solution.blanks[4]).toEqual({ index: 4, expected: "/^N$/" });
    // A dropdown lists the CORRECT labels, and only those.
    expect(solution.blanks.at(-1)).toEqual({ index: 5, expected: "NEWTON-MARKER" });
  });

  it("indexes the authoring text, which holds every answer a cloze has", () => {
    const indexed = clozeServer.searchText(SECRET_CONFIG);
    expect(indexed).toContain(SECRET_CONFIG.text);
    expect(indexed).toContain("pascal");
  });
});

/**
 * Milliseconds a call takes, the best of three. This package runs without
 * coverage, so the bounds below are the real ones (`@quiz/domain`'s regex
 * tests, always under coverage, check the same refusals loosely).
 */
function elapsed(call: () => unknown): number {
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    call();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

/** `count` regex blanks of `pattern`, each unseen by the cache of compiled patterns. */
let fresh = 0;
const blanks = (count: number, pattern: string) =>
  Array.from({ length: count }, () => `{{/(?:${pattern})(?:x${fresh++})?/i}}`).join(" ");

describe("regex blanks RE2 refuses (ADR-099)", () => {
  it("are refused at publication, one issue per blank", () => {
    const issues = clozeServer.publicationIssues!(
      config("{{/(a)\\1/}} {{/ok/}} {{/a(?=b)/i}} {{/(?:.?){999}/}} {{/a/g}} {{/([a-/}}"),
    );
    expect(issues.map((issue) => issue.message)).toEqual([
      "regex.unsupported",
      "regex.unsupported",
      "regex.too_complex",
      "regex.invalid_flags",
      "regex.invalid",
    ]);
    expect(issues.every((issue) => issue.path.join(".") === "text")).toBe(true);
    expect(clozeServer.publicationIssues!(config("{{/galil[ée]e/i}} {{Newton}}"))).toEqual([]);
  });

  it("compile nothing on a read, however many there are", () => {
    // Folding `[Ā-\u{10FFFF}]` under `i` took some 35 ms per copy when built.
    const text = blanks(300, "[Ā-\u{10FFFF}]");
    expect(elapsed(() => ClozeConfigSchema.safeParse({ configVersion: CLOZE_CONFIG_VERSION, text }))).toBeLessThan(50);
  });

  it("cost one question a bounded build: refused together past the budget, before any build", () => {
    // Each acceptable alone; built together, half a second on every draft save.
    const costly = config(blanks(50, "\\p{Ll}".repeat(10)));
    expect(
      elapsed(() =>
        expect(clozeServer.publicationIssues!(costly)).toEqual([{ path: ["text"], message: "regex.config_too_complex" }]),
      ),
    ).toBeLessThan(10);
  });

  it("publish a question under the budget in a few tens of milliseconds", () => {
    expect(
      elapsed(() => {
        const under = config(`${blanks(5, "\\p{Ll}".repeat(10))} ${blanks(45, "(the )?[a-zà-ÿ]{2,30}")}`);
        expect(clozeServer.publicationIssues!(under)).toEqual([]);
      }),
    ).toBeLessThan(50);
  });

  it("hold no [[…]] reference in a parameterized question (ADR-056 §10)", () => {
    expect(clozeServer.parameterIssues!({ text: "{{/a[[h]]/i}} {{#[[h]]}}" })).toEqual([
      { path: ["text"], message: "cloze.computed_regex_key" },
    ]);
    expect(clozeServer.parameterIssues!({ text: "{{/a+/i}} {{#[[h]]}}" })).toEqual([]);
    expect(clozeServer.parameterIssues!(null)).toEqual([]);
  });
});

describe("the canonical mapping", () => {
  it("round-trips a full config", () => {
    const cfg = config("{{=a|b}} {{k}}", { caseSensitive: true, shuffleOptions: false });
    expect(ClozeConfigSchema.parse(toCanonical(cfg))).toEqual(cfg);
  });

  it("omits the defaults", () => {
    expect(toCanonical(emptyClozeDraft())).toEqual({
      configVersion: CLOZE_CONFIG_VERSION,
      text: "",
    });
  });

  it("is what the type exposes to the exporter", () => {
    expect(clozeServer.toCanonical?.(SECRET_CONFIG)).toEqual(toCanonical(SECRET_CONFIG));
    expect(clozeServer.configSchema.parse(toCanonical(SECRET_CONFIG))).toEqual(SECRET_CONFIG);
  });
});

describe("summarizeAnswer — the glyph of the live grid (F-DASH-02)", () => {
  const text = "Un {{int}} tient {{=32|64}} bits sur {{cette|la}} machine.";
  const summarize = (blanks: (string | null)[]) =>
    clozeServer.summarizeAnswer!(config(text), { blanks });

  it("joins the blanks in order", () => {
    expect(summarize(["int", "0", "cette"])).toBe("int · 32 · cette");
  });

  it("resolves a dropdown back to its label, never its stored index (D4)", () => {
    expect(summarize([null, "1", null])).toBe("— · 64 · —");
  });

  it("keeps an untouched blank as a dash, because the position is the point", () => {
    expect(summarize(["int", null, null])).toBe("int · — · —");
  });

  it("says nothing about whether any blank is right", () => {
    expect(summarize(["float", "0", "la"])).toBe("float · 32 · la");
  });
});

describe("the server entry point", () => {
  it("never reaches React", () => {
    for (const file of ["server.ts", "schema.ts", "grade.ts", "canonical.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(/from "react/);
      expect(source).not.toMatch(/@quiz\/core\/client/);
    }
  });
});

describe("aggregate (F-RES-03, audit B-15)", () => {
  it("counts each blank by its position and the text typed", () => {
    const stats = clozeServer.aggregate!({
      answers: [{ blanks: ["a", null] }, { blanks: ["a", "b"] }, { text: "stray" }],
      details: [],
    });
    expect(stats).toEqual({
      distribution: [
        { key: "0: a", label: "a", part: 0, count: 2 },
        { key: "1: ", label: "", part: 1, count: 1 },
        { key: "1: b", label: "b", part: 1, count: 1 },
      ],
    });
  });

  it("judges each blank by the verdict its grading recorded (ADR-033)", () => {
    const blank = (index: number, ok: boolean) => ({
      index,
      weight: 1,
      kind: "text",
      ok,
      given: null,
      expected: "x",
    });
    const stats = clozeServer.aggregate!({
      answers: [{ blanks: ["main", "exit"] }],
      details: [{ perBlank: [blank(0, true), blank(1, false)], earned: 1, total: 2, fraction: 0.5 }],
    });
    expect(stats.distribution).toEqual([
      { key: "0: main", label: "main", part: 0, correct: true, count: 1 },
      { key: "1: exit", label: "exit", part: 1, correct: false, count: 1 },
    ]);
  });
});
