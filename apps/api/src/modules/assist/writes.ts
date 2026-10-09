/**
 * The teacher assistant's P3 tools (ADR-080, P3 amendment): what it may
 * PROPOSE. None of them writes anything.
 *
 * - The write tools (decision 4): a closed list of the MCP catalogue's
 *   writes, reused for their schemas, handed to the model under the
 *   assistant's own descriptions. A call is checked — its arguments parsed by
 *   the tool's own schema, `create_question` forced to a draft, the questions
 *   of a template published, every entity read back AS THE TEACHER (a 404
 *   is a refusal) — then FROZEN as a pending write (`./pending.ts`) and shown
 *   as a card the server renders from those arguments, never from the
 *   model's prose. It runs only on the teacher's Confirm (`confirmWrite`).
 * - `propose_question_edit` (decisions 1, 2, 6): in the question editor, a
 *   rewrite of the open draft's texts, checked by `proposeQuestionEdit` of
 *   `@quiz/domain` and against the type's schema, returned as an action the
 *   teacher applies in the browser.
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { AssistTextSpec } from "@quiz/core/server";
import type { AssistWriteFailure, CategoryNode } from "@quiz/contracts";
import {
  ASSIST_MAX_WRITES,
  ASSIST_WRITE_TOOLS,
  assistTextFields,
  cardExcerpt,
  DEFAULT_ASSIST_TEXT,
  proposeQuestionEdit,
  type AssistDraftTexts,
  type AssistUiTurn,
  type AssistWriteLine,
  type AssistWriteTool,
} from "@quiz/domain";
import { questionType } from "@quiz/registry/server";

import type { ReadOnlyTool } from "../llm/service.js";
import { checkConfig, inputJsonSchema, runTool, toolByName, type Api, type Tool } from "../mcp/service.js";
import { PendingWrites, type PendingWrite } from "./pending.js";
import { failureText } from "./tools.js";

/** The assistant's description of each write: it prepares, the teacher confirms. */
const WRITE_DESCRIPTIONS: Record<AssistWriteTool, string> = {
  create_question:
    "PREPARES a new question as a DRAFT in a pool, for the user to confirm; it is never published (the user publishes " +
    "it in its editor). Call find_similar_questions first in this answer, and describe_question_types for its type, " +
    "and follow the schema exactly.",
  create_category: "PREPARES a category (a folder) in a pool, optionally under a parent category, for the user to confirm.",
  create_template:
    "PREPARES an evaluation template (a reusable exam or exercise) of a course, for the user to confirm; with no " +
    "questions, or with PUBLISHED questions of pools linked to the course only.",
  add_questions_to_template:
    "PREPARES the addition of PUBLISHED questions to a template, for the user to confirm; each from a pool linked to " +
    "the template's course.",
  link_pool_to_course:
    "PREPARES the link of a pool to a course, for the user to confirm: the course's evaluations may then use its " +
    "questions, and the course's WHOLE staff becomes contributor of the pool. Needs the course's owner role.",
};

/**
 * One write the assistant may prepare: the card it shows, read AS THE
 * TEACHER from the frozen arguments (anything it cannot read is a refusal,
 * and nothing is prepared), and the app's path of what it made or changed
 * once confirmed (decision 7: the card's link), from its arguments and the
 * tool's result.
 */
interface WriteSpec {
  card(api: Api, args: Record<string, any>): Promise<AssistWriteLine[]>;
  path(args: Record<string, any>, value: any): string;
}

/** One line of a card. */
const line = (field: AssistWriteLine["field"], ...values: string[]): AssistWriteLine => ({ field, values });

/** The category tree of a pool, flat. */
function flatten(nodes: readonly CategoryNode[]): CategoryNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

/** A pool as its detail route reads it: its name and its category tree. */
type PoolRead = { pool: { name: string }; categories: CategoryNode[] };

/** A category's name in a pool's tree, or a refusal the model reads. */
function categoryName(categories: readonly { id: string; name: string }[], id: string): string {
  const found = categories.find((c) => c.id === id);
  if (!found) throw new Error(`No category ${id} in this pool: use an id get_pool returned.`);
  return found.name;
}

/** The names of questions that may go into a template: published ones only (decision 9). */
async function publishedNames(api: Api, ids: readonly string[]): Promise<string[]> {
  const names: string[] = [];
  for (const id of ids) {
    const q = (await api.get(`/questions/${id}`)) as { meta: { internalName: string }; latestPublished: unknown };
    if (q.latestPublished === null) {
      throw new Error(
        `The question ${q.meta.internalName} is a draft, never published: only published questions go into a template. ` +
          "Tell the user to publish it in its editor, then to ask again. Prepare nothing for it.",
      );
    }
    names.push(q.meta.internalName);
  }
  return names;
}

/** The writes of decision 4, each its card and its result's path. */
const WRITES: Record<AssistWriteTool, WriteSpec> = {
  create_question: {
    async card(api, a) {
      const issues = checkConfig(a.type, a.config, { explanation: a.explanation, variables: a.variables });
      if (issues) {
        throw new Error(
          `The config does not satisfy the type's schema; nothing was prepared: ${issues.map((i) => `${i.path || "config"}: ${i.message}`).join("; ")}`,
        );
      }
      const pool = (await api.get(`/pools/${a.poolId}`)) as PoolRead;
      // The statement as the type declares it (`assistText`): its field labelled so.
      const statement = assistTextFields(a.config, assistTextOf(a.type)).find((f) => f.label === "statement")?.text ?? "";
      return [
        line("pool", pool.pool.name),
        ...(a.categoryId ? [line("category", categoryName(flatten(pool.categories), a.categoryId))] : []),
        line("type", a.type),
        line("name", a.internalName),
        ...(statement ? [line("statement", cardExcerpt(statement))] : []),
      ];
    },
    path: (_a, value) => `/questions/${value.questionId}`,
  },
  create_category: {
    async card(api, a) {
      const pool = (await api.get(`/pools/${a.poolId}`)) as PoolRead;
      return [
        line("pool", pool.pool.name),
        ...(a.parentId ? [line("parent", categoryName(flatten(pool.categories), a.parentId))] : []),
        line("name", a.name),
      ];
    },
    path: (a) => `/pools/${a.poolId}/categories`,
  },
  create_template: {
    async card(api, a) {
      const course = (await api.get(`/courses/${a.courseId}`)) as { course: { name: string } };
      const questions = await publishedNames(api, a.questionIds);
      return [
        line("course", course.course.name),
        line("title", a.title),
        line("mode", a.mode),
        ...(questions.length > 0 ? [line("questions", ...questions)] : []),
      ];
    },
    path: (_a, value) => `/templates/${value.template.id}`,
  },
  add_questions_to_template: {
    async card(api, a) {
      const template = (await api.get(`/templates/${a.templateId}`)) as { template: { title: string } };
      return [line("template", template.template.title), line("questions", ...(await publishedNames(api, a.questionIds)))];
    },
    path: (a) => `/templates/${a.templateId}`,
  },
  link_pool_to_course: {
    async card(api, a) {
      const course = (await api.get(`/courses/${a.courseId}`)) as {
        course: { name: string };
        staff: { givenName: string; familyName: string }[];
      };
      const pool = (await api.get(`/pools/${a.poolId}`)) as PoolRead;
      return [
        line("course", course.course.name),
        line("pool", pool.pool.name),
        // Decision 4: the card names who gains access — the course's whole staff.
        line("access", ...course.staff.map((s) => `${s.givenName} ${s.familyName}`.trim())),
      ];
    },
    path: (a) => `/courses/${a.courseId}/pools`,
  },
};

/** The MCP tool behind a write, reached by the closed list only. */
const writeTool = (name: AssistWriteTool): Tool => toolByName.get(name)!;

/** A write's arguments as its schema parses them; `create_question` always a draft (decision 4). */
function frozenArgs(name: AssistWriteTool, raw: unknown): Record<string, unknown> {
  const input = { ...((typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>) };
  if (name === "create_question") delete input.publish;
  const parsed = writeTool(name).input.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
  }
  const args = parsed.data as Record<string, unknown>;
  return name === "create_question" ? { ...args, publish: false } : args;
}

/** A write's input schema as the model is handed it: `create_question` has no `publish`. */
function writeSchema(name: AssistWriteTool): ReadOnlyTool["inputSchema"] {
  const schema = inputJsonSchema(writeTool(name).input) as { properties?: Record<string, unknown>; required?: string[] };
  const { publish: _publish, ...properties } = schema.properties ?? {};
  const required = (schema.required ?? []).filter((r) => r !== "publish");
  return { type: "object", properties, required, additionalProperties: false };
}

/** What one answer's write tools share: the turn, and the writes prepared in it, stored once the answer is. */
export interface WriteTurn {
  turn: AssistUiTurn;
  /** Set when `find_similar_questions` ran in this answer: `create_question` requires it (decision 4). */
  searched: { done: boolean };
  prepared: { id: string; write: Omit<PendingWrite, "userId" | "conversationId"> }[];
  now: Date;
}

/** The write tools of decision 4, each preparing a pending write; reads AS THE TEACHER through `api`. */
export function assistWriteTools(api: Api, ctx: WriteTurn): ReadOnlyTool[] {
  return ASSIST_WRITE_TOOLS.map((name) => ({
    name,
    description: WRITE_DESCRIPTIONS[name],
    inputSchema: writeSchema(name),
    async run(raw) {
      if (!ctx.turn.mayPrepare) throw new Error(`At most ${ASSIST_MAX_WRITES} writes per answer: prepare the others in a later answer.`);
      if (name === "create_question" && !ctx.searched.done) {
        throw new Error("Call find_similar_questions with this statement first, and reuse a close question rather than duplicate it.");
      }
      const args = frozenArgs(name, raw);
      let lines: AssistWriteLine[];
      try {
        lines = await WRITES[name].card(api, args);
      } catch (error) {
        throw error instanceof Error && !("status" in error) ? error : new Error(readFailure(error));
      }
      const id = randomUUID();
      const expiresAt = PendingWrites.expiry(ctx.now);
      ctx.prepared.push({ id, write: { tool: name, args, expiresAt } });
      return ctx.turn.prepare({ kind: "pending_write", id, tool: name, lines, expiresAt: expiresAt.toISOString() });
    },
  }));
}

/** A read that failed while a card was built, in the model's words. */
function readFailure(error: unknown): string {
  const status = (error as { status?: number }).status ?? 500;
  return failureText({ kind: "refused", status, body: null });
}

/**
 * Runs a confirmed write: EXACTLY its frozen arguments, once, through the
 * MCP tool's own handler over `api` (the teacher's assist token: the routes'
 * access loaders, contracts and audit). Its path, or why it was refused, as a code.
 */
export async function confirmWrite(api: Api, write: PendingWrite): Promise<{ ok: true; path: string } | { ok: false; reason: AssistWriteFailure }> {
  const outcome = await runTool(api, writeTool(write.tool), write.args);
  if (!outcome.ok) {
    const e = outcome.error;
    const reason = e.kind === "refused" ? (e.status === 404 ? "not_found" : "refused") : e.kind === "invalid_arguments" ? "invalid" : "failed";
    return { ok: false, reason };
  }
  return { ok: true, path: WRITES[write.tool].path(write.args, outcome.value) };
}

const EditInput = z.object({
  edits: z.array(z.object({ path: z.string().max(200), text: z.string() })).max(40).optional(),
  add: z.array(z.string()).max(12).optional(),
  explanation: z.string().optional(),
});

/** The free-text fields a question type lends the assistant (ADR-080 P3, decision 1). */
export const assistTextOf = (type: string): AssistTextSpec => questionType(type).assistText ?? DEFAULT_ASSIST_TEXT;

/**
 * Whether a proposed config keeps the type's schema on the fields it
 * changed: an issue on another path is the draft's own (D16), not the
 * proposal's.
 */
function schemaIssues(type: string, config: unknown, changed: readonly string[]): string[] {
  const parsed = questionType(type).configSchema.safeParse(config);
  if (parsed.success) return [];
  return parsed.error.issues
    .map((i) => ({ path: i.path.join("."), message: i.message }))
    .filter((i) => changed.some((c) => i.path === c || i.path.startsWith(`${c}.`)))
    .map((i) => `${i.path}: ${i.message}`);
}

/**
 * `propose_question_edit` (decisions 1, 2 and 6), offered in the question
 * editor only: a rewrite of the open draft's texts, checked, returned as an
 * action; nothing written on the server.
 */
export function proposeEditTool(turn: AssistUiTurn, editor: { questionId: string; type: string; base: AssistDraftTexts }): ReadOnlyTool {
  return {
    name: "propose_question_edit",
    description:
      "In the question editor only: PROPOSES a rewrite of the open draft's own texts — `edits`, each a text path the " +
      "current screen lists and its new text; `add`, new items' texts for a list the type allows (an mcq's choices, " +
      "added unticked); `explanation`. Keep every [[…]], {{…}} and asset: verbatim. Never ids, settings, the key or " +
      "scoring. The user sees a before/after diff and applies it; nothing is saved or published by you.",
    inputSchema: {
      type: "object",
      properties: {
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, text: { type: "string" } },
            required: ["path", "text"],
            additionalProperties: false,
          },
        },
        add: { type: "array", items: { type: "string" } },
        explanation: { type: "string" },
      },
      required: [],
      additionalProperties: false,
    },
    run(raw) {
      const input = EditInput.safeParse(raw ?? {});
      if (!input.success) throw new Error("Give `edits` ({ path, text }[]), `add` (string[]) or `explanation`.");
      const edit = proposeQuestionEdit(editor.questionId, editor.base, assistTextOf(editor.type), input.data);
      const issues = schemaIssues(
        editor.type,
        edit.config,
        edit.fields.map((f) => f.path),
      );
      if (issues.length > 0) throw new Error(`The proposal breaks the type's rules: ${issues.join("; ")}`);
      return turn.propose(edit);
    },
  };
}
