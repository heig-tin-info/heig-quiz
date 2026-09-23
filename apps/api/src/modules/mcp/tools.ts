/**
 * The MCP tool catalogue (ADR-022, F-LLM-06).
 *
 * A tool never touches the database. It calls the SAME `/app/api` routes the
 * web app calls, through an in-process `Api` that carries the caller's bearer
 * token — so the access loaders of invariant 6, the contract validation of
 * invariant 7, the audit entries (as `api_key`) and the SSE refresh hints are
 * the routes' own, unchanged. "Everything the UI does, the API does"
 * (docs/08 §8.1): the MCP server is one more client of that surface, not a
 * second implementation of it.
 *
 * Deliberately absent: every deletion, and every transition of a live
 * evaluation (start, pause, close, grading, release). A model may prepare
 * work; a teacher runs it.
 */
import { z } from "zod";

import {
  ClassroomCreate,
  CourseCreate,
  EvaluationCreate,
  EvaluationPatch,
  OAUTH_SCOPE,
  PoolCreate,
  PollQuestionType,
  QuestionCreate,
  QuestionPatch,
} from "@quiz/contracts";

import { checkConfig, describeQuestionType, questionTypeSummaries } from "./questionTypes.js";

/** A refusal of the route a tool forwarded to, with its status and body. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`HTTP ${status}: ${JSON.stringify(body)}`);
  }
}

/** A refusal the tool itself decided, before calling anything. */
export class ToolRefusal extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface Api {
  get(path: string, query?: Record<string, string | number | undefined>): Promise<any>;
  post(path: string, body?: unknown): Promise<any>;
  put(path: string, body: unknown): Promise<any>;
  patch(path: string, body: unknown): Promise<any>;
  /** The web app's URL of a screen, for the model to hand the teacher. */
  link(path: string): string;
}

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface Tool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  run(api: Api, args: z.output<S>): Promise<unknown>;
}

const tool = <S extends z.ZodObject>(t: Tool<S>): Tool => t as unknown as Tool;

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const Id = z.uuid();
const Difficulty = z.number().int().min(1).max(5);
const Tags = z.array(z.string().trim().min(1).max(64)).max(32);

/** The `QuestionPatch` fields present in a tool's arguments, for `PATCH /questions/:id`. */
const metaOf = (args: Record<string, unknown>) =>
  Object.fromEntries(
    Object.keys(QuestionPatch.shape)
      .filter((key) => args[key] !== undefined)
      .map((key) => [key, args[key]]),
  );

/** Saves the draft, then publishes it unless asked not to; the shared tail of both question writers. */
async function saveAndPublish(
  api: Api,
  questionId: string,
  draft: { config: unknown; explanation?: string | undefined },
  publish: boolean,
) {
  const saved = await api.put(`/questions/${questionId}/draft`, {
    config: draft.config,
    ...(draft.explanation === undefined ? {} : { explanation: draft.explanation }),
  });
  let version: number | null = null;
  if (publish && saved.valid) {
    const published = await api.post(`/questions/${questionId}/publish`, {});
    version = published.number;
  }
  return {
    questionId,
    valid: saved.valid as boolean,
    issues: saved.issues,
    publishedVersion: version,
    url: api.link(`/questions/${questionId}`),
  };
}

export const TOOLS: Tool[] = [
  // --- Reading -------------------------------------------------------------

  tool({
    name: "list_courses",
    title: "List courses",
    description:
      "The courses the teacher is on the staff of. A course holds classrooms (a class of students for a " +
      "period) and draws its questions from the pools linked to it.",
    input: z.object({}),
    annotations: READ,
    run: (api) => api.get("/courses"),
  }),

  tool({
    name: "get_course",
    title: "Get a course",
    description: "One course with its staff, its classrooms (ids needed to create an evaluation) and its linked pools.",
    input: z.object({ courseId: Id }),
    annotations: READ,
    run: (api, a) => api.get(`/courses/${a.courseId}`),
  }),

  tool({
    name: "list_pools",
    title: "List question pools",
    description: "The question pools the teacher can reach (own, shared with them, or through a course), with their question counts.",
    input: z.object({}),
    annotations: READ,
    run: (api) => api.get("/pools"),
  }),

  tool({
    name: "get_pool",
    title: "Get a pool",
    description: "One pool: its detail, the caller's role in it, and its category tree with counts.",
    input: z.object({ poolId: Id }),
    annotations: READ,
    run: async (api, a) => ({
      pool: await api.get(`/pools/${a.poolId}`),
      categories: await api.get(`/pools/${a.poolId}/categories`),
    }),
  }),

  tool({
    name: "list_questions",
    title: "List the questions of a pool",
    description:
      "Search a pool's questions. `latestNumber` is null for a question never published — only published " +
      "questions can go into an evaluation. Pass `cursor` from the previous page to continue.",
    input: z.object({
      poolId: Id,
      q: z.string().trim().max(200).optional().describe("Full-text search in names and statements"),
      type: z.array(z.string()).optional(),
      tag: z.array(z.string()).optional(),
      categoryId: Id.optional(),
      limit: z.number().int().min(1).max(200).default(50),
      cursor: z.string().max(200).optional(),
    }),
    annotations: READ,
    run: (api, a) =>
      api.get(`/pools/${a.poolId}/questions`, {
        q: a.q,
        type: a.type?.join(","),
        tag: a.tag?.join(","),
        categoryId: a.categoryId,
        limit: a.limit,
        cursor: a.cursor,
      }),
  }),

  tool({
    name: "get_question",
    title: "Get a question",
    description: "One question: its metadata, its current draft (config and explanation) and its published versions.",
    input: z.object({ questionId: Id }),
    annotations: READ,
    run: (api, a) => api.get(`/questions/${a.questionId}`),
  }),

  tool({
    name: "describe_question_types",
    title: "Describe question types",
    description:
      "How to write the `config` of a question type: its JSON Schema, the authoring rules and an example. " +
      "Call it with a `type` BEFORE creating a question of that type. Without `type`, lists the types.",
    input: z.object({ type: QuestionCreate.shape.type.optional() }),
    annotations: READ,
    run: async (_api, a) => (a.type ? describeQuestionType(a.type) : questionTypeSummaries()),
  }),

  tool({
    name: "list_evaluations",
    title: "List the evaluations of a classroom",
    description: "The evaluations (exams, exercises, polls) of one classroom, with their state.",
    input: z.object({ classroomId: Id }),
    annotations: READ,
    run: (api, a) => api.get(`/classrooms/${a.classroomId}/evaluations`),
  }),

  tool({
    name: "get_evaluation",
    title: "Get an evaluation",
    description: "One evaluation: settings, schedule and its items (the questions it plays, with their points).",
    input: z.object({ evaluationId: Id }),
    annotations: READ,
    run: (api, a) => api.get(`/evaluations/${a.evaluationId}`),
  }),

  // --- Writing -------------------------------------------------------------

  tool({
    name: "create_course",
    title: "Create a course",
    description:
      "Creates a course with the teacher as its only staff member. `code` is the short school code " +
      "(`FRA1`), unique on the platform. Check `list_courses` first: do not create a duplicate.",
    input: CourseCreate,
    annotations: WRITE,
    run: (api, a) => api.post("/courses", a),
  }),

  tool({
    name: "create_classroom",
    title: "Create a classroom",
    description:
      "Creates a classroom (one class of students for one period, e.g. `Français 2026`) in a course. " +
      "Evaluations live in a classroom.",
    input: z.object({ courseId: Id, ...ClassroomCreate.shape }),
    annotations: WRITE,
    run: async (api, { courseId, ...body }) => {
      const room = await api.post(`/courses/${courseId}/classrooms`, body);
      return { ...room, url: api.link(`/classrooms/${room.id}`) };
    },
  }),

  tool({
    name: "create_pool",
    title: "Create a question pool",
    description:
      "Creates a pool owned by the teacher. `private` by default. Link it to a course with " +
      "`link_pool_to_course` before using its questions in that course's evaluations.",
    input: PoolCreate,
    annotations: WRITE,
    run: async (api, a) => {
      const pool = await api.post("/pools", a);
      return { ...pool, url: api.link(`/pools/${pool.id}`) };
    },
  }),

  tool({
    name: "link_pool_to_course",
    title: "Link a pool to a course",
    description:
      "Makes a pool's questions available to a course's evaluations. Keeps the pools already linked. Idempotent.",
    input: z.object({ courseId: Id, poolId: Id }),
    annotations: { ...WRITE, idempotentHint: true },
    run: async (api, a) => {
      const course = await api.get(`/courses/${a.courseId}`);
      const ids = new Set<string>(course.pools.map((p: { id: string }) => p.id));
      ids.add(a.poolId);
      return api.put(`/courses/${a.courseId}/pools`, { poolIds: [...ids] });
    },
  }),

  tool({
    name: "create_category",
    title: "Create a category",
    description: "Creates a category (a folder) in a pool, optionally under a parent category.",
    input: z.object({ poolId: Id, name: z.string().trim().min(1).max(200), parentId: Id.nullable().optional() }),
    annotations: WRITE,
    run: (api, { poolId, ...body }) => api.post(`/pools/${poolId}/categories`, body),
  }),

  tool({
    name: "create_question",
    title: "Create a question",
    description:
      "Creates a question in a pool, saves its config and explanation, and publishes it (unless " +
      "`publish` is false). Call `describe_question_types` for the type first. An invalid config is " +
      "refused with the list of issues and nothing is created. `internalName` is a unique slug inside " +
      "the pool, never shown to students (e.g. `fr-vocab-prolixe`). `explanation` is Markdown shown " +
      "after grading when the evaluation allows it.",
    input: z.object({
      poolId: Id,
      type: QuestionCreate.shape.type,
      internalName: QuestionCreate.shape.internalName,
      config: z.record(z.string(), z.unknown()),
      explanation: z.string().max(20_000).optional(),
      categoryId: Id.nullable().optional(),
      difficulty: Difficulty.optional().describe("1 (easy) to 5 (hard); 3 by default"),
      tags: Tags.optional(),
      publish: z.boolean().default(true),
    }),
    annotations: WRITE,
    run: async (api, a) => {
      if (a.publish) {
        const issues = checkConfig(a.type, a.config);
        if (issues) throw new ToolRefusal("The config does not satisfy the type's schema; nothing was created.", issues);
      }
      const created = await api.post(`/pools/${a.poolId}/questions`, {
        type: a.type,
        internalName: a.internalName,
        categoryId: a.categoryId ?? null,
      });
      const id: string = created.meta.id;
      const meta = metaOf({ difficulty: a.difficulty, tags: a.tags });
      if (Object.keys(meta).length > 0) await api.patch(`/questions/${id}`, meta);
      return saveAndPublish(api, id, { config: a.config, explanation: a.explanation }, a.publish);
    },
  }),

  tool({
    name: "update_question",
    title: "Update a question",
    description:
      "Changes a question: its metadata, and/or its draft (config, explanation), then publishes a new " +
      "version (unless `publish` is false). Evaluations keep the version they were built with.",
    input: z.object({
      questionId: Id,
      config: z.record(z.string(), z.unknown()).optional(),
      explanation: z.string().max(20_000).optional(),
      ...QuestionPatch.shape,
      publish: z.boolean().default(true),
    }),
    annotations: WRITE,
    run: async (api, a) => {
      const current = await api.get(`/questions/${a.questionId}`);
      const meta = metaOf(a);
      if (Object.keys(meta).length > 0) await api.patch(`/questions/${a.questionId}`, meta);
      if (a.config === undefined && a.explanation === undefined && !a.publish) {
        return { questionId: a.questionId, url: api.link(`/questions/${a.questionId}`) };
      }
      const config = a.config ?? current.draft?.config;
      if (a.publish) {
        const issues = checkConfig(current.meta.type, config);
        if (issues) throw new ToolRefusal("The config does not satisfy the type's schema; nothing was published.", issues);
      }
      return saveAndPublish(api, a.questionId, { config, explanation: a.explanation }, a.publish);
    },
  }),

  tool({
    name: "create_evaluation",
    title: "Create an evaluation",
    description:
      "Creates an evaluation in DRAFT in a classroom — `exercise` (practice, feedback allowed) or `exam` — " +
      "and adds the given questions. Every question must be PUBLISHED and come from a pool linked to the " +
      "classroom's course (`link_pool_to_course`). Nothing is opened to students: the teacher schedules or " +
      "starts it from the web app.",
    input: z.object({
      classroomId: Id,
      title: EvaluationCreate.shape.title,
      mode: z.enum(["exam", "exercise"]).default("exercise"),
      questionIds: z.array(Id).max(200).default([]),
    }),
    annotations: WRITE,
    run: async (api, a) => {
      const created = await api.post(`/classrooms/${a.classroomId}/evaluations`, {
        title: a.title,
        mode: a.mode,
        preset: a.mode,
      });
      if (a.questionIds.length > 0) {
        await api.post(`/evaluations/${created.id}/items`, { questionIds: a.questionIds });
      }
      return { ...(await api.get(`/evaluations/${created.id}`)), url: api.link(`/evaluations/${created.id}`) };
    },
  }),

  tool({
    name: "add_questions_to_evaluation",
    title: "Add questions to an evaluation",
    description:
      "Appends published questions to an evaluation that nobody has started yet. Each question must come " +
      "from a pool linked to the evaluation's course.",
    input: z.object({ evaluationId: Id, questionIds: z.array(Id).min(1).max(200) }),
    annotations: WRITE,
    run: (api, a) => api.post(`/evaluations/${a.evaluationId}/items`, { questionIds: a.questionIds }),
  }),

  tool({
    name: "update_evaluation",
    title: "Update an evaluation",
    description:
      "Changes an evaluation's title, settings, feedback policy, grading scale or schedule (`opensAt`, " +
      "`closesAt` as ISO date-times, `durationS` in seconds). Does not start it.",
    input: z.object({ evaluationId: Id, ...EvaluationPatch.shape }),
    annotations: { ...WRITE, idempotentHint: true },
    run: (api, { evaluationId, ...body }) => api.patch(`/evaluations/${evaluationId}`, body),
  }),

  tool({
    name: "create_poll",
    title: "Launch a live poll",
    description:
      "Creates AND STARTS a one-question live poll in a classroom: students join with the returned code " +
      "or `joinUrl`. Either pass `questionId` (a published `mcq` or `short` question) or write one inline " +
      "with `type` + `config` (not saved in any pool; an opinion poll may have no correct answer). Only " +
      "call it when the teacher wants to poll NOW.",
    input: z.object({
      classroomId: Id,
      anonymous: z.boolean().default(false).describe("Let participants answer without signing in"),
      questionId: Id.optional(),
      type: PollQuestionType.optional(),
      config: z.record(z.string(), z.unknown()).optional(),
    }),
    annotations: { ...WRITE, openWorldHint: true },
    run: async (api, a) => {
      let view;
      if (a.questionId) {
        view = await api.post("/polls", { classroomId: a.classroomId, questionId: a.questionId, anonymous: a.anonymous });
      } else if (a.type && a.config) {
        view = await api.post("/polls/inline", {
          classroomId: a.classroomId,
          anonymous: a.anonymous,
          type: a.type,
          config: a.config,
        });
      } else {
        throw new ToolRefusal("Pass either `questionId`, or both `type` and `config`.");
      }
      // The teacher projects the wall; the participants open `joinUrl`.
      return {
        evaluationId: view.evaluation.id,
        code: view.evaluation.code,
        joinUrl: view.joinUrl,
        projectionUrl: api.link(`/evaluations/${view.evaluation.id}/poll`),
      };
    },
  }),
];

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * `tools/list`: the catalogue with each input as JSON Schema. Every tool
 * declares the OAuth scheme it needs: ChatGPT reads `securitySchemes` per
 * tool to decide when to run its sign-in (ADR-023); other hosts ignore it.
 */
export function toolDescriptors() {
  return TOOLS.map((t) => {
    const inputSchema = z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete inputSchema.$schema;
    return {
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema,
      annotations: t.annotations,
      securitySchemes: [{ type: "oauth2", scopes: [OAUTH_SCOPE] }],
    };
  });
}
