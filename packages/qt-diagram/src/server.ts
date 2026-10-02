/**
 * `@quiz/qt-diagram/server` — the server half of the `diagram` type, shown as
 * "Diagram" / « Diagramme » (docs/spec/04 §4.14, ADR-046).
 *
 * No React in this import graph: the API and the grading worker load it. The
 * engine's server entry (`@quiz/diagram/server`) brings the scene schema and
 * the catalogue of kinds, and no parser (ADR-046 §2).
 *
 * Graded BY HAND in v1, like `rich`: `grade` proposes 0 points for a drawn
 * answer and the teacher settles it in the grading panel, the answer above
 * the reference and both text forms.
 */
import { ConfigMigrationError, type PublicationIssue, type QuestionTypeServer } from "@quiz/core/server";
import { isEmptyScene, kindIssues, sameScene, toText, type DiagramKind, type Scene } from "@quiz/diagram/server";

import {
  DIAGRAM_CONFIG_VERSION,
  DiagramAnswerSchema,
  DiagramConfigSchema,
  DiagramDetailsSchema,
  DiagramSolutionSchema,
  DiagramStudentSchema,
  emptyDiagramDraft,
  isDiagramAnswered,
  startingScene,
  type DiagramAnswer,
  type DiagramConfig,
  type DiagramDetails,
  type DiagramSolution,
  type DiagramStudent,
} from "./schema.js";

/** Every text a scene carries, for the teacher's search. */
const textsOf = (scene: Scene): string[] => [
  ...scene.nodes.flatMap((n) => [n.name ?? "", n.stereo ?? "", ...(n.body ?? [])]),
  ...scene.links.map((l) => l.name ?? ""),
];

/** What the model reads, per kind: the text form of its codec (ADR-046 §2); `free` has none. */
const FORMS: Readonly<Record<DiagramKind, string | null>> = {
  class: "a UML class diagram in PlantUML",
  usecase: "a UML use case diagram in PlantUML",
  state: "a state diagram in Mermaid",
  er: "an entity-relationship diagram in Mermaid",
  flow: "a flowchart in Mermaid",
  automaton: "a finite automaton in Graphviz DOT",
  graph: "a graph in Graphviz DOT",
  free: null,
};

export const diagramServer: QuestionTypeServer<
  DiagramConfig,
  DiagramAnswer,
  DiagramStudent,
  DiagramSolution,
  DiagramDetails
> = {
  id: "diagram",
  configVersion: DIAGRAM_CONFIG_VERSION,

  configSchema: DiagramConfigSchema,
  answerSchema: DiagramAnswerSchema,
  isAnswered: isDiagramAnswered,
  studentSchema: DiagramStudentSchema,
  solutionSchema: DiagramSolutionSchema,
  detailsSchema: DiagramDetailsSchema,

  emptyDraft: emptyDiagramDraft,

  migrate(config: unknown, fromVersion: number): DiagramConfig {
    if (fromVersion === DIAGRAM_CONFIG_VERSION) return config as DiagramConfig;
    throw new ConfigMigrationError("diagram", fromVersion, DIAGRAM_CONFIG_VERSION, "unknown source version");
  },

  /**
   * A draft may lack its reference — the teacher previews the question
   * before drawing it — but a published question has one, and its reference
   * and starter hold only what the kind has: a starter with a state machine's
   * transition in a class diagram would hand the student a tool the toolbox
   * does not offer.
   */
  publicationIssues(config): PublicationIssue[] {
    const issues: PublicationIssue[] = [];
    if (isEmptyScene(config.reference)) issues.push({ path: ["reference"], message: "diagram.reference_missing" });
    else if (kindIssues(config.reference, config.kind).length > 0) {
      issues.push({ path: ["reference"], message: "diagram.kind_mismatch" });
    }
    if (config.starter !== undefined && kindIssues(config.starter, config.kind).length > 0) {
      issues.push({ path: ["starter"], message: "diagram.kind_mismatch" });
    }
    return issues;
  },

  defaultPoints: () => 1,

  /** Nothing to shuffle: one canvas. */
  shuffleable: () => false,

  /**
   * THE single exit toward a student (invariant 4): the statement, the kind
   * and the starter. The reference and the rubric never leave, and the text
   * form is the teacher's (ADR-046 §4).
   */
  toStudent(config): DiagramStudent {
    const student: DiagramStudent = { prompt: config.prompt, kind: config.kind };
    if (config.starter !== undefined) student.starter = config.starter;
    return student;
  },

  toSolution: (config) => ({ reference: config.reference, rubric: config.rubric }),

  /** The rubric is the teacher's whatever the feedback policy (ADR-037): a student reads the reference alone. */
  studentSolution: (solution) => ({ reference: solution.reference }),

  /**
   * The kind's own rules, which `answerSchema` cannot see: an element or a
   * link of another notation, or more elements than the kind allows. The
   * player's toolbox cannot produce one; a crafted write can, and is refused
   * with `422 answer_invalid`.
   */
  answerMisfit(config, answer) {
    return kindIssues(answer.scene, config.kind).length > 0 ? "diagram.answer_misfit" : null;
  },

  /**
   * No answer, an empty scene or the untouched starter is worth 0, and that
   * IS the grade. Anything else goes to the LLM service when there is one,
   * in the kind's text form beside the reference's (ADR-063); otherwise, and
   * for `free`, which has no text form, it is a proposal of 0 points that a
   * teacher settles (F-GRADE-01).
   *
   * An answer drawn for ANOTHER kind is possible: a regrade may repoint an
   * item at a newer published version (F-GRADE-06), and a version published
   * outside the editor (MCP, an import) may carry another kind. It is never
   * called empty — a student drew something — but a proposal with its reason.
   */
  grade(config, answer, ctx) {
    const nodes = answer?.scene.nodes.length ?? 0;
    const links = answer?.scene.links.length ?? 0;
    const proposal = (reason: "manual" | "kind_mismatch") =>
      ({ kind: "graded", points: 0, maxPoints: ctx.itemPoints, details: { reason, nodes, links }, state: "proposed" }) as const;
    if (answer === null || !isDiagramAnswered(answer)) {
      return { kind: "graded", points: 0, maxPoints: ctx.itemPoints, details: { reason: "empty", nodes, links } };
    }
    if (kindIssues(answer.scene, config.kind).length > 0) return proposal("kind_mismatch");
    if (sameScene(answer.scene, startingScene(config.starter))) {
      return { kind: "graded", points: 0, maxPoints: ctx.itemPoints, details: { reason: "empty", nodes, links } };
    }
    const form = FORMS[config.kind];
    const answerText = ctx.llm === undefined || form === null ? null : toText(answer.scene, config.kind);
    if (form === null || answerText === null) return proposal("manual");
    return {
      kind: "pending",
      via: "llm",
      request: {
        statement: config.prompt,
        form,
        rubric: config.rubric,
        reference: toText(config.reference, config.kind) ?? "",
        answer: answerText,
        maxPoints: ctx.itemPoints,
      },
      details: { reason: "llm", nodes, links },
    };
  },

  /**
   * The live grid (F-DASH-02): how many elements and links, "5 · 4". Figures
   * only: the cell is not translated, and it says nothing of whether the
   * diagram is right.
   */
  summarizeAnswer: (_config, answer) => `${answer.scene.nodes.length} · ${answer.scene.links.length}`,

  /*
   * No `aggregate`: a distribution of opaque ids would say nothing a teacher
   * can read. The item keeps its success rate.
   */

  /** Teacher-facing (`question_versions.search`): the rubric and the reference's names belong in it. */
  searchText: (config) =>
    [config.prompt, config.rubric, ...textsOf(config.reference)].filter((text) => text !== "").join("\n"),
};
