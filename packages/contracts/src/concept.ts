/**
 * `concept` route schemas: the instance-wide vocabulary of concepts that
 * will replace the tags (ADR-081, addendum 2026-10-08 §1a: the registry
 * alone, connected to nothing yet).
 *
 * A concept has a label, a qualifier and a description per language; a
 * `proposed` concept may have one language only. Its identity is its id; a
 * merged concept keeps its row and names, in `mergedInto`, the concept it
 * was merged into.
 */
import { z } from "zod";

export const CONCEPT_LANGS = ["fr", "en"] as const;
export const ConceptLang = z.enum(CONCEPT_LANGS);
export type ConceptLang = z.infer<typeof ConceptLang>;

export const CONCEPT_STATUSES = ["proposed", "validated", "merged"] as const;
export const ConceptStatus = z.enum(CONCEPT_STATUSES);
export type ConceptStatus = z.infer<typeof ConceptStatus>;

/** One value per language. */
const perLang = <T extends z.ZodType>(value: T) => z.object({ fr: value, en: value });

export const Concept = z.object({
  id: z.uuid(),
  status: ConceptStatus,
  mergedInto: z.uuid().nullable(),
  /** At least one is set; the reader's language is shown, falling back to the other. */
  labels: perLang(z.string().nullable()),
  /** `mémoire` in `adresse (mémoire)`: what tells homonyms apart (ADR-081 §5); `""` when none. */
  qualifiers: perLang(z.string()),
  descriptions: perLang(z.string()),
  /** The teacher who proposed it; null once their account is gone. */
  createdBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type Concept = z.infer<typeof Concept>;

export const ConceptList = z.object({ concepts: z.array(Concept) });
export type ConceptList = z.infer<typeof ConceptList>;

/** A label must hold a letter or a digit, so that its key is never empty. */
const ConceptLabel = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/[\p{L}\p{N}]/u, "a label needs a letter or a digit");
const ConceptQualifier = z.string().trim().max(120);
const ConceptDescription = z.string().trim().max(500);

/** A new `proposed` concept, in one language: the creator's. */
export const ConceptCreate = z.object({
  lang: ConceptLang,
  label: ConceptLabel,
  qualifier: ConceptQualifier.optional(),
  description: ConceptDescription.optional(),
});
export type ConceptCreate = z.infer<typeof ConceptCreate>;

/** What one language of a concept may change; at least one field. */
const ConceptLangPatch = z
  .object({
    label: ConceptLabel.optional(),
    qualifier: ConceptQualifier.optional(),
    description: ConceptDescription.optional(),
  })
  .refine((p) => Object.keys(p).length > 0, "nothing to change");

/** `PATCH /concepts/:id`: either language, or both. */
export const ConceptPatch = z
  .object({ fr: ConceptLangPatch.optional(), en: ConceptLangPatch.optional() })
  .refine((p) => p.fr !== undefined || p.en !== undefined, "nothing to change");
export type ConceptPatch = z.infer<typeof ConceptPatch>;

/** `POST /concepts/resolve`: what was typed, an id or a label (with its qualifier or not). */
export const ConceptResolveRequest = z.object({
  inputs: z.array(z.string().trim().min(1).max(120)).min(1).max(32),
});
export type ConceptResolveRequest = z.infer<typeof ConceptResolveRequest>;

/**
 * What one typed label designates (ADR-081 addendum §2): one concept;
 * several (homonyms, or an alias two concepts share); or none, with the
 * close "did you mean" candidates when there are some. Candidates best first.
 */
export const ConceptResolution = z.discriminatedUnion("kind", [
  z.object({ input: z.string(), kind: z.literal("resolved"), concept: Concept }),
  z.object({ input: z.string(), kind: z.literal("ambiguous"), candidates: z.array(Concept) }),
  z.object({ input: z.string(), kind: z.literal("unknown"), candidates: z.array(Concept) }),
]);
export type ConceptResolution = z.infer<typeof ConceptResolution>;

/** One resolution per input, in the order of the request. */
export const ConceptResolveResponse = z.object({ results: z.array(ConceptResolution) });
export type ConceptResolveResponse = z.infer<typeof ConceptResolveResponse>;

// ---------------------------------------------------------------------------
// Sorting the existing tags (ADR-081, second addendum 2026-10-08): one
// decision per (pool, tag), reviewed by the admin before the cut-over.
// ---------------------------------------------------------------------------

/** `concept`: the tag maps to a concept. `drop`: it is not one (ADR-081 §1). */
export const TAG_SORTING_DECISIONS = ["concept", "drop"] as const;
export const TagSortingDecisionKind = z.enum(TAG_SORTING_DECISIONS);

/** Why a tag is dropped: an organisational label, a kind of task, or noise (a typo, a test). */
export const TAG_DROP_REASONS = ["organisational", "task_kind", "noise"] as const;
export const TagDropReason = z.enum(TAG_DROP_REASONS);
export type TagDropReason = z.infer<typeof TagDropReason>;

/** One language of a new concept: a label always (a validated concept has both). */
const NewConceptSide = z.object({
  label: ConceptLabel,
  qualifier: ConceptQualifier.optional(),
  description: ConceptDescription.optional(),
});

/**
 * What the model proposed for a pair, kept as it answered; the background
 * job of a later step (purpose `sort`) fills it and defines its shape. A
 * suggested broader concept stays a hint in it (second addendum §2).
 */
export const TagSortingProposal = z.looseObject({ model: z.string() });
export type TagSortingProposal = z.infer<typeof TagSortingProposal>;

/**
 * The stored sorting of one pair. `decision` and what goes with it are the
 * admin's: a row is accepted when it has a decision, and is the model's
 * proposal alone until then.
 */
export const TagSorting = z.object({
  decision: TagSortingDecisionKind.nullable(),
  /** The concept the tag maps to, when the decision is `concept`. */
  concept: Concept.nullable(),
  dropReason: TagDropReason.nullable(),
  proposal: TagSortingProposal.nullable(),
  decidedBy: z.uuid().nullable(),
  decidedAt: z.iso.datetime().nullable(),
});
export type TagSorting = z.infer<typeof TagSorting>;

/** A tag as stored on questions: lowercased, no `#`. */
const StoredTag = z.string().trim().min(1).max(64);

/** One (pool, tag) pair. */
export const TagPair = z.object({ poolId: z.uuid(), tag: StoredTag });
export type TagPair = z.infer<typeof TagPair>;

/**
 * One pair as the sorting screen shows it: the live questions that wear it,
 * the pool tag's description, at most two statement excerpts (from the
 * student view of the latest published version: no answer key, no internal
 * name; none for a parameterized version), the
 * `conceptKey` group it falls in, and its sorting row, if any.
 */
export const TagSortingRow = TagPair.extend({
  poolName: z.string(),
  count: z.number().int().nonnegative(),
  description: z.string(),
  excerpts: z.array(z.string()).max(2),
  group: z.string(),
  sorting: TagSorting.nullable(),
});
export type TagSortingRow = z.infer<typeof TagSortingRow>;

/** `GET /admin/concept-sorting`: every pair, by group (most worn first), then within the group. */
export const TagSortingList = z.object({ rows: z.array(TagSortingRow) });
export type TagSortingList = z.infer<typeof TagSortingList>;

/**
 * What the admin decides for a pair: an existing concept; a NEW concept,
 * created validated with both labels (second addendum §2); or a drop with
 * its reason.
 */
export const TagSortingChoice = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("concept"), conceptId: z.uuid() }),
  z.object({ kind: z.literal("new"), fr: NewConceptSide, en: NewConceptSide }),
  z.object({ kind: z.literal("drop"), reason: TagDropReason }),
]);
export type TagSortingChoice = z.infer<typeof TagSortingChoice>;

export const TagSortingItem = TagPair.extend({ decision: TagSortingChoice });
export type TagSortingItem = z.infer<typeof TagSortingItem>;

/**
 * `POST /admin/concept-sorting/accept`: one transaction. Items carrying the
 * same new labels create ONE concept. A pair appears once.
 */
export const TagSortingAccept = z.object({
  items: z
    .array(TagSortingItem)
    .min(1)
    .max(1000)
    .refine(
      (items) => new Set(items.map((i) => JSON.stringify([i.poolId, i.tag]))).size === items.length,
      "a pair appears once",
    ),
});
export type TagSortingAccept = z.infer<typeof TagSortingAccept>;

/** The accepted rows, in the order of the request, and the concepts the batch created. */
export const TagSortingAcceptResponse = z.object({
  rows: z.array(TagPair.extend({ sorting: TagSorting })),
  created: z.array(Concept),
});
export type TagSortingAcceptResponse = z.infer<typeof TagSortingAcceptResponse>;

/**
 * 409 `concept_exists` of an accept: each concept already holding a key a
 * new concept of the batch asked for, with the items that asked for it, so
 * the screen can remap them onto it.
 */
export const TagSortingConflict = z.object({
  error: z.literal("concept_exists"),
  conflicts: z.array(z.object({ concept: Concept, items: z.array(TagPair) })),
});
export type TagSortingConflict = z.infer<typeof TagSortingConflict>;

/**
 * 422 of an accept naming the items at fault: `tag_unknown` (no live
 * question of the pool wears the tag), `concept_not_found` (the concept is
 * missing or merged), `concept_batch_conflict` (two new concepts of the
 * batch share a key in one language but not in the other).
 */
export const TagSortingItemsError = z.object({
  error: z.enum(["tag_unknown", "concept_not_found", "concept_batch_conflict"]),
  items: z.array(TagPair),
});
export type TagSortingItemsError = z.infer<typeof TagSortingItemsError>;
