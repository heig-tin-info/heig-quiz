/**
 * The help assistant's data tools (ADR-080 §8 and its P2 amendment): what
 * the model may read of the platform, AS THE ASKING TEACHER, while it
 * answers one question.
 *
 * - A CLOSED allowlist (`ASSIST_DATA_TOOLS`): the MCP catalogue's read tools
 *   that carry no student data, reused for their schemas and handlers but
 *   with the assistant's own descriptions (no authoring nudges), and the
 *   results reader, which is the assistant's alone: it is NOT in the MCP
 *   catalogue (ADR-022's promise to the existing OAuth grants).
 * - Every call goes through `injectedApi`, the MCP tools' in-process chain,
 *   with the question's own token (`auth/tokens.ts`, `mintAssistToken`): the
 *   routes' access loaders, contracts and audit, unchanged; the teacher's
 *   own seats, never Super Powers (F-ADMIN-05).
 * - The client it is handed reads only: a write throws before any request,
 *   whatever a handler would try.
 * - A result is cut at about 8k tokens with a "narrow your request" marker.
 */
import { z } from "zod";

import { assistResults, capToolResult, type AssistResults, type ResultsSource } from "@quiz/domain";

import type { ReadOnlyTool } from "../llm/service.js";
import { ApiError, ToolRefusal, toolByName, type Api, type Tool } from "../mcp/service.js";

/**
 * The MCP read tools the assistant may call, each with the assistant's own
 * description. A tool that is not here is not reachable, whatever its name:
 * the model is handed this list and nothing else.
 */
const MCP_READS = {
  list_courses:
    "The courses the user is on the staff of, with the user's role on each (`owner` or `assistant`).",
  get_course: "One course: its staff, its classrooms (with their ids) and the pools linked to it.",
  list_pools: "The question pools the user reaches (own, shared with them, or through a course), with their question counts.",
  get_pool: "One pool: its detail, the user's role in it, and its category tree with counts.",
  get_pool_question_stats:
    "How students did on a pool's questions, aggregated (ADR-038): per question with at least ten counted exam " +
    "answers, `n` answers, `p` the mean share of the points (0 to 1, may be negative under negative marking), the " +
    "time spent, the discrimination `r`, and for mcq the share of each option. A question absent from `items` has " +
    "too few answers. Never a student, never an individual grade.",
  list_questions:
    "Searches a pool's questions by text, type, tag or category. `latestNumber` null: never published. " +
    "Pass `cursor` from the previous page to continue.",
  find_similar_questions:
    "Questions close to a given statement, from the course's pools first, then from every pool the user reaches. " +
    "Ranked by shared words, with no threshold: judge each `excerpt`.",
  get_question: "One question: its metadata, its current draft (config and explanation) and its published versions.",
  describe_question_types:
    "What a question type is and how its configuration is written. Without `type`, lists the types.",
  list_evaluations: "The evaluations (exams, exercises, polls) of one classroom, with their state.",
  get_evaluation:
    "One evaluation: its settings, schedule and items (the questions it plays, with their points). Its structure " +
    "only, never a student's answer or score, even while it runs.",
  list_templates: "The evaluation templates of a course: the reusable exams and exercises kept in the course.",
} as const;

/** The results reader: the assistant's alone, never in the MCP catalogue (ADR-080 P2, item 1). */
export const RESULTS_TOOL = "get_classroom_results";

/** Every data tool the assistant is handed, in a stable order (the prompt's cache). `read_guide` is the corpus's. */
export const ASSIST_DATA_TOOLS: readonly string[] = [...Object.keys(MCP_READS), RESULTS_TOOL];

/** The assistant's client of the API: the GETs of `api`, and a write refused before anything is sent. */
export function readOnly(api: Api): Api {
  const refuse = () => Promise.reject(new ToolRefusal("The help assistant reads only."));
  return { get: api.get, link: api.link, post: refuse, put: refuse, patch: refuse };
}

/** The input JSON schema of a tool, as the provider takes it. */
function jsonSchema(input: z.ZodObject): ReadOnlyTool["inputSchema"] {
  const schema = z.toJSONSchema(input, { io: "input", unrepresentable: "any" }) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return { type: "object", properties: schema.properties ?? {}, required: schema.required ?? [], additionalProperties: false };
}

/**
 * What the model reads of a refusal: never the route's body. A 404 is also
 * "not on your seats" (invariant 6) — the model says so and does not retry.
 */
export function refusal(error: unknown): Error {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return new Error(
        "Not found: the user holds no seat on the course this belongs to, or it does not exist. Tell the user; do not retry another way.",
      );
    }
    return new Error(`Refused by the platform (HTTP ${error.status}).`);
  }
  if (error instanceof ToolRefusal) return new Error(error.message);
  return new Error("The tool failed.");
}

/** A tool of the assistant: input validated by `input`, result as capped JSON, a refusal as a thrown error. */
function assistTool<S extends z.ZodObject>(
  name: string,
  description: string,
  input: S,
  run: (args: z.output<S>) => Promise<unknown>,
): ReadOnlyTool {
  return {
    name,
    description,
    inputSchema: jsonSchema(input),
    async run(raw) {
      const args = input.safeParse(raw ?? {});
      if (!args.success) {
        throw new Error(`Invalid arguments: ${args.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
      }
      let value: unknown;
      try {
        value = await run(args.data);
      } catch (error) {
        throw refusal(error);
      }
      return capToolResult(JSON.stringify(value));
    },
  };
}

/** The final results of a classroom (ADR-080 P2, items 1–2), through the staff gradebook route. */
export async function classroomResults(api: Api, classroomId: string): Promise<AssistResults> {
  return assistResults((await api.get(`/classrooms/${classroomId}/gradebook`)) as ResultsSource);
}

/** The assistant's data tools over `api`, which carries the question's token; reads only. */
export function assistDataTools(api: Api): ReadOnlyTool[] {
  const reader = readOnly(api);
  const reads = Object.entries(MCP_READS).map(([name, description]) => {
    const tool: Tool = toolByName.get(name)!;
    return assistTool(name, description, tool.input, (args) => tool.run(reader, args));
  });
  const results = assistTool(
    RESULTS_TOOL,
    "The FINAL results of one of the user's classrooms: its released evaluations and projects only, each " +
      "student by name with a Swiss grade per column (`absent`: a1.0; null: none) and the gradebook's mean. " +
      "Never a running or unreleased evaluation's scores: those are not final. Needs a staff seat on the course.",
    z.object({ classroomId: z.uuid() }),
    (args) => classroomResults(reader, args.classroomId),
  );
  return [...reads, results];
}
