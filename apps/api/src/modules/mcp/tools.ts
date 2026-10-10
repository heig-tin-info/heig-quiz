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
 * Statistics are read through the pool screen's own route: the threshold of
 * ADR-038 §4 is the route's, so a tool cannot see a smaller `n` than the
 * browser does.
 *
 * Deliberately absent: every deletion, and every transition of a live
 * evaluation (start, pause, close, grading, release). A model may prepare
 * work; a teacher runs it.
 */
import { z } from "zod";

import {
  checkPeriodMonths,
  ClassroomCreate,
  CourseCreate,
  EvaluationCreate,
  EvaluationPatch,
  EvaluationPreset,
  CoursePoolMode,
  OAUTH_SCOPE,
  ParametersDraft,
  PoolCreate,
  PollQuestionType,
  QuestionCreate,
  QuestionPatchFields,
  SimilarQuestionSearch,
  TemplateInstantiate,
  type ConceptResolution,
  type ConceptResolveResponse,
} from "@quiz/contracts";
import { filterIds, type LabelResolution } from "@quiz/domain";

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
/**
 * What a question exercises (ADR-081, third addendum §4, addendum §7): the
 * one wording every tool that names concepts shares, so that a client does
 * not recreate what the admin's sorting dropped.
 */
const CONCEPTS_MEANING =
  "Concepts are what the question exercises (`pointers`, `Ohm's law`): never an organisational label " +
  "(a week, an exam, a difficulty, `to-review`) nor a kind of task (code reading, code writing, " +
  "vocabulary, tracing, debugging). The vocabulary is shared by the whole instance, in French and English.";
const Concepts = QuestionPatchFields.shape.concepts.describe(
  `${CONCEPTS_MEANING} Replaces the question's concepts. Each entry is a concept id, a label in either ` +
  "language, or a label with its qualifier (`adresse (mémoire)`). All or nothing: an ambiguous label is " +
  "refused with 422 `concept_ambiguous` and its candidates, an unknown one with 422 `concept_unknown` and " +
  "the close candidates (pick one and retry with its id), a label the admin dropped with 422 `concept_dropped`, " +
  "a new label that another concept answers to as an alias with 409 `concept_exists` naming that concept (use its id).",
);
/** A question's internal name reads as a title in every teacher list, not as an identifier (#691). */
const INTERNAL_NAME_MEANING =
  "A short, meaningful title of at most 7 words, in the language of the conversation " +
  "(`L'île aux yeux bleus`, `Pointer arithmetic on an array`), not a slug nor a code. Unique in the " +
  "pool (case-insensitive), seen by teachers only, never by students.";
const CreateMissing = QuestionPatchFields.shape.createMissing.describe(
  "true creates a `proposed` concept for a label that matches none; false by default: prefer an existing " +
    "concept, and create one only for a real concept the vocabulary lacks. A dropped label is refused even so.",
);

/** The `QuestionPatchFields` present in a tool's arguments, for `PATCH /questions/:id`. */
const metaOf = (args: Record<string, unknown>) =>
  Object.fromEntries(
    Object.keys(QuestionPatchFields.shape)
      .filter((key) => args[key] !== undefined)
      .map((key) => [key, args[key]]),
  );

/**
 * The concept ids a filter names (ADR-081 third addendum §7, `filterIds`):
 * what each word designates — the concept it resolves to, or every homonym
 * — never a close-only candidate. A word that designates nothing is refused
 * with its close candidates, or its drop, rather than silently matching
 * nothing. A read (`GET /concepts/resolve`), so the assistant may filter too.
 */
async function conceptFilter(api: Api, labels: readonly string[] | undefined): Promise<string | undefined> {
  if (!labels?.length) return undefined;
  const params = new URLSearchParams(labels.map((input): [string, string] => ["input", input]));
  const { results } = (await api.get(`/concepts/resolve?${params}`)) as ConceptResolveResponse;
  const designated = results.map((r) => ({ r, ids: filterIds(labelResolution(r)) }));
  const nothing = designated.filter((d) => d.ids.length === 0).map((d) => d.r);
  if (nothing.length > 0) {
    throw new ToolRefusal(
      "A concept designates nothing in the vocabulary; nothing was searched.",
      nothing.map((r) =>
        r.kind === "dropped"
          ? { input: r.input, dropped: r.reason }
          : { input: r.input, didYouMean: r.kind === "unknown" ? r.candidates : [] },
      ),
    );
  }
  return [...new Set(designated.flatMap((d) => d.ids))].join(",");
}

/** A resolution of the route as the domain's rule reads it: ids only. */
function labelResolution(r: ConceptResolution): LabelResolution {
  if (r.kind === "resolved") return { kind: "resolved", id: r.concept.id };
  if (r.kind === "ambiguous") return { kind: "ambiguous", candidates: r.candidates.map((c) => c.id) };
  return { kind: "unknown", candidates: r.kind === "unknown" ? r.candidates.map((c) => c.id) : [] };
}

/**
 * The variables of a parameterized question (ADR-056), as a tool takes them:
 * the table's shape; its rules — names, formats, expressions — are the
 * domain's, which the pre-check (`checkConfig`) and the publication apply.
 */
const Variables = ParametersDraft.nullable()
  .optional()
  .describe(
    "mcq, short (number key) and cloze only: an ordered table of variables `{ rows: [{ name, expr, format }], " +
      "condition? }`, drawn per attempt; null makes the question static. See `describe_question_types`.",
  );

/** Saves the draft, then publishes it unless asked not to; the shared tail of both question writers. */
async function saveAndPublish(
  api: Api,
  questionId: string,
  draft: { config: unknown; explanation?: string | undefined; variables?: ParametersDraft | null | undefined },
  publish: boolean,
) {
  const saved = await api.put(`/questions/${questionId}/draft`, {
    config: draft.config,
    ...(draft.explanation === undefined ? {} : { explanation: draft.explanation }),
    ...(draft.variables === undefined ? {} : { variables: draft.variables }),
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

/** The arguments `create_evaluation` and `create_template` share: what the quiz is. */
const QuizFields = {
  title: EvaluationCreate.shape.title,
  mode: EvaluationPreset.default("exercise"),
  questionIds: z.array(Id).max(200).default([]),
};

/**
 * The shared body of both quiz writers: creates the evaluation or template
 * at `createPath` with the mode's preset, adds the questions through its own
 * item route, and answers its detail with the web app's link. `kind` is both
 * the API's and the web app's path segment.
 */
async function createQuiz(
  api: Api,
  createPath: string,
  kind: "evaluations" | "templates",
  a: z.infer<z.ZodObject<typeof QuizFields>>,
) {
  const created = await api.post(createPath, { title: a.title, mode: a.mode, preset: a.mode });
  if (a.questionIds.length > 0) {
    await api.post(`/${kind}/${created.id}/items`, { questionIds: a.questionIds });
  }
  return { ...(await api.get(`/${kind}/${created.id}`)), url: api.link(`/${kind}/${created.id}`) };
}

export const TOOLS: Tool[] = [
  // --- Reading -------------------------------------------------------------

  tool({
    name: "list_courses",
    title: "List courses",
    description:
      "The courses the teacher is on the staff of. A course holds classrooms (a class of students for a " +
      "period) and draws its questions from the pools linked to it. `myRole` is the teacher's role on " +
      "each: an `owner` runs the course (classrooms, linked pools, staff), an `assistant` does the rest.",
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
    description:
      "The teacher's pools (\"My pools\"): own, shared with them, reached through a course, or public pools they subscribed to, with their question counts. " +
      "A public pool they have none of those ties to is not listed, but get_pool, list_questions and find_similar_questions still read it.",
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
    name: "get_pool_question_stats",
    title: "Get the statistics of a pool's questions",
    description:
      "How students did on a pool's questions, to pick or fix one (ADR-038). One entry per question with " +
      "enough answers: a question absent from `items` has fewer than ten counted answers, and its figures " +
      "are withheld, not zero. `n` answers counted, every version pooled, over the exams " +
      "(never an exercise) of EVERY class that used the question (not only the teacher's own); `p` is the mean " +
      "share of the points earned, from 0 to 1, and may be NEGATIVE under negative marking; `since` is the " +
      "last reset (null: never). `time` is the time spent on the question in exams, in whole seconds " +
      "(median, P25, P75, mean, over `time.n` answers), or null below ten timed answers. `discrimination` is " +
      "the corrected point-biserial over exams (`r` from -1 to 1, weak below 0.2, good from 0.3, negative: the " +
      "stronger students do worse, check the key), with the exams and attempts behind it, or null when no exam " +
      "qualifies (ADR-042). `distractors`, on an " +
      "mcq question only, is the whole-percent share of students who picked each option (`correct` marks the " +
      "key) and of `none` (picked nothing), over `distractors.n` answers to the versions whose options are " +
      "the current ones; null below ten such answers (ADR-043). Aggregates only: " +
      "no student, no individual grade.",
    input: z.object({ poolId: Id }),
    annotations: READ,
    run: (api, a) => api.get(`/pools/${a.poolId}/question-stats`),
  }),

  tool({
    name: "list_questions",
    title: "List the questions of a pool",
    description:
      "Search a pool's questions. `latestNumber` is null for a question never published — only published " +
      "questions can go into an evaluation. Each question lists its `concepts`. Pass `cursor` from the " +
      "previous page to continue.",
    input: z.object({
      poolId: Id,
      q: z.string().trim().max(200).optional().describe("Full-text search in names and statements"),
      type: z.array(z.string()).optional(),
      concepts: z
        .array(z.string().trim().min(1).max(120))
        .max(32)
        .optional()
        .describe(
          "Only the questions that exercise one of these concepts: ids or labels in either language. A label " +
            "matches every concept it may designate; one that matches none is refused with close candidates.",
        ),
      categoryId: Id.optional(),
      limit: z.number().int().min(1).max(200).default(50),
      cursor: z.string().max(200).optional(),
    }),
    annotations: READ,
    run: async (api, a) =>
      api.get(`/pools/${a.poolId}/questions`, {
        q: a.q,
        type: a.type?.join(","),
        concept: await conceptFilter(api, a.concepts),
        categoryId: a.categoryId,
        limit: a.limit,
        cursor: a.cursor,
      }),
  }),

  tool({
    name: "find_similar_questions",
    title: "Find questions close to one about to be written",
    description:
      "Call it BEFORE create_question with the statement you are about to write, and reuse a close hit " +
      "rather than writing a near-duplicate: reuse makes its exam statistics grow, a copy starts with none. " +
      "Hits come from the course's pools first, then from every pool the teacher reaches (public pools " +
      "included, so other teachers' questions may appear), ranked by shared words with no threshold: judge " +
      "each `excerpt`. `linked`: usable as is in the course's evaluations. `canLink`: call " +
      "link_pool_to_course first (`mode: \"read\"` for a colleague's public pool, which keeps the course staff readers; " +
      "`mode: \"edit\"` makes them contributors of that whole pool). `stats` " +
      "`{ n, p, r }` reads as in get_pool_question_stats (`r`: discrimination); null below ten exam answers.",
    input: z.object({
      courseId: Id,
      text: SimilarQuestionSearch.shape.text.describe("The statement to compare, or its gist"),
      type: SimilarQuestionSearch.shape.type,
      limit: SimilarQuestionSearch.shape.limit,
    }),
    annotations: READ,
    run: (api, { courseId, ...query }) => api.get(`/courses/${courseId}/similar-questions`, query),
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
    description: "One evaluation: settings, schedule and its items (the questions it plays, with their points). " +
      "A `bonus` item's points are left out of the total: they can only lift a student (ADR-052).",
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
      "Evaluations live in a classroom. `period` is a free label; `periodStart` and `periodEnd` date " +
      "it by month (both or neither), which keeps it in the teacher's sidebar only while it runs. " +
      "HEIG-VD semesters: autumn N = `N-09` to `(N+1)-01`, spring N = `N-02` to `N-07`. " +
      "Only an owner of the course may create one (`myRole` of list_courses); an assistant is refused " +
      "with 403 `owner_required`.",
    input: z.object({
      courseId: Id,
      ...ClassroomCreate.shape,
      periodStart: ClassroomCreate.shape.periodStart.describe(
        "First month of the period, `YYYY-MM` (e.g. `2026-09`); with `periodEnd`, or neither. Omitted = undated.",
      ),
      periodEnd: ClassroomCreate.shape.periodEnd.describe(
        "Last month of the period, `YYYY-MM` (e.g. `2027-01`), not before `periodStart`.",
      ),
    }).superRefine(checkPeriodMonths),
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
      "Creates a pool owned by the teacher. Not published by default (`isPublic: false`); its visibility is then derived from who has access. Link it to a course with " +
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
      "Makes a pool's questions available to a course's evaluations. Keeps the pools already linked, each in its mode. Idempotent. " +
      "`mode: \"edit\"` (the default) makes the whole course staff contributors of the pool, so it needs the contributor " +
      "or owner role on it: otherwise 403 `pool_link_forbidden`. `mode: \"read\"` leaves the staff readers: use it for a " +
      "colleague's PUBLIC pool, which any course owner may link without subscribing (a pool that is not public is " +
      "refused with 409 `pool_not_public`). A link already there keeps its mode unless this call asks for a stronger one. " +
      "Only an owner of the course may link (`myRole` of list_courses); an assistant is refused with 403 `owner_required`.",
    input: z.object({ courseId: Id, poolId: Id, mode: CoursePoolMode.default("edit") }),
    annotations: { ...WRITE, idempotentHint: true },
    run: async (api, a) => {
      const course = await api.get(`/courses/${a.courseId}`);
      const links = new Map<string, string>(course.pools.map((p: { id: string; mode: string }) => [p.id, p.mode]));
      links.set(a.poolId, a.mode);
      return api.put(`/courses/${a.courseId}/pools`, {
        pools: [...links].map(([poolId, mode]) => ({ poolId, mode })),
      });
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
      "`publish` is false). Call `find_similar_questions` first and reuse a close hit rather than " +
      "writing a duplicate. Call `describe_question_types` for the type first. An invalid config is " +
      "refused with the list of issues and nothing is created. `explanation` is Markdown shown " +
      "after grading when the evaluation allows it.",
    input: z.object({
      poolId: Id,
      type: QuestionCreate.shape.type,
      internalName: QuestionCreate.shape.internalName.describe(INTERNAL_NAME_MEANING),
      config: z.record(z.string(), z.unknown()),
      explanation: z.string().max(20_000).optional(),
      variables: Variables,
      categoryId: Id.nullable().optional(),
      difficulty: Difficulty.optional().describe("1 (easy) to 5 (hard); 3 by default"),
      concepts: Concepts,
      createMissing: CreateMissing,
      publish: z.boolean().default(true),
    })
    // A client still holding the tool of before the cut-over (its `tags`) is refused, not ignored.
    .strict(),
    annotations: WRITE,
    run: async (api, a) => {
      if (a.publish) {
        const issues = checkConfig(a.type, a.config, { explanation: a.explanation, variables: a.variables });
        if (issues) throw new ToolRefusal("The config does not satisfy the type's schema; nothing was created.", issues);
      }
      // The concepts are resolved in the creation's own transaction: a refusal creates nothing.
      const created = await api.post(`/pools/${a.poolId}/questions`, {
        type: a.type,
        internalName: a.internalName,
        categoryId: a.categoryId ?? null,
        ...(a.concepts === undefined ? {} : { concepts: a.concepts, createMissing: a.createMissing ?? false }),
      });
      const id: string = created.meta.id;
      const meta = metaOf({ difficulty: a.difficulty });
      if (Object.keys(meta).length > 0) await api.patch(`/questions/${id}`, meta);
      return saveAndPublish(
        api,
        id,
        { config: a.config, explanation: a.explanation, variables: a.variables },
        a.publish,
      );
    },
  }),

  tool({
    name: "update_question",
    title: "Update a question",
    description:
      "Changes a question: its metadata, and/or its draft (config, explanation), then publishes a new " +
      "version (unless `publish` is false). Evaluations keep the version they were built with. A change " +
      "of metadata alone (a rename, the concepts) passes `publish: false`, or it publishes a new version " +
      "of unchanged content.",
    input: z.object({
      questionId: Id,
      config: z.record(z.string(), z.unknown()).optional(),
      explanation: z.string().max(20_000).optional(),
      variables: Variables,
      ...QuestionPatchFields.shape,
      internalName: QuestionPatchFields.shape.internalName.describe(INTERNAL_NAME_MEANING),
      concepts: Concepts,
      createMissing: CreateMissing,
      publish: z.boolean().default(true),
    })
    // As `create_question`: a stale client's `tags` are refused, not ignored.
    .strict(),
    annotations: WRITE,
    run: async (api, a) => {
      const current = await api.get(`/questions/${a.questionId}`);
      const meta = metaOf(a);
      if (Object.keys(meta).length > 0) await api.patch(`/questions/${a.questionId}`, meta);
      if (a.config === undefined && a.explanation === undefined && a.variables === undefined && !a.publish) {
        return { questionId: a.questionId, url: api.link(`/questions/${a.questionId}`) };
      }
      const config = a.config ?? current.draft?.config;
      if (a.publish) {
        const issues = checkConfig(current.meta.type, config, {
          explanation: a.explanation ?? current.draft?.explanation,
          // Absent: the draft's own table, which the publication will read.
          variables: a.variables === undefined ? current.draft?.variables : a.variables,
        });
        if (issues) throw new ToolRefusal("The config does not satisfy the type's schema; nothing was published.", issues);
      }
      return saveAndPublish(
        api,
        a.questionId,
        { config, explanation: a.explanation, variables: a.variables },
        a.publish,
      );
    },
  }),

  tool({
    name: "create_evaluation",
    title: "Create an evaluation",
    description:
      "Creates an evaluation in DRAFT directly in a classroom — `exercise` (practice, feedback allowed) or " +
      "`exam` — and adds the given questions. Call it ONLY when the teacher explicitly asks for an " +
      "evaluation in a classroom; to make a new quiz, use `create_template` instead (and `instantiate_template` " +
      "when they also want it in a class), so the quiz is kept in the course for next year. Every " +
      "question must be PUBLISHED and come from a pool linked to the classroom's course " +
      "(`link_pool_to_course`). Nothing is opened to students: the teacher schedules or starts it from the web app.",
    input: z.object({ classroomId: Id, ...QuizFields }),
    annotations: WRITE,
    run: (api, { classroomId, ...a }) => createQuiz(api, `/classrooms/${classroomId}/evaluations`, "evaluations", a),
  }),

  tool({
    name: "add_questions_to_evaluation",
    title: "Add questions to an evaluation",
    description:
      "Appends published questions to an evaluation still in `draft` or `scheduled`: once it is opened to " +
      "students (lobby or later) its questions are frozen. Each question must come from a pool linked to " +
      "the evaluation's course.",
    input: z.object({ evaluationId: Id, questionIds: z.array(Id).min(1).max(200) }),
    annotations: WRITE,
    run: (api, a) => api.post(`/evaluations/${a.evaluationId}/items`, { questionIds: a.questionIds }),
  }),

  tool({
    name: "update_evaluation",
    title: "Update an evaluation",
    description:
      "Changes an evaluation's title, `mode` (`exam` or `exercise`, only while it is a draft or scheduled with " +
      "no attempt, else 409 `mode_frozen`; nothing but the forced consequences changes with it: `immediate` " +
      "feedback becomes `on_release` for an exam, and an exam refuses retakes), settings, feedback policy, grading scale (linear, its rounding) or schedule (`opensAt`, " +
      "`closesAt` as ISO date-times, `durationS` in seconds). Does not start it. While it is running or " +
      "paused, only the title, the IP allowlist and the feedback policy may change " +
        "(an evaluation with a waiting room never takes `immediate` feedback). A poll's feedback policy " +
        "is never patched: it follows the poll's reveal.",
    input: z.object({ evaluationId: Id, ...EvaluationPatch.shape }),
    annotations: { ...WRITE, idempotentHint: true },
    run: (api, { evaluationId, ...body }) => api.patch(`/evaluations/${evaluationId}`, body),
  }),

  // --- Templates (ADR-031; ADR-022, addendum of 2026-10-01) ------------------

  tool({
    name: "list_templates",
    title: "List the templates of a course",
    description:
      "The evaluation templates of a course (ADR-031): reusable exams and exercises kept in the course, " +
      "from which each year's classroom gets its own copy. Check it before `create_template`, so nothing is " +
      "created twice.",
    input: z.object({ courseId: Id }),
    annotations: READ,
    run: async (api, a) =>
      (await api.get(`/courses/${a.courseId}/templates`)).map((t: { id: string }) => ({
        ...t,
        url: api.link(`/templates/${t.id}`),
      })),
  }),

  tool({
    name: "create_template",
    title: "Create a template",
    description:
      "THE default way to make a new quiz, exam or exercise: a template of the COURSE, not an evaluation of " +
      "a classroom, because a quiz is reused year to year and the template keeps it. Creates it with the " +
      "mode's preset and adds the given questions. Every question must be PUBLISHED and come from a pool " +
      "linked to the course (`link_pool_to_course`). Needs a seat on the course's staff: 404 otherwise, " +
      "like any course the teacher does not staff; do not retry elsewhere. If the questions are refused, " +
      "the template already exists, empty: do not create it again; fix the cause (publish, link the pool), " +
      "then add them with `add_questions_to_template` (its id is in `list_templates`). " +
      "Call `instantiate_template` when the teacher also wants it in a classroom.",
    input: z.object({ courseId: Id, ...QuizFields }),
    annotations: WRITE,
    run: (api, { courseId, ...a }) => createQuiz(api, `/courses/${courseId}/templates`, "templates", a),
  }),

  tool({
    name: "add_questions_to_template",
    title: "Add questions to a template",
    description:
      "Appends published questions to a template; each must come from a pool linked to the template's " +
      "course. Its instances are not changed: they take the new revision only when the teacher pulls it.",
    input: z.object({ templateId: Id, questionIds: z.array(Id).min(1).max(200) }),
    annotations: WRITE,
    run: async (api, a) => ({
      ...(await api.post(`/templates/${a.templateId}/items`, { questionIds: a.questionIds })),
      url: api.link(`/templates/${a.templateId}`),
    }),
  }),

  tool({
    name: "instantiate_template",
    title: "Instantiate a template in a classroom",
    description:
      "Copies a template into a classroom of the SAME course as a new DRAFT evaluation (the title is the " +
      "template's unless given). A classroom of another course is a 404. A question whose pool the course " +
      "no longer links is refused with 422 `template_pool_unlinked` (relink it with `link_pool_to_course`); " +
      "`deprecatedItems` lists the questions frozen on a deprecated version, a warning only. Nothing is " +
      "opened to students.",
    input: z.object({ templateId: Id, ...TemplateInstantiate.shape }),
    annotations: WRITE,
    run: async (api, { templateId, ...body }) => {
      const made = await api.post(`/templates/${templateId}/instances`, body);
      return { ...made, url: api.link(`/evaluations/${made.evaluation.id}`) };
    },
  }),

  tool({
    name: "create_poll",
    title: "Launch a live poll",
    description:
      "Creates AND STARTS a one-question live poll: participants join with the returned code or " +
      "`joinUrl`. With `classroomId`, only that classroom's students (signed in) and its staff may answer, " +
      "by name; without it, the poll belongs to no classroom and anyone with the code answers anonymously. " +
      "Either pass `questionId` (a published `mcq` or `short` question) or write one inline with `type` + " +
      "`config` (not saved in any pool; an opinion poll may have no correct answer). Only call it when the " +
      "teacher wants to poll NOW.",
    input: z.object({
      classroomId: Id.optional().describe(
        "The classroom whose students answer; omit for an anonymous poll open to anyone with the code",
      ),
      questionId: Id.optional(),
      type: PollQuestionType.optional(),
      config: z.record(z.string(), z.unknown()).optional(),
    }),
    annotations: { ...WRITE, openWorldHint: true },
    run: async (api, a) => {
      const audience = a.classroomId
        ? { kind: "classroom", classroomId: a.classroomId }
        : { kind: "anonymous" };
      let view;
      if (a.questionId) {
        view = await api.post("/polls", { audience, questionId: a.questionId });
      } else if (a.type && a.config) {
        view = await api.post("/polls/inline", { audience, type: a.type, config: a.config });
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

/** A tool's input as JSON Schema, `$schema` dropped: what a model is handed (`tools/list`, the help assistant). */
export function inputJsonSchema(input: z.ZodObject): Record<string, unknown> {
  const schema = z.toJSONSchema(input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/** Why a tool call gave no result; each caller words it for its own reader. */
export type ToolFailure =
  | { kind: "invalid_arguments"; issues: { path: string; message: string }[] }
  | { kind: "refused"; status: number; body: unknown }
  | { kind: "tool_refusal"; message: string; details: unknown }
  | { kind: "internal"; cause: unknown };
export type ToolOutcome = { ok: true; value: unknown } | { ok: false; error: ToolFailure };

/**
 * One call of a tool: its arguments validated by its schema, then its
 * handler over `api`. A refusal of a route (`ApiError`), of the tool
 * (`ToolRefusal`) or an unexpected error comes back as a `ToolFailure`,
 * never thrown: the MCP server and the help assistant word it each their way.
 */
export async function runTool(api: Api, tool: Tool, raw: unknown): Promise<ToolOutcome> {
  const args = tool.input.safeParse(raw);
  if (!args.success) {
    const issues = args.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return { ok: false, error: { kind: "invalid_arguments", issues } };
  }
  try {
    return { ok: true, value: await tool.run(api, args.data) };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, error: { kind: "refused", status: error.status, body: error.body } };
    if (error instanceof ToolRefusal) {
      return { ok: false, error: { kind: "tool_refusal", message: error.message, details: error.details } };
    }
    return { ok: false, error: { kind: "internal", cause: error } };
  }
}

/**
 * `tools/list`: the catalogue with each input as JSON Schema. Every tool
 * declares the OAuth scheme it needs: ChatGPT reads `securitySchemes` per
 * tool to decide when to run its sign-in (ADR-023); other hosts ignore it.
 */
export function toolDescriptors() {
  return TOOLS.map((t) => {
    const inputSchema = inputJsonSchema(t.input);
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
