import { ConfigMigrationError, isGraded, UnknownQuestionType, type StudentView } from "@quiz/core/server";
import { findStudentLeaks, testGradeContext, type StudentLeakFixture } from "@quiz/core/testing";
import { LABELS, scopeZones, type Block, type Lang } from "@quiz/docexport";
import { markdownBody } from "@quiz/docexport/markdown";
import { renderTypst } from "@quiz/docexport/typst";
import { blocksLeakFixture } from "@quiz/qt-blocks/testing";
import { brainstormLeakFixture } from "@quiz/qt-brainstorm/testing";
import { categorizeLeakFixture } from "@quiz/qt-categorize/testing";
import { circuitLeakFixture, logicLeakFixture } from "@quiz/qt-circuit/testing";
import { clozeLeakFixture } from "@quiz/qt-cloze/testing";
import { codeimageLeakFixture, codeLeakFixture } from "@quiz/qt-code/testing";
import { diagramLeakFixture } from "@quiz/qt-diagram/testing";
import { mathLeakFixture } from "@quiz/qt-math/testing";
import { mcqLeakFixture } from "@quiz/qt-mcq/testing";
import { richLeakFixture } from "@quiz/qt-rich/testing";
import { shortLeakFixture } from "@quiz/qt-short/testing";
import { describe, expect, it } from "vitest";
import { clientRegistry, questionTypeClient } from "./client.js";
import { QUESTION_TYPE_IDS, questionType, registeredServerIds, serverRegistry } from "./server.js";

/**
 * The four MVP types, `circuit` (docs/spec/04 §4.11), `logic` (§4.18), `codeimage` (§4.9),
 * `rich` (§4.8), `categorize` (§4.13), `diagram` (§4.14) and `math` (§4.16),
 * brought forward, `brainstorm` (ADR-071) and `blocks` (§4.17).
 */
const REGISTERED = [
  "mcq",
  "short",
  "cloze",
  "code",
  "circuit",
  "logic",
  "codeimage",
  "rich",
  "categorize",
  "diagram",
  "brainstorm",
  "math",
  "blocks",
] as const;
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
  logic: 1,
  codeimage: 1,
  rich: 2,
  categorize: 1,
  diagram: 1,
  brainstorm: 1,
  math: 1,
  blocks: 1,
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
  logic: logicLeakFixture,
  codeimage: codeimageLeakFixture,
  rich: richLeakFixture,
  categorize: categorizeLeakFixture,
  diagram: diagramLeakFixture,
  brainstorm: brainstormLeakFixture,
  math: mathLeakFixture,
  blocks: blocksLeakFixture,
};

/**
 * Keys no type's `toStudent` may emit, beyond the common floor. They stay
 * out of COMMON_FORBIDDEN_STUDENT_KEYS because the API also STRIPS that floor
 * from every student payload (`stripMetadata`), feedback included: growing it
 * is a runtime change, not a test's to make.
 */
const CROSS_TYPE_FORBIDDEN_KEYS = ["policy", "tolerance"];

/** The languages a student document is worded in (ADR-125). */
const LANGS: readonly Lang[] = ["en", "fr"];

/** The provenance of a rendered test document: ids only, none of a fixture. */
const PROVENANCE = { kind: "test", version: 1, source: {}, attempts: [], generatedAt: "2026-11-04T10:00:00.000Z", app: null };

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

  it("expose the thirteen ids", () => {
    expect(QUESTION_TYPE_IDS).toEqual([...REGISTERED]);
    expect(Object.keys(serverRegistry)).toEqual([...REGISTERED]);
  });

  it("draw as text the types ADR-121 §2 and ADR-125 name, a paper zone for the printable ones", () => {
    const withStatement = REGISTERED.filter((id) => questionType(id).statementDoc !== undefined);
    expect(withStatement).toEqual(["mcq", "short", "cloze", "code", "rich", "math", "blocks"]);
    const withZone = REGISTERED.filter((id) => questionType(id).answerZone !== undefined);
    expect(withZone).toEqual(["mcq", "short", "cloze", "rich", "math", "blocks"]);
    const withOwnCopy = REGISTERED.filter((id) => questionType(id).studentAnswerDoc !== undefined);
    expect(withOwnCopy).toEqual(withZone);
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

  /** No forbidden key nor secret in the block tree, and no secret in its text rendered in `lang` (05 §5.7). */
  const expectNoLeak = (blocks: readonly Block[], lang: Lang) => {
    expect(findStudentLeaks(blocks, { forbiddenKeys, secrets: fixture.secrets })).toEqual([]);
    const text = markdownBody({ lang, blocks });
    expect(fixture.secrets.filter((secret) => text.includes(secret))).toEqual([]);
  };

  it("has a leak fixture that is a valid config, and would catch it served whole", () => {
    expect(type.configSchema.safeParse(fixture.config).success).toBe(true);
    // A fixture whose secrets are not in its config proves nothing: the
    // identity `toStudent` must be reported by value (by key too, except for
    // `cloze`, whose whole key lives inside the authoring text).
    const leaks = findStudentLeaks(fixture.config, fixture);
    if (type.hasKey?.(fixture.config) === false && fixture.secrets.length === 0) {
      // A type with NO key at all (`brainstorm`, ADR-071) has no secret value
      // to plant. Its proof is narrower and still strict: nothing to reveal,
      // and the identity `toStudent` is caught by key.
      expect(type.toSolution(fixture.config, VIEWS[0]!)).toBeNull();
      expect(leaks.some((leak) => leak.startsWith("forbidden key"))).toBe(true);
      return;
    }
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

  /*
   * ADR-097: what a student sends and reads back is in the coordinates of the
   * view they were served; what is stored is canonical. Over every view, the
   * two conversions are each other's inverse on the fixture's answers, and
   * what the student reads back still parses under the type's own schema.
   */
  it.each(VIEWS)("round-trips its answers through the student's view (seed $seed, shuffle $shuffle)", (view) => {
    for (const stored of fixture.answers ?? []) {
      const answer = type.answerSchema.parse(stored);
      const shown = type.toStudentAnswer ? type.toStudentAnswer(fixture.config, view, answer) : answer;
      expect(type.answerSchema.safeParse(shown).success).toBe(true);
      const back = type.fromStudentAnswer ? type.fromStudentAnswer(fixture.config, view, shown) : shown;
      expect(back).toEqual(answer);
    }
  });

  /*
   * The export factory (ADR-121 §2, ADR-125; 05 §5.7): a statement drawn as
   * a document, and its paper zones, come from the student view only. Two
   * checks, as above, on the block tree — and the secret values again on
   * the RENDERED text, in both languages a hand-out is worded in.
   */
  if (type.statementDoc || type.answerZone) {
    it.each(VIEWS)("draws its statement and paper zones with no key (seed $seed, shuffle $shuffle)", (view) => {
      const student = type.toStudent(fixture.config, view);
      for (const lang of LANGS) {
        const blocks = [...(type.statementDoc?.(student, LABELS[lang]) ?? []), ...(type.answerZone?.(student) ?? [])];
        expectNoLeak(blocks, lang);
      }
    });

    /*
     * The second form of ADR-125 §19: the same statement and zones as the
     * Typst source of a PDF, searched for the secrets and for a forbidden key
     * written as a dictionary key — escapes undone first, since `typstText`
     * writes `3.14` as `3\.14`. The third form, the PDF's text through
     * `pdftotext`, will run on the real documents that hold whole papers —
     * the hand-out (`handout.pdf`) and the student's own copy — when their
     * routes land.
     */
    it.each(VIEWS)("renders its statement and paper zones to Typst with no key (seed $seed, shuffle $shuffle)", (view) => {
      const student = type.toStudent(fixture.config, view);
      for (const lang of LANGS) {
        const blocks = scopeZones("item-1", [
          ...(type.statementDoc?.(student, LABELS[lang]) ?? []),
          ...(type.answerZone?.(student) ?? []),
        ]);
        const { source } = renderTypst({ provenance: PROVENANCE, lang, blocks });
        // The body only: the page setup and the preamble are ours, fixed words of Typst.
        const body = source.slice(source.indexOf("<provenance>")).replace(/\\(.)/g, "$1");
        expect(fixture.secrets.filter((secret) => body.includes(secret)), lang).toEqual([]);
        expect(forbiddenKeys.filter((key) => new RegExp(`["(,\\s]${key}"?\\s*:`).test(body)), lang).toEqual([]);
      }
    });
  }

  /*
   * The student's own copy (ADR-125, invariant 4): each fixture answer,
   * graded, its breakdown through `studentDetails` under a HIDDEN key and
   * the answer brought back to the view, drawn by `studentAnswerDoc` — no
   * key in the blocks nor in their text. The fixture's answers are none of
   * its secrets, so whatever is found came from the key.
   */
  if (type.studentAnswerDoc) {
    const studentAnswerDoc = type.studentAnswerDoc.bind(type);
    it.each(VIEWS)("draws a student's own answer with no key (seed $seed, shuffle $shuffle)", async (view) => {
      expect(fixture.answers?.length ?? 0).toBeGreaterThan(0);
      const student = type.toStudent(fixture.config, view);
      for (const stored of fixture.answers ?? []) {
        const answer = type.answerSchema.parse(stored);
        const graded = await type.grade(fixture.config, answer, testGradeContext(1));
        const details = isGraded(graded)
          ? type.studentDetails
            ? type.studentDetails(graded.details, { showKey: false, showHiddenCaseNames: false })
            : graded.details
          : null;
        const shown = type.toStudentAnswer ? type.toStudentAnswer(fixture.config, view, answer) : answer;
        for (const lang of LANGS) expectNoLeak(studentAnswerDoc(student, shown, details, LABELS[lang]), lang);
      }
    });
  }

  it("converts the answer in both directions or in neither (ADR-097)", () => {
    expect(type.fromStudentAnswer === undefined).toBe(type.toStudentAnswer === undefined);
    if (type.fromStudentAnswer) expect(fixture.answers?.length ?? 0).toBeGreaterThan(0);
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

/*
 * The editor's AI card (ADR-082) offers "Generate answers" only once the
 * statement is written, and reads that statement as `config.prompt`
 * (`draftStatement`, apps/web/src/question/generate.tsx); the server reads it
 * through each generator's `statement` and refuses an empty one
 * (`statement_empty`). This holds the two together for EVERY registration
 * with a generator: a type added later that keeps its statement elsewhere
 * fails here, not in a teacher's editor.
 */
const WITH_GENERATOR = Object.values(serverRegistry).filter((type) => type?.generator !== undefined);

describe("every generator reads its statement from config.prompt", () => {
  it("covers the types that have a wand", () => {
    expect(WITH_GENERATOR.length).toBeGreaterThan(0);
  });

  it.each(WITH_GENERATOR.map((type) => [type!.id, type!] as const))("%s", (id, type) => {
    const config = LEAK_FIXTURES[id as RegisteredId].config as Record<string, unknown>;
    const statement = type.generator!.statement as (config: unknown) => string;
    expect(typeof config["prompt"]).toBe("string");
    expect(statement(config)).toBe(config["prompt"]);
    const { prompt: _prompt, ...withoutPrompt } = config;
    expect(statement(withoutPrompt)).toBe("");
  });
});
