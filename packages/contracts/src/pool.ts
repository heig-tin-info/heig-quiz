/**
 * `pool` route schemas (PLAN-MVP §4.2): pools, categories, questions, their
 * versions and the assets they embed.
 *
 * `config` travels as `unknown` on purpose: its shape belongs to the question
 * type (`configSchema` in the registry), and an invalid draft is stored as-is
 * (decision D16). The API parses it with the type's own schema, never here.
 */
import { z } from "zod";

import { BoolFlag, IntList, StringList, ZodIssueLite, pageOf } from "./common.js";
import { NamedValues, ParametersDraft } from "./parameters.js";
import { QuestionReview, ReviewPill } from "./review.js";

/**
 * The question types of the MVP. `QUESTION_TYPE_IDS` in `@quiz/core` is the
 * source of truth; `apps/api/src/modules/pool/routes.ts` asserts at compile
 * time that the two lists agree, so a fifth type cannot land on one side only.
 */
export const QuestionTypeId = z.enum(["mcq", "short", "cloze", "code", "circuit", "codeimage", "rich", "categorize", "diagram", "brainstorm"]);
export type QuestionTypeId = z.infer<typeof QuestionTypeId>;

export const PoolVisibility = z.enum(["private", "shared", "public"]);
export type PoolVisibility = z.infer<typeof PoolVisibility>;

/**
 * What an account may do in a pool (F-POOL-05). `reader` reads, `contributor`
 * edits questions, `owner` also manages the members, the name, the icon, the
 * visibility and the deletion. The pool's `ownerId` is always an owner; a
 * member may be one too.
 */
export const PoolRole = z.enum(["reader", "contributor", "owner"]);
export type PoolRole = z.infer<typeof PoolRole>;

/** A lucide icon name (`flask-conical`, `cpu`, …); null shows the default. */
export const PoolIcon = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64);

/**
 * The colour a pool's icon is drawn in (#213). A closed set of NAMES, never a
 * hex value: each theme resolves a name to its own token, so a pool stays
 * legible in light and in dark. Grey, the default, is NOT a name: it is null,
 * the way `icon: null` is the default icon, so it has one spelling only.
 */
export const POOL_COLORS = [
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "pink",
] as const;
export const PoolColor = z.enum(POOL_COLORS);
export type PoolColor = z.infer<typeof PoolColor>;

// --- Pools ---------------------------------------------------------------

export const Pool = z.object({
  id: z.uuid(),
  name: z.string(),
  icon: PoolIcon.nullable(),
  color: PoolColor.nullable(),
  visibility: PoolVisibility,
  ownerId: z.uuid(),
  isPersonal: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Pool = z.infer<typeof Pool>;

export const PoolSummary = Pool.extend({
  questionCount: z.number().int(),
  /**
   * The questions of the pool (live ones, every version together) that a
   * student has met: frozen in an exam or exercise with a started attempt of
   * a student account that is not a staff walk (ADR-013, amendment of
   * 2026-10-04). Never more than `questionCount`.
   */
  usedCount: z.number().int(),
  /** The caller's effective role in this pool: what the screen gates its actions on. */
  role: PoolRole,
  /**
   * The role the caller holds in their own right, Super Powers set aside —
   * what the list SHOWS (ADR-013, amendment of 2026-10-04). Equal to `role`
   * for everyone but an admin with Super Powers on.
   */
  heldRole: PoolRole,
  /** "Prof Démo": the owner's display name (the avatar's label, the sort key). */
  ownerName: z.string(),
  ownerGivenName: z.string(),
  ownerFamilyName: z.string(),
  /** Upload, else IdP picture; null with neither (the client draws initials). */
  ownerAvatarUrl: z.string().nullable(),
  /** Explicit members (the owner excluded), for the card's "shared with n". */
  memberCount: z.number().int(),
});
export type PoolSummary = z.infer<typeof PoolSummary>;

export const PoolCreate = z.object({
  name: z.string().trim().min(1).max(200),
  icon: PoolIcon.nullable().optional(),
  color: PoolColor.nullable().optional(),
  visibility: PoolVisibility.default("private"),
});
export type PoolCreate = z.infer<typeof PoolCreate>;

export const PoolPatch = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    icon: PoolIcon.nullable().optional(),
    color: PoolColor.nullable().optional(),
    visibility: PoolVisibility.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update" });
export type PoolPatch = z.infer<typeof PoolPatch>;

// --- Members (F-POOL-05) ---------------------------------------------------

/** One account in a pool: the owner row first, then the members in the order they were added. */
export const PoolMember = z.object({
  userId: z.uuid(),
  email: z.string(),
  givenName: z.string(),
  familyName: z.string(),
  role: PoolRole,
  /** `true` on the `pools.owner_id` account; it cannot be removed or demoted here. */
  isOwner: z.boolean(),
  /** When the seat was given; the succession order when the owner goes. */
  addedAt: z.string(),
});
export type PoolMember = z.infer<typeof PoolMember>;

export const PoolMembers = z.object({
  visibility: PoolVisibility,
  members: z.array(PoolMember),
});
export type PoolMembers = z.infer<typeof PoolMembers>;

/** `GET /pools/:id/candidates?q=`: a few letters of a name or an address. */
export const PoolCandidateQuery = z.object({ q: z.string().trim().max(100).default("") });
export type PoolCandidateQuery = z.infer<typeof PoolCandidateQuery>;

/** A teacher account that holds no seat on the pool yet: what the invite picker offers. */
export const PoolCandidate = z.object({
  userId: z.uuid(),
  email: z.string(),
  givenName: z.string(),
  familyName: z.string(),
});
export type PoolCandidate = z.infer<typeof PoolCandidate>;

export const PoolCandidates = z.array(PoolCandidate);
export type PoolCandidates = z.infer<typeof PoolCandidates>;

/**
 * `POST /pools/:id/members`: the account picked among the candidates
 * (`userId`), or named by an address the picker does not list — one of the
 * two, never both. Either way it must be a teacher.
 */
export const PoolMemberInvite = z
  .object({
    userId: z.uuid().optional(),
    email: z.string().trim().toLowerCase().email().max(200).optional(),
    role: PoolRole.default("reader"),
  })
  .refine((b) => (b.userId === undefined) !== (b.email === undefined), {
    message: "Either userId or email",
  });
export type PoolMemberInvite = z.infer<typeof PoolMemberInvite>;

/** `PATCH /pools/:id/members/:userId`. */
export const PoolMemberPatch = z.object({ role: PoolRole });
export type PoolMemberPatch = z.infer<typeof PoolMemberPatch>;

export const PoolMemberParam = z.object({ id: z.uuid(), userId: z.uuid() });
export type PoolMemberParam = z.infer<typeof PoolMemberParam>;

// --- Categories ----------------------------------------------------------

export const Category = z.object({
  id: z.uuid(),
  poolId: z.uuid(),
  parentId: z.uuid().nullable(),
  name: z.string(),
  position: z.number().int(),
});
export type Category = z.infer<typeof Category>;

/** The same rows as a tree, which is how the pool sidebar reads them. */
export interface CategoryNode extends Category {
  children: CategoryNode[];
}
export const CategoryNode: z.ZodType<CategoryNode> = z.lazy(() =>
  Category.extend({ children: z.array(CategoryNode) }),
);

/**
 * A folder of the categories page, with the number of live questions filed
 * DIRECTLY in it — the number the pool's category filter lists — and its
 * sub-folders. The subtree total is a sum the page draws from these.
 */
export interface CategoryCountNode extends Category {
  questionCount: number;
  children: CategoryCountNode[];
}
export const CategoryCountNode: z.ZodType<CategoryCountNode> = z.lazy(() =>
  Category.extend({
    questionCount: z.number().int().min(0),
    children: z.array(CategoryCountNode),
  }),
);

/** `GET /pools/:id/categories`: the tree with its counts, and the pool root's. */
export const PoolCategories = z.object({
  categories: z.array(CategoryCountNode),
  /** Live questions filed in no category at all. */
  rootQuestionCount: z.number().int().min(0),
});
export type PoolCategories = z.infer<typeof PoolCategories>;

export const CategoryCreate = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: z.uuid().nullable().optional(),
});
export type CategoryCreate = z.infer<typeof CategoryCreate>;

export const CategoryPatch = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    parentId: z.uuid().nullable().optional(),
    position: z.number().int().min(0).max(10_000).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update" });
export type CategoryPatch = z.infer<typeof CategoryPatch>;

/** Whole-tree reorder in one call: drag-and-drop sends the new layout. */
export const CategoryOrder = z.object({
  items: z
    .array(
      z.object({
        id: z.uuid(),
        parentId: z.uuid().nullable().default(null),
        position: z.number().int().min(0).max(10_000),
      }),
    )
    .max(500),
});
export type CategoryOrder = z.infer<typeof CategoryOrder>;

// --- Questions -----------------------------------------------------------

export const QuestionMeta = z.object({
  id: z.uuid(),
  poolId: z.uuid(),
  type: z.string(),
  internalName: z.string(),
  categoryId: z.uuid().nullable(),
  difficulty: z.number().int().min(1).max(5),
  shuffleable: z.boolean(),
  randomizable: z.boolean(),
  tags: z.array(z.string()),
  createdBy: z.uuid().nullable(),
  originQuestionId: z.uuid().nullable(),
  deletedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type QuestionMeta = z.infer<typeof QuestionMeta>;

export const QuestionRow = z.object({
  id: z.uuid(),
  type: z.string(),
  internalName: z.string(),
  difficulty: z.number().int(),
  tags: z.array(z.string()),
  categoryId: z.uuid().nullable(),
  /** Highest published version number, null while the question is a draft only. */
  latestNumber: z.number().int().nullable(),
  /** The draft moved after the last publication (the editor shows a dot). */
  hasDraftChanges: z.boolean(),
  updatedAt: z.string(),
  deprecated: z.boolean(),
  deletedAt: z.string().nullable(),
  /**
   * The latest published version holds no answer key: a question kept after
   * an opinion poll (ADR-014, addenda 2026-09-23). It can run a poll again,
   * never an evaluation (`422 question_keyless`).
   */
  keyless: z.boolean(),
  /**
   * The CALLER starred it (F-POOL-10, ADR-040): a personal bookmark, false
   * for everyone else and always false on a soft-deleted question.
   */
  starred: z.boolean(),
  /**
   * Its latest published version declares variables (ADR-056 §1, §8): the
   * list's "Parameterized" pill. `questions.randomizable`, derived at
   * publication.
   */
  randomizable: z.boolean(),
  /** The LLM review of the latest published version (ADR-060 §3): the pill; null when not reviewed. */
  review: ReviewPill.nullable(),
});
export type QuestionRow = z.infer<typeof QuestionRow>;

/**
 * One page of a pool's questions. `total` counts EVERY question the search
 * matches, not the page: the screen says "42 questions" while it holds 25.
 */
export const QuestionPage = pageOf(QuestionRow).extend({ total: z.number().int().nonnegative() });
export type QuestionPage = z.infer<typeof QuestionPage>;

/**
 * Filter bar of the pool screen, as query parameters. Repeated (`?tag=a&tag=b`)
 * and comma-separated (`?tag=a,b`) forms are both accepted.
 */
export const QuestionSort = z.enum(["name", "type", "difficulty", "version", "updated"]);
export type QuestionSort = z.infer<typeof QuestionSort>;

export const QuestionSearch = z.object({
  q: z.string().trim().max(200).optional(),
  type: StringList.optional(),
  tag: StringList.optional(),
  difficulty: IntList.optional(),
  categoryId: z.uuid().optional(),
  /** Soft-deleted questions are hidden unless this is set (F-QST-11). */
  includeDeleted: BoolFlag.optional(),
  /** Only the questions the caller starred (F-POOL-10); the order and the cursor are unchanged. */
  starred: BoolFlag.optional(),
  /**
   * Published version number bounds (`version:>1`, `version:v2` in the search
   * box). A draft-only question has no number and matches neither bound.
   */
  versionMin: z.coerce.number().int().min(0).optional(),
  versionMax: z.coerce.number().int().min(0).optional(),
  /** Column sort; the cursor encodes the sort, so a page never mixes two orders. */
  sort: QuestionSort.default("updated"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});
export type QuestionSearch = z.infer<typeof QuestionSearch>;

export const QuestionCreate = z.object({
  type: QuestionTypeId,
  internalName: z.string().trim().min(1).max(200),
  categoryId: z.uuid().nullable().optional(),
});
export type QuestionCreate = z.infer<typeof QuestionCreate>;

export const QuestionPatch = z
  .object({
    internalName: z.string().trim().min(1).max(200).optional(),
    categoryId: z.uuid().nullable().optional(),
    difficulty: z.number().int().min(1).max(5).optional(),
    shuffleable: z.boolean().optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update" });
export type QuestionPatch = z.infer<typeof QuestionPatch>;

// --- Draft and versions --------------------------------------------------

export const QuestionDraft = z.object({
  config: z.unknown(),
  explanation: z.string(),
  /** The variables table (ADR-056); null for a static question. Never in a student schema. */
  variables: ParametersDraft.nullable(),
  configVersion: z.number().int(),
  updatedAt: z.string(),
  /** False when the stored config does not satisfy the type's schema (D16). */
  valid: z.boolean(),
});
export type QuestionDraft = z.infer<typeof QuestionDraft>;

/** Autosave body (F-QST-02). An invalid config is STORED, never refused. */
export const DraftPut = z.object({
  config: z.unknown(),
  explanation: z.string().max(20_000).optional(),
  /**
   * The variables table (ADR-056), stored as sent like the config (D16):
   * absent keeps the draft's, null makes the question static again.
   */
  variables: ParametersDraft.nullable().optional(),
});
export type DraftPut = z.infer<typeof DraftPut>;

export const DraftSaved = z.object({
  updatedAt: z.string(),
  valid: z.boolean(),
  issues: z.array(ZodIssueLite),
});
export type DraftSaved = z.infer<typeof DraftSaved>;

export const VersionRow = z.object({
  number: z.number().int(),
  publishedAt: z.string(),
  publishedBy: z.uuid().nullable(),
  changeNote: z.string().nullable(),
  deprecatedAt: z.string().nullable(),
  deprecationNote: z.string().nullable(),
});
export type VersionRow = z.infer<typeof VersionRow>;

export const VersionDetail = VersionRow.extend({
  config: z.unknown(),
  explanation: z.string(),
  variables: ParametersDraft.nullable(),
  configVersion: z.number().int(),
});
export type VersionDetail = z.infer<typeof VersionDetail>;

export const QuestionDetail = z.object({
  meta: QuestionMeta,
  draft: QuestionDraft,
  versions: z.array(VersionRow),
  latestPublished: VersionRow.nullable(),
  /** Same as `QuestionRow.keyless`: the latest published version has no key. */
  keyless: z.boolean(),
  /** The LLM review of the latest published version (ADR-060), findings included; null when not reviewed. */
  review: QuestionReview.nullable(),
});
export type QuestionDetail = z.infer<typeof QuestionDetail>;

export const PublishBody = z.object({ changeNote: z.string().max(500).optional() });
export type PublishBody = z.infer<typeof PublishBody>;

export const DeprecateBody = z.object({ note: z.string().trim().min(1).max(500) });
export type DeprecateBody = z.infer<typeof DeprecateBody>;

export const CopyBody = z.object({
  targetPoolId: z.uuid(),
  categoryId: z.uuid().nullable().optional(),
});
export type CopyBody = z.infer<typeof CopyBody>;

/**
 * `POST /questions/move` — the question CHANGES pool and keeps its id, so
 * every evaluation item frozen on one of its versions keeps resolving
 * (F-EVAL-03). A copy duplicates (F-POOL-04); a move relocates.
 *
 * One body for one question and for twenty: the drag-and-drop of the sidebar
 * sends a list of one, the bulk bar sends the selection, and the server has a
 * single path to test. `categoryId` names a category OF THE TARGET pool; its
 * absence files the questions at the root.
 */
export const MoveBody = z.object({
  questionIds: z.array(z.uuid()).min(1).max(200),
  targetPoolId: z.uuid(),
  categoryId: z.uuid().nullable().optional(),
  /**
   * The retry the UI sends after the teacher answered the 409: link the
   * target pool to the courses the conflict named, as part of the move. It is
   * honoured only for the courses the caller is staff of (`staffAccess`).
   */
  linkCourses: z.boolean().optional(),
});
export type MoveBody = z.infer<typeof MoveBody>;

// --- Favourites (F-POOL-10, ADR-040) ---------------------------------------

/**
 * `PUT` and `DELETE /questions/star`: star or unstar a batch, idempotently.
 * Every id must be a question the caller reaches, or the whole batch is a 404.
 */
export const QuestionStarBody = z.object({ questionIds: z.array(z.uuid()).min(1).max(200) });
export type QuestionStarBody = z.infer<typeof QuestionStarBody>;

/** `DELETE /pools/:id/stars`: how many of the caller's stars in that pool went. */
export const StarsCleared = z.object({ cleared: z.number().int().nonnegative() });
export type StarsCleared = z.infer<typeof StarsCleared>;

/**
 * A course whose evaluations use one of the questions being moved, while the
 * target pool is not among the pools that course draws from. Named in the
 * 409 so the dialog can say WHICH classroom is concerned rather than "this
 * question is used somewhere".
 */
export const MoveBlockingCourse = z.object({
  /**
   * Null, like `courseName`, and `classrooms` empty, for a course the caller
   * is not on the staff of (an assistant's course is shown in full): the 409 names it by its code and says no more
   * about a course they cannot open (invariant 6).
   */
  courseId: z.uuid().nullable(),
  courseName: z.string().nullable(),
  courseCode: z.string(),
  classrooms: z.array(z.object({ id: z.uuid(), name: z.string() })),
  /** The caller owns the course (ADR-068), so `linkCourses: true` can cover it. */
  mayLink: z.boolean(),
});
export type MoveBlockingCourse = z.infer<typeof MoveBlockingCourse>;

/**
 * The 409 of a refused move, in three flavours, all shaped the same so the
 * client parses one schema:
 *   - `pool_not_linked`: ask the teacher, retry with `linkCourses: true`;
 *   - `course_forbidden`: a named course is not theirs to link (they are not
 *     an owner of it, ADR-068) — no retry;
 *   - `name_taken`: the target pool already has a question by that internal
 *     name, and a move keeps the name it moves (ADR-017).
 */
export const MoveConflict = z.object({
  error: z.enum(["pool_not_linked", "course_forbidden", "name_taken"]),
  message: z.string(),
  courses: z.array(MoveBlockingCourse).default([]),
  /** The internal names that already exist in the target pool. */
  names: z.array(z.string()).default([]),
});
export type MoveConflict = z.infer<typeof MoveConflict>;

export const MoveResult = z.object({
  moved: z.number().int(),
  questionIds: z.array(z.uuid()),
  targetPoolId: z.uuid(),
  categoryId: z.uuid().nullable(),
  /** The courses the move linked the target pool to, if any. */
  linkedCourseIds: z.array(z.uuid()),
});
export type MoveResult = z.infer<typeof MoveResult>;

export const VersionParam = z.object({
  id: z.uuid(),
  number: z.coerce.number().int().min(1),
});
export type VersionParam = z.infer<typeof VersionParam>;

/** `"draft"` or a published version number. */
const VersionSource = z.union([z.literal("draft"), z.coerce.number().int().min(1)]);
type VersionSource = z.infer<typeof VersionSource>;

export const PreviewBody = z.object({ source: VersionSource.default("draft") });
export type PreviewBody = z.infer<typeof PreviewBody>;

export const PreviewResult = z.object({
  /**
   * The question type the preview belongs to. It travels with the view
   * because a preview is played by the type's own `Player`, and a surface
   * that only has the preview (the full-page student preview of a question,
   * opened in its own tab) would otherwise have to fetch the whole teacher
   * detail just to learn which component to mount.
   */
  type: z.string(),
  student: z.unknown(),
  itemPoints: z.number(),
  /**
   * The version has variables (ADR-056): the view is the first of the five
   * draws the editor lists, `draw(params, 0)`, and the Try tab says so.
   */
  parameterized: z.boolean(),
});
export type PreviewResult = z.infer<typeof PreviewResult>;

/**
 * The key of a teacher's preview, asked for by its "Show answers" button and
 * never sent with the preview itself: the one a student reads once the key
 * is shown (`studentSolutionView`, ADR-037), for the same view as the player.
 * `POST /questions/:id/preview/solution` and `GET …/preview/items/:itemId/solution`.
 */
export const PreviewSolution = z.object({ solution: z.unknown() });
export type PreviewSolution = z.infer<typeof PreviewSolution>;

/**
 * `POST /questions/:id/draft/instances` (ADR-056 §8): the five instances of
 * a parameterized DRAFT, drawn on the server exactly as publication draws
 * the ones it checks (seeds 0 to 4), so the browser evaluates nothing.
 * Teacher-facing: the values and the key of each instance are there.
 * `issues` instead of instances when the draft would not publish; both
 * empty for a static draft.
 */
export const DraftInstance = z.object({
  seed: z.number().int(),
  /** The variables in the table's order, each written with its format. */
  values: NamedValues,
  /** The instance as a student reads it (`studentView`, seed 0, no shuffle). */
  student: z.unknown(),
  /** Its key, as the preview's "Show answers" reads it. */
  solution: z.unknown(),
  itemPoints: z.number(),
  /** The explanation, instantiated. */
  explanation: z.string(),
});
export type DraftInstance = z.infer<typeof DraftInstance>;

export const DraftInstances = z.object({
  instances: z.array(DraftInstance),
  issues: z.array(ZodIssueLite),
});
export type DraftInstances = z.infer<typeof DraftInstances>;

/** Teacher rehearsal (F-QST-09): graded in process, never persisted. */
export const TryBody = z.object({
  source: VersionSource.default("draft"),
  answer: z.unknown(),
});
export type TryBody = z.infer<typeof TryBody>;

export const TryResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("graded"),
    points: z.number(),
    maxPoints: z.number(),
    details: z.unknown(),
    solution: z.unknown(),
    /**
     * The grader only PROPOSED `points` (`state: "proposed"`): an essay, a
     * manual circuit — a person decides (issue #267). Absent otherwise.
     */
    manual: z.literal(true).optional(),
    /** With `manual`: the grader's machine reason, when it gave one (`reference_failed`, …). */
    comment: z.string().optional(),
  }),
  /** No runner is configured or it refused the job (decision D14). */
  z.object({ status: z.literal("runner_unavailable"), reason: z.string() }),
  /** Phase 2: an LLM matcher cannot be graded in the MVP. */
  z.object({ status: z.literal("llm_unavailable") }),
]);
export type TryResult = z.infer<typeof TryResult>;

// --- Assets --------------------------------------------------------------

/**
 * THE set of image types the platform accepts, and the source of truth for
 * every place that has to repeat it (B-19). SVG is deliberately absent: it is
 * a script container, and sanitising it is a project of its own (N-SEC).
 */
export const AssetMime = z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export type AssetMime = z.infer<typeof AssetMime>;

/**
 * The same set for an avatar, minus the animated gif: a profile picture is
 * cropped to a still 256x256 square, so accepting an animation would only
 * store frames nothing ever shows.
 */
export const AvatarMime = AssetMime.exclude(["image/gif"]);
export type AvatarMime = z.infer<typeof AvatarMime>;

export const Asset = z.object({
  id: z.uuid(),
  url: z.string(),
  mime: AssetMime,
  bytes: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
});
export type Asset = z.infer<typeof Asset>;

export const PoolDetail = z.object({
  pool: Pool,
  /** The caller's effective role: what the screen may offer. */
  role: PoolRole,
  categories: z.array(CategoryNode),
  tags: z.array(z.string()),
  questionCount: z.number().int(),
});
export type PoolDetail = z.infer<typeof PoolDetail>;

/**
 * The body of `409 pool_in_use` on `DELETE /pools/:id` (ADR-031, F-POOL-09):
 * a pool whose question versions an evaluation or a template still pins is
 * not deleted. The evaluations and templates the caller reaches are named;
 * the others — another course's — are only counted, so a refusal never
 * leaks what a caller could not open.
 */
export const PoolInUse = z.object({
  error: z.literal("pool_in_use"),
  uses: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      /** A course's template rather than a classroom's evaluation. */
      template: z.boolean(),
    }),
  ),
  hidden: z.number().int(),
});
export type PoolInUse = z.infer<typeof PoolInUse>;

// --- Tags ----------------------------------------------------------------

/**
 * The tag vocabulary of a pool (`GET /pools/:id/tags`): the tag, the one-line
 * description a teacher wrote for it and how many live questions wear it.
 * `PoolDetail.tags` stays a plain list of names — the filter bar needs
 * nothing more, and only the tag editor pays for the counts.
 */
export const PoolTag = z.object({
  tag: z.string(),
  description: z.string(),
  count: z.number().int(),
});
export type PoolTag = z.infer<typeof PoolTag>;

/**
 * One tag of the pool's "Tags" tab (`GET /pools/:id/tags/usage`): the tag,
 * its description, how many live questions wear it, and how many DISTINCT
 * courses use one of them — an exam or an exercise of a classroom of the
 * course, or a template of the course, pinning a version of such a
 * question. A bare count over every course, the ones the reader cannot
 * reach included: never a name. A route of its own, so the tag field
 * (`PoolTag`) does not pay for the join.
 */
export const PoolTagUsage = z.object({
  tag: z.string(),
  description: z.string(),
  questions: z.number().int(),
  courses: z.number().int(),
});
export type PoolTagUsage = z.infer<typeof PoolTagUsage>;

export const TagPatch = z.object({
  description: z.string().trim().max(200),
});
export type TagPatch = z.infer<typeof TagPatch>;

/** `:tag` of `PATCH /pools/:id/tags/:tag`, normalized like a stored tag. */
export const TagParam = z.object({
  id: z.uuid(),
  tag: z.string().trim().min(1).max(64),
});
export type TagParam = z.infer<typeof TagParam>;

// --- Similar questions ---------------------------------------------------

/**
 * `GET /courses/:id/similar-questions`: the questions close to a statement
 * about to be written (ADR-022, addendum of 2026-10-01), over every pool the
 * caller reaches, the course's own first — its text, optionally one type,
 * and how many hits (ranked, no threshold).
 */
export const SimilarQuestionSearch = z.object({
  text: z.string().trim().min(1).max(4000),
  type: QuestionTypeId.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type SimilarQuestionSearch = z.infer<typeof SimilarQuestionSearch>;

/**
 * One hit: a PUBLISHED, live question of a pool the caller reaches.
 * `linked`: its pool is linked to the course, so an evaluation of the course
 * may use it as it is. `canLink`: linking its pool would succeed (the caller
 * is at least `contributor` on it, ADR-013). `stats` is the pool screen's
 * figure (ADR-038, exams only): null below ten counted answers — withheld,
 * not zero; `r` is the discrimination index (ADR-042), null when no exam
 * qualifies.
 */
export const SimilarQuestion = z.object({
  questionId: z.uuid(),
  pool: z.object({ id: z.uuid(), name: z.string() }),
  type: QuestionTypeId,
  internalName: z.string(),
  /** The start of the latest published statement, whitespace folded. */
  excerpt: z.string(),
  latestNumber: z.number().int().min(1),
  linked: z.boolean(),
  canLink: z.boolean(),
  stats: z
    .object({ n: z.number().int().nonnegative(), p: z.number(), r: z.number().nullable() })
    .nullable(),
});
export type SimilarQuestion = z.infer<typeof SimilarQuestion>;

export const SimilarQuestions = z.object({ items: z.array(SimilarQuestion) });
export type SimilarQuestions = z.infer<typeof SimilarQuestions>;
