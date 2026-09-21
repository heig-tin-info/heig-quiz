/**
 * Invariant 4, enforced across the WHOLE registry (docs/05 §5.7, N-SEC-04).
 *
 * Each `qt-*` package tests its own `toStudent`. This test covers the other
 * half of the promise: that `studentView()` — the single exit of the API
 * toward a student — is safe for EVERY registered type, including one that
 * lands later, and including a type whose author forgot the rule.
 *
 * The method is the one the spec names:
 *   1. take the type's own `emptyDraft()`, COMPLETE it into a valid config
 *      (an empty draft is empty by design and does not parse — D16) and sow
 *      recognisable markers into the fields that carry the key, keeping the
 *      config valid at every step (a marker that would break `configSchema`
 *      is skipped rather than forced, so the check never degenerates into
 *      "the parser refused it");
 *   2. serialise what `studentView()` produces;
 *   3. assert that no marker and no forbidden key survive the trip.
 *
 * A type whose key is not in a field of its own — `cloze`, whose answers live
 * inside the authoring text — sows nothing and is covered here by the
 * forbidden-key half plus its own `packages/qt-cloze/src/toStudent.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { questionType, registeredServerIds, registerForTests } from "@quiz/registry/server";
import type { AnyQuestionTypeServer } from "@quiz/core/server";

import { fakeRunnableCode, fakeShort } from "../../test/fakeType.js";
import { FORBIDDEN_STUDENT_KEYS, studentView, stripMetadata } from "./studentView.js";

/**
 * Keys that name the answer key rather than the question. `expected` and
 * `stdin` are only secret when the case they belong to is HIDDEN: a visible
 * case publishes both on purpose (docs/04 §4.7, deviation W3-4).
 */
const SECRET_KEYS = new Set([
  "alternatives",
  "answer",
  "answers",
  "comment",
  "expected",
  "explanation",
  "hint",
  "key",
  "matcher",
  "pattern",
  "rationale",
  "referenceSolution",
  "regex",
  "solution",
  "stdin",
  "value",
]);
const VISIBILITY_DEPENDENT = new Set(["expected", "stdin"]);

type Path = (string | number)[];

/** Every path of the config that names a secret string. */
function secretPaths(value: unknown, visible = false, path: Path = [], out: Path[] = []): Path[] {
  if (Array.isArray(value)) {
    value.forEach((child, index) => secretPaths(child, visible, [...path, index], out));
    return out;
  }
  if (value === null || typeof value !== "object") return out;
  const record = value as Record<string, unknown>;
  const here = typeof record["visible"] === "boolean" ? record["visible"] : visible;
  for (const [key, child] of Object.entries(record)) {
    if (typeof child === "string") {
      if (!SECRET_KEYS.has(key)) continue;
      if (here && VISIBILITY_DEPENDENT.has(key)) continue;
      out.push([...path, key]);
      continue;
    }
    secretPaths(child, here, [...path, key], out);
  }
  return out;
}

function getAt(root: unknown, path: Path): unknown {
  let current = root;
  for (const step of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[step];
  }
  return current;
}

function setAt(root: unknown, path: Path, value: unknown): void {
  const parent = getAt(root, path.slice(0, -1));
  if (parent === null || typeof parent !== "object") return;
  (parent as Record<string | number, unknown>)[path[path.length - 1]!] = value;
}

interface Sown {
  config: unknown;
  markers: string[];
}

/**
 * Every path of the config that holds an EMPTY string.
 */
function blankPaths(value: unknown, path: Path = [], out: Path[] = []): Path[] {
  if (Array.isArray(value)) {
    value.forEach((child, index) => blankPaths(child, [...path, index], out));
    return out;
  }
  if (value === null || typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === "") out.push([...path, key]);
    else blankPaths(child, [...path, key], out);
  }
  return out;
}

/**
 * The fillers tried, in order, to turn an empty draft into a VALID config.
 * `{{x}} x` is there for a type whose text carries its own grammar (`cloze`
 * needs a blank); a type that needs something else fails loudly below rather
 * than silently sowing nothing.
 */
const FILLERS = ["x", "{{x}} x"];

/**
 * The type's empty draft, completed into a config its schema accepts.
 *
 * `emptyDraft()` is deliberately EMPTY and invalid (decision D16), while
 * `studentView` reads a stored config through `loadConfig`, which parses. So
 * the fixture fills every blank string before anything is sown into it.
 */
function filledDraft(type: AnyQuestionTypeServer): unknown {
  const draft = type.emptyDraft() as unknown;
  const blanks = blankPaths(draft);
  for (const filler of FILLERS) {
    const candidate = structuredClone(draft) as unknown;
    for (const path of blanks) setAt(candidate, path, filler);
    const parsed = type.configSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  throw new Error(
    `the empty draft of "${type.id}" cannot be completed generically — ` +
      "give this test a filler its schema accepts, or the leak search proves nothing",
  );
}

/**
 * Sows one marker per secret field, one at a time, keeping only the ones the
 * type's own schema still accepts (an enum or a pattern legitimately refuses
 * a prefix). The markers are made of word characters so they survive the
 * common `\w`-shaped validations.
 */
function sowSecrets(type: AnyQuestionTypeServer): Sown {
  let config: unknown = filledDraft(type);
  const markers: string[] = [];
  for (const path of secretPaths(config)) {
    const original = getAt(config, path);
    if (typeof original !== "string") continue;
    const marker = `S3CR3TKEY${markers.length}Z`;
    const candidate = structuredClone(config) as unknown;
    setAt(candidate, path, marker + original);
    const parsed = type.configSchema.safeParse(candidate);
    if (!parsed.success) continue;
    config = parsed.data;
    markers.push(marker);
  }
  return { config, markers };
}

/** Every key name appearing anywhere in a serialised payload. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const child of value) keysOf(child, out);
    return out;
  }
  if (value === null || typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out.add(key);
    keysOf(child, out);
  }
  return out;
}

function checkType(id: string, type: AnyQuestionTypeServer): void {
  const { config, markers } = sowSecrets(type);
  const version = { config, configVersion: type.configVersion };
  const itemId = "33333333-3333-4333-8333-333333333333";

  // Two seeds, one with shuffling on: a permutation must not reorder a key
  // into the open, and the leak must not depend on the draw.
  for (const view of [
    { seed: 0, shuffle: false },
    { seed: 987_654, shuffle: true },
  ]) {
    const payload = studentView({ type: id, version, itemId, ...view });
    const serialized = JSON.stringify(payload);

    for (const forbidden of FORBIDDEN_STUDENT_KEYS) {
      expect(keysOf(payload), `${id}: forbidden key "${forbidden}"`).not.toContain(forbidden);
    }
    // The strip must not damage a type that plays by the rules: what comes
    // out still satisfies the type's OWN student schema.
    expect(
      type.studentSchema.safeParse(payload).success,
      `${id}: stripMetadata broke a legitimate student payload`,
    ).toBe(true);
    for (const marker of markers) {
      expect(serialized, `${id}: answer-key value leaked (${marker})`).not.toContain(marker);
    }
  }

  // The sowing must have reached the key, or the search above proved nothing.
  if (markers.length > 0) {
    const solution = JSON.stringify(type.toSolution(config, { seed: 0, itemId, shuffle: false }));
    expect(
      markers.some((marker) => solution.includes(marker)),
      `${id}: the markers never reached the solution — the fixture is wrong`,
    ).toBe(true);
  }
}

describe("studentView never leaks the key (invariant 4)", () => {
  const ids = registeredServerIds();

  it("covers every registered question type", () => {
    // If this list ever shrinks to nothing, the loop below would pass
    // vacuously — which is the one way this test could lie.
    expect(ids.length).toBeGreaterThan(0);
  });

  it("says which types the answer-key VALUE search actually exercises", () => {
    const coverage = Object.fromEntries(
      ids.map((id) => [id, sowSecrets(questionType(id)).markers.length]),
    );
    // A type that sows nothing keeps its key inside its authoring text
    // (`cloze`) or in a field that is not a string (`mcq`'s `correct`): for
    // those, the forbidden-KEY half above is the check, together with the
    // package's own `toStudent.test.ts`. A type that later adds a secret
    // string field is covered here automatically, with no edit to this file.
    expect(Object.values(coverage).some((n) => n > 0)).toBe(true);
  });

  for (const id of ids) {
    it(`keeps the key of "${id}" out of the student payload`, () => {
      checkType(id, questionType(id));
    });
  }

  it("keeps the key of the fake test type out too", () => {
    const restore = registerForTests(fakeShort);
    try {
      checkType("short", questionType("short"));
      // The fake sows into `answer`, so this one really exercises the search.
      expect(sowSecrets(questionType("short")).markers.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it("keeps the HIDDEN cases of a runner-backed type out of the student view", () => {
    const restore = registerForTests(fakeRunnableCode);
    try {
      const type = questionType("code");
      const config = type.configSchema.parse({
        template: "int main(){}",
        runsPerMinute: 3,
        cases: [
          { name: "visible-1", expected: "shown-output", visible: true },
          { name: "hidden-1", expected: "S3CR3THIDDEN", visible: false },
        ],
      });
      const payload = studentView({
        type: "code",
        version: { config, configVersion: type.configVersion },
        seed: 7,
        itemId: "44444444-4444-4444-8444-444444444444",
        shuffle: true,
      });
      const serialized = JSON.stringify(payload);
      expect(serialized).toContain("shown-output");
      expect(serialized).not.toContain("S3CR3THIDDEN");
      expect(serialized).not.toContain("hidden-1");
    } finally {
      restore();
    }
  });
});

describe("stripMetadata is the last line of defence", () => {
  /** A type that breaks the contract on purpose: the strip must still hold. */
  const rogue: AnyQuestionTypeServer = {
    ...fakeShort,
    toStudent: () => ({
      prompt: "visible",
      // Everything below is teacher-only and must never reach a browser.
      explanation: "because",
      correct: [0, 2],
      internalName: "Q17 — hard",
      tags: ["exam"],
      difficulty: 5,
      nested: { referenceSolution: "int main(){}" },
    }),
  } as unknown as AnyQuestionTypeServer;

  it("removes the forbidden keys a rogue type emitted, at any depth", () => {
    const restore = registerForTests(rogue);
    try {
      const payload = studentView({
        type: "short",
        version: { config: { statement: "s", answer: "a" }, configVersion: rogue.configVersion },
        seed: 1,
        itemId: "55555555-5555-4555-8555-555555555555",
        shuffle: false,
      });
      const keys = keysOf(payload);
      expect(keys).toContain("prompt");
      for (const forbidden of FORBIDDEN_STUDENT_KEYS) expect(keys).not.toContain(forbidden);
      expect(JSON.stringify(payload)).not.toContain("int main(){}");
    } finally {
      restore();
    }
  });

  it("leaves a legitimate payload untouched", () => {
    const payload = { prompt: "P", choices: [{ id: 0, text: "A" }], visibleCases: [{ expected: "ok" }] };
    expect(stripMetadata(payload)).toEqual(payload);
  });
});
