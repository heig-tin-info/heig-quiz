/**
 * `@quiz/qt-rich/server` — the server half of the `rich` type, shown as
 * "Essay" / « Rédaction » (docs/spec/04 §4.8, issue #192).
 *
 * No React in this import graph: the API and the grading worker load it.
 *
 * Graded BY HAND unless the process has an LLM service: `grade` proposes 0
 * points for every written answer — the precedent is `circuit` in `manual`
 * mode — and the teacher settles it in the grading panel, the answer beside
 * the rubric and the model answer. With a service (`GradeContext.llm`, only
 * the development stub yet) and something to grade against, the essay goes
 * to it instead (`pending: 'llm'`, docs/spec/04 §4.8, F-GRADE-02).
 */
import { ConfigMigrationError, type QuestionTypeServer } from "@quiz/core/server";

import { richGenerator } from "./generate.js";
import {
  countChars,
  emptyRichDraft,
  isRichAnswered,
  RICH_CONFIG_VERSION,
  RichAnswerSchema,
  RichConfigSchema,
  RichDetailsSchema,
  RichSolutionSchema,
  RichStudentSchema,
  type RichAnswer,
  type RichConfig,
  type RichDetails,
  type RichSolution,
  type RichStudent,
} from "./schema.js";

export const richServer: QuestionTypeServer<
  RichConfig,
  RichAnswer,
  RichStudent,
  RichSolution,
  RichDetails
> = {
  id: "rich",
  configVersion: RICH_CONFIG_VERSION,

  configSchema: RichConfigSchema,
  answerSchema: RichAnswerSchema,
  isAnswered: isRichAnswered,
  studentSchema: RichStudentSchema,
  solutionSchema: RichSolutionSchema,
  detailsSchema: RichDetailsSchema,

  emptyDraft: emptyRichDraft,

  migrate(config: unknown, fromVersion: number): RichConfig {
    if (fromVersion === RICH_CONFIG_VERSION) return config as RichConfig;
    throw new ConfigMigrationError("rich", fromVersion, RICH_CONFIG_VERSION, "unknown source version");
  },

  defaultPoints: () => 1,

  /** Nothing to shuffle: one statement, one field. */
  shuffleable: () => false,

  /**
   * THE single exit toward a student (invariant 4): the rubric and the model
   * answer are dropped whole. The limit stays — it is what the field takes.
   */
  toStudent(config): RichStudent {
    const student: RichStudent = { prompt: config.prompt, format: config.format };
    if (config.maxChars !== undefined) student.maxChars = config.maxChars;
    return student;
  },

  toSolution(config): RichSolution {
    return config.reference === undefined
      ? { rubric: config.rubric }
      : { rubric: config.rubric, reference: config.reference };
  },

  /**
   * The grading criteria are the teacher's, whatever the feedback policy
   * (ADR-037): a student under a shown key reads the model answer, and
   * nothing at all when there is none.
   */
  studentSolution(solution): RichSolution | null {
    return solution.reference === undefined || solution.reference.trim() === ""
      ? null
      : { reference: solution.reference };
  },

  /**
   * The question's own limit, which `answerSchema` cannot see: the autosave
   * refuses a longer answer with `422 answer_invalid`. The player never sends
   * one; this is the server's word, for a client that would.
   */
  answerMisfit(config, answer) {
    return config.maxChars !== undefined && countChars(answer.text) > config.maxChars
      ? "rich.too_long"
      : null;
  },

  /**
   * Nothing written is worth 0, and that IS the grade. Anything else goes to
   * the LLM service when there is one and a rubric or a model answer to
   * grade against — the request holds the criteria and the text, nothing
   * that names the student (F-LLM-04) — and is otherwise a proposal of 0
   * points that a teacher must settle (F-GRADE-01).
   */
  grade(config, answer, ctx) {
    const chars = answer === null ? 0 : countChars(answer.text);
    if (answer === null || !isRichAnswered(answer)) {
      return { kind: "graded", points: 0, maxPoints: ctx.itemPoints, details: { reason: "empty", chars } };
    }
    const reference = config.reference?.trim() ?? "";
    if (ctx.llm !== undefined && (config.rubric.trim() !== "" || reference !== "")) {
      return {
        kind: "pending",
        via: "llm",
        request: {
          statement: config.prompt,
          form: config.format === "markdown" ? "free text, in markdown" : "free text",
          rubric: config.rubric,
          ...(reference === "" ? {} : { reference }),
          answer: answer.text,
          maxPoints: ctx.itemPoints,
        },
        details: { reason: "llm", chars },
      };
    }
    return { kind: "graded", points: 0, maxPoints: ctx.itemPoints, details: { reason: "manual", chars }, state: "proposed" };
  },

  /**
   * The live grid (F-DASH-02): how MUCH the student wrote, never the first
   * line of it — a sentence cut at two dozen characters says nothing, a
   * count says whether they are writing.
   */
  summarizeAnswer(config, answer) {
    // Figures only: the cell is not translated, and "412/1500" reads the same in both languages.
    const chars = countChars(answer.text);
    return config.maxChars === undefined ? String(chars) : `${chars}/${config.maxChars}`;
  },

  /** Teacher-facing (`question_versions.search`): the rubric and the model answer belong in it. */
  searchText: (config) => [config.prompt, config.rubric, config.reference ?? ""].join("\n"),

  generator: richGenerator,
};
