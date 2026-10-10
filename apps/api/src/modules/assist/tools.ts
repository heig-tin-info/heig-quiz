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
 * - Every call is the MCP server's own (`runTool`, `injectedApi`), with the
 *   question's own token (`auth/tokens.ts`, `mintAssistToken`): the routes'
 *   access loaders, contracts and audit, unchanged; the teacher's own
 *   seats, never Super Powers (F-ADMIN-05). Only the wording of a failure
 *   differs: the model never reads a route's body.
 * - The client it is handed reads only: a write throws before any request,
 *   whatever a handler would try.
 * - A result is cut at about 8k tokens with a "narrow your request" marker.
 */
import { z } from "zod";

import { assistResults, capToolResult, type AssistResults, type AssistUiTurn, type ResultsSource } from "@quiz/domain";

import type { ReadOnlyTool } from "../llm/service.js";
import { inputJsonSchema, runTool, ToolRefusal, toolByName, type Api, type Tool, type ToolFailure } from "../mcp/service.js";

/**
 * The MCP read tools the assistant may call, each with the assistant's own
 * description. A tool that is not here is not reachable, whatever its name:
 * the model is handed this list and nothing else.
 */
export const MCP_READS = {
  list_courses:
    "The courses the user is on the staff of, with the user's role on each (`owner` or `assistant`).",
  get_course: "One course: its staff, its classrooms (with their ids) and the pools linked to it.",
  list_pools:
    "The user's pools (\"My pools\": own, shared with them, through a course, or public pools they subscribed to), with their question counts.",
  get_pool: "One pool: its detail, the user's role in it, and its category tree with counts.",
  get_pool_question_stats:
    "How students did on a pool's questions, aggregated (ADR-038): per question with at least ten counted exam " +
    "answers, `n` answers, `p` the mean share of the points (0 to 1, may be negative under negative marking), the " +
    "time spent, the discrimination `r`, and for mcq the share of each option. A question absent from `items` has " +
    "too few answers. Never a student, never an individual grade.",
  list_questions:
    "Searches a pool's questions by text, type, concept (what a question exercises) or category. `latestNumber` null: never published. " +
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

/** The final results of a classroom (ADR-080 P2, items 1–2), through the staff gradebook route. */
const resultsReader: Tool = {
  name: RESULTS_TOOL,
  title: "Get the final results of a classroom",
  description:
    "The FINAL results of one of the user's classrooms: its released evaluations and projects only, each " +
    "student by name with a Swiss grade per column (`absent`: a1.0; null: none) and the gradebook's mean. " +
    "Never a running or unreleased evaluation's scores: those are not final. Needs a staff seat on the course.",
  input: z.object({ classroomId: z.uuid() }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  run: async (api, args) =>
    assistResults((await api.get(`/classrooms/${(args as { classroomId: string }).classroomId}/gradebook`)) as ResultsSource),
};

/** Every data tool the assistant is handed, in a stable order (the prompt's cache). `read_guide` is the corpus's. */
export const ASSIST_DATA_TOOLS: readonly string[] = [...Object.keys(MCP_READS), RESULTS_TOOL];

/** The assistant's client of the API: the GETs of `api`, and a write refused before anything is sent. */
export function readOnly(api: Api): Api {
  const refuse = () => Promise.reject(new ToolRefusal("The help assistant reads only."));
  return { get: api.get, link: api.link, post: refuse, put: refuse, patch: refuse };
}

/**
 * What the model reads of a failure: never the route's body. A 404 is also
 * "not on your seats" (invariant 6) — the model says so and does not retry.
 */
export function failureText(failure: ToolFailure): string {
  switch (failure.kind) {
    case "invalid_arguments":
      return `Invalid arguments: ${failure.issues.map((i) => `${i.path || "input"}: ${i.message}`).join("; ")}`;
    case "refused":
      return failure.status === 404
        ? "Not found: the user holds no seat on the course this belongs to, or it does not exist. Tell the user; do not retry another way."
        : `Refused by the platform (HTTP ${failure.status}).`;
    case "tool_refusal":
      return failure.message;
    case "internal":
      return "The tool failed.";
  }
}

/** One call of a tool for the assistant: its value, or an `Error` that says why in the model's words. */
async function call(api: Api, tool: Tool, raw: unknown): Promise<unknown> {
  const outcome = await runTool(readOnly(api), tool, raw ?? {});
  if (!outcome.ok) throw new Error(failureText(outcome.error));
  return outcome.value;
}

/** A tool as the provider takes it: the input's JSON schema, a capped JSON result. */
function assistTool(tool: Tool, description: string, api: Api): ReadOnlyTool {
  const schema = inputJsonSchema(tool.input) as { properties?: Record<string, unknown>; required?: string[] };
  return {
    name: tool.name,
    description,
    inputSchema: { type: "object", properties: schema.properties ?? {}, required: schema.required ?? [], additionalProperties: false },
    run: async (raw) => capToolResult(JSON.stringify(await call(api, tool, raw))),
  };
}

/** The final results of a classroom, read by the results reader; an `Error` in the model's words when refused. */
export async function classroomResults(api: Api, classroomId: string): Promise<AssistResults> {
  return (await call(api, resultsReader, { classroomId })) as AssistResults;
}

/** The pools the user reaches, for the stub's "show me the pool …" (ADR-080 P2b). */
export async function userPools(api: Api): Promise<{ id: string; name: string }[]> {
  return (await call(api, toolByName.get("list_pools")!, {})) as { id: string; name: string }[];
}

/**
 * The two UI tools (ADR-080 P2b): the server runs NOTHING for them. Each
 * call is checked against the screen catalogue or the screen's effect-free
 * commands and recorded in `turn` (`AssistUiTurn` of `@quiz/domain`), whose
 * actions go back to the browser with the answer; the model reads a short
 * "done by the browser", or the refusal. Stable definitions: the catalogue
 * is in the cached system prompt, the commands in the screen part.
 */
export function assistUiTools(turn: AssistUiTurn): ReadOnlyTool[] {
  return [
    {
      name: "open_screen",
      description:
        "Opens one of the app's screens in the user's browser, after your answer: `screen` is a screen of the list " +
        "in the system prompt, `ids` its ids (from your tools), `params` its optional parameters. At most one per answer.",
      inputSchema: {
        type: "object",
        properties: {
          screen: { type: "string", description: "A screen of the list, such as pool or classroom." },
          ids: { type: "object", description: "The screen's ids, such as { \"id\": \"<pool id>\" }.", additionalProperties: { type: "string" } },
          params: {
            type: "object",
            description: "Optional: the screen's parameters, such as { \"q\": \"#printf\" } or { \"tab\": \"roster\" }.",
            additionalProperties: { type: "string" },
          },
        },
        required: ["screen"],
        additionalProperties: false,
      },
      run: (input) => turn.open(input),
    },
    {
      name: "run_screen_command",
      description:
        "Runs one of the commands the current screen lists (they open, show or select; none changes anything), in " +
        "the user's browser after your answer. `id` is the command's id.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "A command id the current screen lists." } },
        required: ["id"],
        additionalProperties: false,
      },
      run: (input) => turn.run(input),
    },
  ];
}

/** The assistant's data tools over `api`, which carries the question's token; reads only. */
export function assistDataTools(api: Api): ReadOnlyTool[] {
  const reads = Object.entries(MCP_READS).map(([name, description]) => assistTool(toolByName.get(name)!, description, api));
  return [...reads, assistTool(resultsReader, resultsReader.description, api)];
}
