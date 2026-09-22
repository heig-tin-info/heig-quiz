/**
 * `pool` route schemas (PLAN-MVP §4.2): pools, categories, questions, their
 * versions and the assets they embed.
 *
 * `config` travels as `unknown` on purpose: its shape belongs to the question
 * type (`configSchema` in the registry), and an invalid draft is stored as-is
 * (decision D16). The API parses it with the type's own schema, never here.
 */
import { z } from "zod";

import { IntList, StringList, ZodIssueLite, pageOf } from "./common.js";

/**
 * The question types of the MVP. `QUESTION_TYPE_IDS` in `@quiz/core` is the
 * source of truth; `apps/api/src/modules/pool/routes.ts` asserts at compile
 * time that the two lists agree, so a fifth type cannot land on one side only.
 */
export const QuestionTypeId = z.enum(["mcq", "short", "cloze", "code", "circuit"]);
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

// --- Pools ---------------------------------------------------------------

export const Pool = z.object({
  id: z.uuid(),
  name: z.string(),
  icon: PoolIcon.nullable(),
  visibility: PoolVisibility,
  ownerId: z.uuid(),
  isPersonal: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Pool = z.infer<typeof Pool>;

export const PoolSummary = Pool.extend({
  questionCount: z.number().int(),
  /** The caller's effective role in this pool. */
  role: PoolRole,
  /** "Prof Démo" — shown on a pool the caller does not own. */
  ownerName: z.string(),
  /** Explicit members (the owner excluded), for the card's "shared with n". */
  memberCount: z.number().int(),
});
export type PoolSummary = z.infer<typeof PoolSummary>;

export const PoolCreate = z.object({
  name: z.string().trim().min(1).max(200),
  icon: PoolIcon.nullable().optional(),
  visibility: PoolVisibility.default("private"),
});
export type PoolCreate = z.infer<typeof PoolCreate>;

export const PoolPatch = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    icon: PoolIcon.nullable().optional(),
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
});
export type QuestionRow = z.infer<typeof QuestionRow>;

export const QuestionPage = pageOf(QuestionRow);
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
  includeDeleted: z
    .union([z.string(), z.boolean()])
    .transform((v) => v === true || v === "1" || v === "true")
    .optional(),
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
    randomizable: z.boolean().optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update" });
export type QuestionPatch = z.infer<typeof QuestionPatch>;

// --- Draft and versions --------------------------------------------------

export const QuestionDraft = z.object({
  config: z.unknown(),
  explanation: z.string(),
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
  configVersion: z.number().int(),
});
export type VersionDetail = z.infer<typeof VersionDetail>;

export const QuestionDetail = z.object({
  meta: QuestionMeta,
  draft: QuestionDraft,
  versions: z.array(VersionRow),
  latestPublished: VersionRow.nullable(),
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

/**
 * A course whose evaluations use one of the questions being moved, while the
 * target pool is not among the pools that course draws from. Named in the
 * 409 so the dialog can say WHICH classroom is concerned rather than "this
 * question is used somewhere".
 */
export const MoveBlockingCourse = z.object({
  courseId: z.uuid(),
  courseName: z.string(),
  courseCode: z.string(),
  classrooms: z.array(z.object({ id: z.uuid(), name: z.string() })),
  /** The caller holds a staff seat, so `linkCourses: true` can cover it. */
  mayLink: z.boolean(),
});
export type MoveBlockingCourse = z.infer<typeof MoveBlockingCourse>;

/**
 * The 409 of a refused move, in three flavours, all shaped the same so the
 * client parses one schema:
 *   - `pool_not_linked`: ask the teacher, retry with `linkCourses: true`;
 *   - `course_forbidden`: a named course is not theirs to link — no retry;
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
export const VersionSource = z.union([z.literal("draft"), z.coerce.number().int().min(1)]);
export type VersionSource = z.infer<typeof VersionSource>;

export const PreviewBody = z.object({ source: VersionSource.default("draft") });
export type PreviewBody = z.infer<typeof PreviewBody>;

export const PreviewResult = z.object({
  student: z.unknown(),
  itemPoints: z.number(),
});
export type PreviewResult = z.infer<typeof PreviewResult>;

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
  }),
  /** No runner is configured or it refused the job (decision D14). */
  z.object({ status: z.literal("runner_unavailable"), reason: z.string() }),
  /** Phase 2: an LLM matcher cannot be graded in the MVP. */
  z.object({ status: z.literal("llm_unavailable") }),
]);
export type TryResult = z.infer<typeof TryResult>;

// --- Assets --------------------------------------------------------------

export const AssetMime = z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export type AssetMime = z.infer<typeof AssetMime>;

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
