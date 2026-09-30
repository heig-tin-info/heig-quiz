/**
 * The `diagram` schemas (docs/spec/04 §4.14, ADR-046): the student draws a
 * diagram of the notation the teacher chose — a UML class diagram, a state
 * machine, a flowchart… — graded by hand in v1.
 *
 * The SCENE is the record (ADR-046 §2): the reference, the starter and the
 * answer are all scenes of `@quiz/diagram`, bounded by its `SceneSchema`
 * (counts, lengths, 50 000 characters of text, no control character). The
 * text form of a scene is derived by the kind's serialiser and never stored.
 */
import { z } from "zod";

import { DIAGRAM_KINDS, SceneSchema, emptyScene, isEmptyScene, type Scene } from "@quiz/diagram/server";

export const DIAGRAM_CONFIG_VERSION = 1;

export const DiagramKindSchema = z.enum(DIAGRAM_KINDS);

export const DiagramConfigSchema = z.object({
  configVersion: z.literal(DIAGRAM_CONFIG_VERSION),
  prompt: z.string().min(1).max(20_000),
  /** The notation, chosen once per question: the student's toolbox holds its elements and nothing else. */
  kind: DiagramKindSchema,
  /**
   * The teacher's own diagram: the key. A draft may leave it empty; the
   * publication refuses it then (`diagram.reference_missing`, see
   * `publicationIssues`), so a question can be previewed before it is drawn.
   */
  reference: SceneSchema,
  /** What the student starts from; absent, an empty canvas. */
  starter: SceneSchema.optional(),
  /** The criteria, in markdown, for the grader alone (ADR-037). */
  rubric: z.string().max(20_000).default(""),
});
export type DiagramConfig = z.infer<typeof DiagramConfigSchema>;

/** The whole scene, sent whole by the autosave: `SceneSchema` bounds it. */
export const DiagramAnswerSchema = z.strictObject({ scene: SceneSchema });
export type DiagramAnswer = z.infer<typeof DiagramAnswerSchema>;

/**
 * THE one predicate behind both `isAnswered` hooks (issue #89): a stored
 * scene that holds something. The player writes nothing until the student's
 * first edit, so a question whose starter was never touched has no answer
 * at all; one edited back to the starter still counts as answered here, and
 * `grade` settles it as empty (decision 1 of the ADR-046 addendum).
 */
export function isDiagramAnswered(answer: DiagramAnswer): boolean {
  return !isEmptyScene(answer.scene);
}

/** What the scene of an answer starts as: a copy of the starter, or nothing. */
export const startingScene = (starter: Scene | undefined): Scene => starter ?? emptyScene();

/**
 * What a student may see (invariant 4): the statement, the notation and the
 * starter. STRICT, so a field added to the config one day cannot ride along
 * unnoticed: the reference and the rubric never leave.
 */
export const DiagramStudentSchema = z.strictObject({
  prompt: z.string(),
  kind: DiagramKindSchema,
  starter: SceneSchema.optional(),
});
export type DiagramStudent = z.infer<typeof DiagramStudentSchema>;

/**
 * The key: the reference diagram and the rubric. A student under a shown key
 * gets the reference alone (`studentSolution`, ADR-037), hence the optional
 * rubric.
 */
export const DiagramSolutionSchema = z.strictObject({
  reference: SceneSchema,
  rubric: z.string().optional(),
});
export type DiagramSolution = z.infer<typeof DiagramSolutionSchema>;

/**
 * `manual`: a person grades it, the 0 points are a placeholder. `empty`: no
 * answer, or the starter untouched, and the 0 is the grade. `kind_mismatch`:
 * the answer holds what the question's kind does not have — a regrade against
 * a newer version of another kind (F-GRADE-06) — and a person grades it too.
 * The counts are what the grading table shows (decision 3 of the addendum).
 */
export const DiagramDetailsSchema = z.object({
  reason: z.enum(["manual", "empty", "kind_mismatch"]),
  nodes: z.number().int().min(0),
  links: z.number().int().min(0),
});
export type DiagramDetails = z.infer<typeof DiagramDetailsSchema>;

/** See `emptyMcqDraft`: the shape and the defaults, no content, may be invalid. */
export function emptyDiagramDraft(): DiagramConfig {
  return {
    configVersion: DIAGRAM_CONFIG_VERSION,
    prompt: "",
    kind: "class",
    reference: emptyScene(),
    rubric: "",
  };
}
