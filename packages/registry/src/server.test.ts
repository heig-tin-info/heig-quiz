import { ConfigMigrationError, UnknownQuestionType, type StudentView } from "@quiz/core/server";
import { findStudentLeaks, type StudentLeakFixture } from "@quiz/core/testing";
import { categorizeLeakFixture } from "@quiz/qt-categorize/testing";
import { circuitLeakFixture } from "@quiz/qt-circuit/testing";
import { clozeLeakFixture } from "@quiz/qt-cloze/testing";
import { codeimageLeakFixture, codeLeakFixture } from "@quiz/qt-code/testing";
import { diagramLeakFixture } from "@quiz/qt-diagram/testing";
import { mcqLeakFixture } from "@quiz/qt-mcq/testing";
import { richLeakFixture } from "@quiz/qt-rich/testing";
import { shortLeakFixture } from "@quiz/qt-short/testing";
import { describe, expect, it } from "vitest";
import { clientRegistry, questionTypeClient } from "./client.js";
import { QUESTION_TYPE_IDS, questionType, registeredServerIds, serverRegistry } from "./server.js";

/**
 * The four MVP types, `circuit` (docs/spec/04 §4.11), `codeimage` (§4.9),
 * `rich` (§4.8), `categorize` (§4.13) and `diagram` (§4.14), brought forward.
 */
const REGISTERED = ["mcq", "short", "cloze", "code", "circuit", "codeimage", "rich", "categorize", "diagram"] as const;
type RegisteredId = (typeof REGISTERED)[number];

/**
 * A deliberate CHANGE DETECTOR: the storage version of every type. Bumping
 * one is a decision — it needs a migration from the previous one (D16), and
 * every stored config of the type goes through it — so it must show up in a
 * diff of this file, not only in the package that made it.
 */
const CONFIG_VERSIONS: Record<RegisteredId, number> = {
  mcq: 2,
  short: 3,
  cloze: 2,
  code: 1,
  circuit: 1,
  codeimage: 1,
  rich: 1,
  categorize: 1,
  diagram: 1,
};

/**
 * The full configuration of every type, from its package's `./testing` entry
 * point: every secret a config of the type can hold, with the keys and values
 * that must never come out of `toStudent`. The record is keyed by the
 * registered ids, so a type added to `REGISTERED` without a fixture does not
 * compile, and one added to the registry alone fails "hold every registered
 * type".
 */
const LEAK_FIXTURES: Record<RegisteredId, StudentLeakFixture> = {
  mcq: mcqLeakFixture,
  short: shortLeakFixture,
  cloze: clozeLeakFixture,
  code: codeLeakFixture,
  circuit: circuitLeakFixture,
  codeimage: codeimageLeakFixture,
  rich: richLeakFixture,
  categorize: categorizeLeakFixture,
  diagram: diagramLeakFixture,
};

/**
 * Keys no type's `toStudent` may emit, beyond the common floor. They stay
 * out of COMMON_FORBIDDEN_STUDENT_KEYS because the API also STRIPS that floor
 * from every student payload (`stripMetadata`), feedback included: growing it
 * is a runtime change, not a test's to make.
 */
const CROSS_TYPE_FORBIDDEN_KEYS = ["policy", "tolerance"];

/** Shuffle on and off, under the teacher preview's seed (0) and two attempts'. */
const VIEWS: StudentView[] = [0, 7, 99].flatMap((seed) =>
  [true, false].map((shuffle) => ({ seed, itemId: "item-1", shuffle })),
);

describe("the static registries", () => {
  it("hold every registered type, in both halves", () => {
    expect(registeredServerIds()).toEqual([...REGISTERED]);
    expect(Object.keys(clientRegistry)).toEqual([...REGISTERED]);
  });

  it("look a type up by its id", () => {
    for (const id of REGISTERED) {
      expect(questionType(id).id).toBe(id);
      expect(questionTypeClient(id).id).toBe(id);
    }
  });

  it("reject an id that no package registers", () => {
    expect(() => questionType("drawing")).toThrow(UnknownQuestionType);
  });

  it("expose the nine ids", () => {
    expect(QUESTION_TYPE_IDS).toEqual([...REGISTERED]);
    expect(Object.keys(serverRegistry)).toEqual([...REGISTERED]);
  });

  it("agree with themselves: one client entry per server entry", () => {
    expect(Object.keys(clientRegistry)).toEqual(Object.keys(serverRegistry));
  });
});

/**
 * The contract every registered type is held to, run over the registry itself:
 * a type added later cannot forget any of it.
 */
describe.each(REGISTERED)("the contract of %s", (id) => {
  const type = questionType(id);
  const fixture = LEAK_FIXTURES[id];
  const forbiddenKeys = [...CROSS_TYPE_FORBIDDEN_KEYS, ...fixture.forbiddenKeys];

  it("has a leak fixture that is a valid config, and would catch it served whole", () => {
    expect(type.configSchema.safeParse(fixture.config).success).toBe(true);
    // A fixture whose secrets are not in its config proves nothing: the
    // identity `toStudent` must be reported by value (by key too, except for
    // `cloze`, whose whole key lives inside the authoring text).
    const leaks = findStudentLeaks(fixture.config, fixture);
    expect(leaks.some((leak) => leak.startsWith("secret value"))).toBe(true);
  });

  it("stores under its own configVersion", () => {
    expect(type.configVersion).toBe(CONFIG_VERSIONS[id]);
  });

  /*
   * Invariant 4 (docs/spec/05 §5.7, N-SEC-04): the full configuration through
   * `toStudent`, shuffle on and off, several seeds. Two independent checks on
   * the serialized view — no forbidden key (the common floor and the type's
   * own) and no secret value, which is what catches a leak that renamed its
   * field — and the view must be one the type's own student schema accepts.
   */
  it.each(VIEWS)("leaks no key and no secret (seed $seed, shuffle $shuffle)", (view) => {
    const student = type.toStudent(fixture.config, view);
    expect(findStudentLeaks(student, { forbiddenKeys, secrets: fixture.secrets })).toEqual([]);
    expect(type.studentSchema.safeParse(student).success).toBe(true);
  });

  it("serves its empty draft to the preview: no forbidden key, a valid student view", () => {
    const student = type.toStudent(type.emptyDraft(), { seed: 0, itemId: "item-1", shuffle: true });
    expect(findStudentLeaks(student, { forbiddenKeys })).toEqual([]);
    expect(type.studentSchema.safeParse(student).success).toBe(true);
  });

  it("emits an EMPTY draft, stamped with its own configVersion (D16)", () => {
    const draft = type.emptyDraft() as Record<string, unknown>;
    // An empty draft is the shape and the defaults, with no content: stored
    // as it stands, it does not validate. What it must carry is the version
    // it will be stored under, or a later `migrate` reads it wrong.
    expect(draft["configVersion"]).toBe(type.configVersion);
    expect(type.configSchema.safeParse(draft).success).toBe(false);
  });

  it("migrates its own current version by identity, draft and full config alike", () => {
    const draft = type.emptyDraft();
    expect(type.migrate(draft, type.configVersion)).toStrictEqual(draft);
    expect(type.migrate(fixture.config, type.configVersion)).toStrictEqual(fixture.config);
  });

  /*
   * What an OLDER version does is the type's own business — a real migration
   * (`mcq` v1, `short` v1, `cloze` v1), a reparse (`reparseMigrate`), or a
   * refusal — and is tested in its package.
   */
  it("refuses a config written by a newer platform", () => {
    expect(() => type.migrate(fixture.config, type.configVersion + 1)).toThrow(ConfigMigrationError);
  });
});
