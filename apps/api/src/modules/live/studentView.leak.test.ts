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
import {
  COMMON_FORBIDDEN_STUDENT_KEYS,
  type AnyQuestionTypeServer,
} from "@quiz/core/server";

import { fakeRunnableCode, fakeShort } from "../../test/fakeType.js";
import { keysOf } from "../../test/keys.js";
import { FORBIDDEN_STUDENT_KEYS, studentSolutionView, studentView, stripMetadata } from "./studentView.js";

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
  "reference",
  "referenceSolution",
  "regex",
  "rubric",
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
  /** Where each marker was sown, index for index. */
  paths: Path[];
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
/**
 * What a type's empty draft lacks for the search to reach its key. `code`'s
 * draft has one VISIBLE case, whose `expected` and `stdin` are published on
 * purpose and therefore not sown: without a HIDDEN case the value search
 * would never test the half that must stay closed (a `toStudent` publishing
 * a hidden `expected` stayed green here before this fixture).
 */
const DRAFT_COMPLETIONS: Record<string, (draft: unknown) => unknown> = {
  code: (draft) => {
    const config = draft as { tests: { cases: Record<string, unknown>[] } };
    const [visible] = config.tests.cases;
    return {
      ...config,
      tests: {
        ...config.tests,
        cases: [
          ...config.tests.cases,
          { ...visible, name: "", stdin: "", expected: "", args: [], visible: false },
        ],
      },
    };
  },
  /*
   * `codeimage`'s draft has no target, which no filler can turn into a
   * picture (one hex digit per cell, with its own dimensions). The target is PUBLISHED on purpose — it
   * is what the student must draw — so it is not sown; the reference solution
   * is, like `code`'s.
   */
  codeimage: (draft) => {
    const config = draft as { image: { width: number; height: number; palette: string } };
    const { width, height } = config.image;
    return { ...config, target: { ...config.image, pixels: "0".repeat(width * height) } };
  },
  /*
   * `rich`'s draft leaves out the optional model answer; the grader's two
   * texts are both sown, so the search covers each of them.
   */
  rich: (draft) => ({ ...(draft as object), reference: "" }),
  /*
   * `categorize`'s draft has two columns and no card, and a question needs
   * one card in a column (`categorize.no_target`). Its key is not a string
   * but the id lists inside the columns, which the value search cannot sow:
   * the test of its own below checks it.
   */
  categorize: (draft) => {
    const config = draft as { columns: { id: string; cards: string[] }[] };
    const [first, ...rest] = config.columns;
    return {
      ...config,
      columns: [{ ...first, cards: ["t4rg3tk1"] }, ...rest],
      cards: [
        { id: "t4rg3tk1", text: "" },
        { id: "d1str4ct", text: "" },
      ],
    };
  },
};

function filledDraft(type: AnyQuestionTypeServer): unknown {
  const complete = DRAFT_COMPLETIONS[type.id];
  const empty = type.emptyDraft() as unknown;
  const draft = complete === undefined ? empty : complete(empty);
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
  const paths: Path[] = [];
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
    paths.push(path);
  }
  return { config, markers, paths };
}

/**
 * Types whose sown strings are no part of their key: `circuit`'s is its
 * grading rubric, and its solution is the reference alone (ADR-037). Their
 * draft has no reference, so nothing sown is expected in the solution.
 */
const KEYLESS_SECRETS = new Set(["circuit"]);

function checkType(id: string, type: AnyQuestionTypeServer): void {
  const { config, markers } = sowSecrets(type);
  const version = { config, configVersion: type.configVersion, variables: null };
  const itemId = "33333333-3333-4333-8333-333333333333";

  // Two seeds, one with shuffling on: a permutation must not reorder a key
  // into the open, and the leak must not depend on the draw.
  for (const view of [
    { seed: 0, shuffle: false },
    { seed: 987_654, shuffle: true },
  ]) {
    const payload = studentView({ type: id, version, itemId, ...view });
    // The strip is defence in depth, never a filter a legitimate type relies
    // on: for a type that follows its contract it must remove NOTHING. This
    // is what catches a future floor entry that silently eats a legitimate
    // optional field (mcq `maxSelections`, short `placeholder`).
    const raw = type.toStudent(config, { itemId, ...view });
    expect(stripMetadata(raw), `${id}: stripMetadata removed a legitimate field`).toEqual(raw);
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

  if (markers.length === 0) return;
  const solution = JSON.stringify(type.toSolution(config, { seed: 0, itemId, shuffle: false }));
  if (KEYLESS_SECRETS.has(id)) {
    // What is sown here is no part of the key (ADR-037): neither the
    // teacher's solution nor a student's may carry it.
    const student = JSON.stringify(
      studentSolutionView({ type: id, version, seed: 0, itemId }) ?? null,
    );
    for (const marker of markers) {
      expect(solution, `${id}: teacher-only material in the solution (${marker})`).not.toContain(marker);
      expect(student, `${id}: teacher-only material in a student's key (${marker})`).not.toContain(marker);
    }
    return;
  }
  // The sowing must have reached the key, or the search above proved nothing.
  expect(
    markers.some((marker) => solution.includes(marker)),
    `${id}: the markers never reached the solution — the fixture is wrong`,
  ).toBe(true);
}

/**
 * The list this exit filtered on before `COMMON_FORBIDDEN_STUDENT_KEYS`
 * existed (audit 2026-09-22, finding P-06). It is pinned here so the
 * refactoring can be read as what it is: nothing was lost. The list may grow
 * past it freely; it may never shrink below it.
 */
const FORBIDDEN_STUDENT_KEYS_BEFORE_P06 = [
  "answerKey",
  "answers",
  "changeNote",
  "configVersion",
  "correct",
  "deprecationNote",
  "difficulty",
  "explanation",
  "hiddenCases",
  "internalName",
  "isCorrect",
  "matcher",
  "matchers",
  "pattern",
  "referenceSolution",
  "regex",
  "solution",
  "tags",
  "tolerance",
];

describe("the forbidden-key list only grows", () => {
  it("still forbids everything it forbade before the shared floor", () => {
    for (const key of FORBIDDEN_STUDENT_KEYS_BEFORE_P06) {
      expect(FORBIDDEN_STUDENT_KEYS, key).toContain(key);
    }
  });

  it("is a superset of the floor every question type shares", () => {
    for (const key of COMMON_FORBIDDEN_STUDENT_KEYS) {
      expect(FORBIDDEN_STUDENT_KEYS, key).toContain(key);
    }
  });

  it("holds no duplicate, so the two halves do not overlap", () => {
    expect(new Set(FORBIDDEN_STUDENT_KEYS).size).toBe(FORBIDDEN_STUDENT_KEYS.length);
  });
});

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

  it("sows a marker into a HIDDEN case of the real `code` type", () => {
    // The fixture above must put the closed half of `code` under the value
    // search: a hidden case's `expected` carries a marker, and it is one the
    // solution (the key) does show.
    const code = questionType("code");
    const { config, markers } = sowSecrets(code);
    const hidden = (config as { tests: { cases: { visible: boolean; expected: string }[] } }).tests.cases.find(
      (c) => !c.visible,
    );
    expect(hidden).toBeDefined();
    expect(markers.some((m) => hidden!.expected.startsWith(m))).toBe(true);
  });

  it("sows the rubric and the model answer of the real `rich` type", () => {
    // An essay's whole key is two strings: both must be under the value search.
    expect(sowSecrets(questionType("rich")).markers).toHaveLength(2);
  });

  it("hands `categorize` the evaluation's negative marking, and its columns no key (ADR-036)", () => {
    // What studentView adds to the type's own toStudent (tested in
    // packages/qt-categorize): the evaluation's defaults reach the type, which
    // publishes the flag and nothing else of them; the columns' key stays home.
    const type = questionType("categorize");
    const payload = studentView({
      type: "categorize",
      version: { config: filledDraft(type), configVersion: type.configVersion, variables: null },
      seed: 0,
      itemId: "55555555-5555-4555-8555-555555555555",
      shuffle: false,
      defaults: { categorize: { policy: "all_or_nothing", negativeMarking: true } },
    }) as { columns: Record<string, unknown>[]; negativeMarking?: boolean };
    expect(payload.negativeMarking).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("all_or_nothing");
    for (const column of payload.columns) expect(column).not.toHaveProperty("cards");
  });

  it("keeps the reference diagram of `diagram` out, and its starter in (ADR-046)", () => {
    // The key of a diagram is a SCENE, whose texts sit under keys (`name`,
    // `body`) the value search above does not sow: this test does it by
    // hand. The starter shares no value with the reference, ids included.
    const type = questionType("diagram");
    const config = type.configSchema.parse({
      configVersion: 1,
      prompt: "Draw the class diagram.",
      kind: "class",
      reference: {
        nodes: [
          { id: "s3cr3tn1", t: "class", x: 0, y: 0, name: "S3CR3TCLASS", body: ["- S3CR3TFIELD : int"] },
          { id: "s3cr3tn2", t: "class", x: 0, y: 200, name: "S3CR3TCHILD" },
        ],
        links: [{ id: "s3cr3tl1", type: "inh", a: "s3cr3tn2", b: "s3cr3tn1", name: "S3CR3TLINK" }],
      },
      starter: { nodes: [{ id: "st4rt001", t: "class", x: 40, y: 40, name: "Given" }], links: [] },
      rubric: "S3CR3TRUBRIC",
    });
    const payload = studentView({
      type: "diagram",
      version: { config, configVersion: type.configVersion, variables: null },
      seed: 0,
      itemId: "77777777-7777-4777-8777-777777777777",
      shuffle: false,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/s3cr3t|S3CR3T/);
    expect(keysOf(payload)).not.toContain("reference");
    expect(payload).toEqual({
      prompt: "Draw the class diagram.",
      kind: "class",
      starter: (config as { starter: unknown }).starter,
    });
  });

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
        version: { config, configVersion: type.configVersion, variables: null },
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

/**
 * ADR-037: grading criteria are the teacher's even under a shown key. The
 * student's key (`studentSolutionView`, the one exit every student-facing
 * reader of a key uses) must carry no sown `rubric`, for every registered
 * type. That the essay's model answer still travels is the feedback route's
 * test (`results/feedback.db.test.ts`).
 */
describe("studentSolutionView keeps the teacher's material home (ADR-037)", () => {
  const itemId = "66666666-6666-4666-8666-666666666666";
  const studentKeyOf = (id: string, config: unknown) =>
    studentSolutionView({
      type: id,
      version: { config, configVersion: questionType(id).configVersion, variables: null },
      seed: 0,
      itemId,
    });

  const rubricTypes: string[] = [];
  for (const id of registeredServerIds()) {
    it(`serves no grading criteria of "${id}" to a student`, () => {
      const { config, markers, paths } = sowSecrets(questionType(id));
      const serialized = JSON.stringify(studentKeyOf(id, config) ?? null);
      markers.forEach((marker, i) => {
        if (paths[i]!.at(-1) !== "rubric") return;
        rubricTypes.push(id);
        expect(serialized, `${id}: the rubric reached a student (${marker})`).not.toContain(marker);
      });
    });
  }

  it("really sowed a rubric into the essay and the circuit", () => {
    // Runs after the loop above: without a sown rubric it proved nothing.
    expect(rubricTypes).toEqual(expect.arrayContaining(["rich", "circuit"]));
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
        version: { config: { statement: "s", answer: "a" }, configVersion: rogue.configVersion, variables: null },
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

  it("lets code's comparison options through: HOW, never WHAT (audit R-06)", () => {
    // The player judges a visible case with the grade's own options; stripping
    // them here would put the two back out of step.
    const compare = { trimTrailing: true, ignoreCase: true, numeric: { epsilon: 0.01, mode: "abs" } };
    expect(stripMetadata({ prompt: "P", compare })).toEqual({ prompt: "P", compare });
  });
});
