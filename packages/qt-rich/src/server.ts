/**
 * `@quiz/qt-rich/server` — the server half of the `rich` type, shown as
 * "Essay" / « Rédaction » (docs/spec/04 §4.8, issue #192).
 *
 * No React in this import graph: the API and the grading worker load it.
 *
 * v1 is graded BY HAND. `grade` proposes 0 points for every written answer —
 * the precedent is `circuit` in `manual` mode — and the teacher settles it in
 * the grading panel, the answer beside the rubric and the model answer. The
 * LLM path of the spec (`pending: 'llm'`) stays for a later iteration.
 */
import { ConfigMigrationError, type QuestionTypeServer } from "@quiz/core/server";
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
   * Nothing written is worth 0, and that IS the grade. Anything else is a
   * proposal of 0 points that a teacher must settle (F-GRADE-01).
   */
  grade(_config, answer, ctx) {
    const chars = answer === null ? 0 : countChars(answer.text);
    const written = answer !== null && isRichAnswered(answer);
    return written
      ? { kind: "graded", points: 0, maxPoints: ctx.itemPoints, details: { reason: "manual", chars }, state: "proposed" }
      : { kind: "graded", points: 0, maxPoints: ctx.itemPoints, details: { reason: "empty", chars } };
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
};
