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
export const QuestionTypeId = z.enum(["mcq", "short", "cloze", "code"]);
export type QuestionTypeId = z.infer<typeof QuestionTypeId>;

export const PoolVisibility = z.enum(["private", "shared", "public"]);
export type PoolVisibility = z.infer<typeof PoolVisibility>;

// --- Pools ---------------------------------------------------------------

export const Pool = z.object({
  id: z.uuid(),
  name: z.string(),
  visibility: PoolVisibility,
  ownerId: z.uuid(),
  isPersonal: z.boolean(),
  createdAt: z.string(),
});
export type Pool = z.infer<typeof Pool>;

export const PoolSummary = Pool.extend({ questionCount: z.number().int() });
export type PoolSummary = z.infer<typeof PoolSummary>;

export const PoolCreate = z.object({
  name: z.string().trim().min(1).max(200),
  visibility: PoolVisibility.default("private"),
});
export type PoolCreate = z.infer<typeof PoolCreate>;

export const PoolPatch = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    visibility: PoolVisibility.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update" });
export type PoolPatch = z.infer<typeof PoolPatch>;

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
  categories: z.array(CategoryNode),
  tags: z.array(z.string()),
  questionCount: z.number().int(),
});
export type PoolDetail = z.infer<typeof PoolDetail>;
