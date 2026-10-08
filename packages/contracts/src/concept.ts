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

import {
  CONCEPT_DESCRIPTION_MAX,
  CONCEPT_HINT_MAX,
  CONCEPT_LABEL_MAX,
  CONCEPT_LABEL_PATTERN,
  CONCEPT_QUALIFIER_MAX,
} from "@quiz/domain";

import type { LlmErrorCode } from "./llm.js";

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
  .max(CONCEPT_LABEL_MAX)
  .regex(CONCEPT_LABEL_PATTERN, "a label needs a letter or a digit");
const ConceptQualifier = z.string().trim().max(CONCEPT_QUALIFIER_MAX);
const ConceptDescription = z.string().trim().max(CONCEPT_DESCRIPTION_MAX);

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

/** One language of a proposed new concept: what the model wrote, cleaned; `""` for none. */
const ProposedConceptSide = z.object({
  label: ConceptLabel,
  qualifier: ConceptQualifier,
  description: ConceptDescription,
});

/** What every proposal carries: the model that answered, and its free-text hints. */
const ProposalBase = z.object({
  model: z.string(),
  broader: z.string().max(CONCEPT_HINT_MAX).optional(),
  note: z.string().max(CONCEPT_HINT_MAX).optional(),
});

/**
 * What the model proposed for a pair (the admin's pass, purpose `sort`,
 * second addendum §3): an existing concept (`conceptId`, checked to exist
 * and not be merged when written), a NEW concept with both languages (pairs
 * of one run that name the same new concept carry the same labels, so
 * accepting them creates one), or a drop with its reason. `broader` (a
 * suggested broader concept, a hint only, second addendum §2) and `note`
 * (why, in a few words) are free text. The shape is `SortProposal` of
 * `@quiz/domain`, plus the model.
 */
export const TagSortingProposal = z.discriminatedUnion("kind", [
  ProposalBase.extend({ kind: z.literal("concept"), conceptId: z.uuid() }),
  ProposalBase.extend({
    kind: z.literal("new"),
    newConcept: z.object({ fr: ProposedConceptSide, en: ProposedConceptSide }),
  }),
  ProposalBase.extend({ kind: z.literal("drop"), dropReason: TagDropReason }),
]);
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

// ---------------------------------------------------------------------------
// The model pass that proposes the sorting (second addendum §3): one run at
// a time, started by the admin, in the background.
// ---------------------------------------------------------------------------

/** The gateway's codes that stop a run (no key, an unreadable or refused key, the day's cap): no later call can succeed. */
export const CONCEPT_SORT_STOPPING = [
  "not_configured",
  "key_unreadable",
  "auth_failed",
  "budget_exhausted",
] as const satisfies readonly LlmErrorCode[];
/**
 * Why a run failed: a stopping code; `interrupted`, a run whose heartbeat
 * went silent (its process died); `internal`, anything else.
 */
export const CONCEPT_SORT_RUN_ERRORS = [...CONCEPT_SORT_STOPPING, "interrupted", "internal"] as const;
export const ConceptSortRunError = z.enum(CONCEPT_SORT_RUN_ERRORS);
export type ConceptSortRunError = z.infer<typeof ConceptSortRunError>;

export const CONCEPT_SORT_RUN_STATES = ["running", "done", "failed"] as const;

/**
 * A run of the pass: its progress in `conceptKey` groups (those holding a
 * pair without a decision when it started), its instants, and why it
 * failed. A batch the model failed on counts as done — its pairs keep what
 * they had — and in `batchesFailed`.
 */
export const ConceptSortRun = z.object({
  state: z.enum(CONCEPT_SORT_RUN_STATES),
  groupsDone: z.number().int().nonnegative(),
  groupsTotal: z.number().int().nonnegative(),
  batchesFailed: z.number().int().nonnegative(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  error: ConceptSortRunError.nullable(),
});
export type ConceptSortRun = z.infer<typeof ConceptSortRun>;

/** `GET /admin/concept-sorting/run`, and the answer of `POST /admin/concept-sorting/propose` (202): the last run, null before the first. */
export const ConceptSortRunStatus = z.object({ run: ConceptSortRun.nullable() });
export type ConceptSortRunStatus = z.infer<typeof ConceptSortRunStatus>;

// ---------------------------------------------------------------------------
// Links between questions and concepts (ADR-081, third addendum 2026-10-08):
// a write that names concepts, and a concept as a question shows it.
// ---------------------------------------------------------------------------

/**
 * A concept as a question shows it: its label and qualifier in the reader's
 * language, falling back to the other one (a `proposed` concept may have one
 * language only), and its status.
 */
export const ConceptRef = z.object({
  id: z.uuid(),
  label: z.string(),
  qualifier: z.string(),
  status: ConceptStatus,
});
export type ConceptRef = z.infer<typeof ConceptRef>;

/**
 * Why one input of a write naming concepts is refused (addendum §2, third
 * addendum §4): several exact matches (`concept_ambiguous`), close matches
 * only or none without creation asked (`concept_unknown`, "did you mean"
 * candidates best first, possibly none), or the key of a tag the admin
 * dropped in the sorting, refused even with creation asked
 * (`concept_dropped`, with the drop's reason).
 */
export const ConceptInputError = z.discriminatedUnion("error", [
  z.object({ input: z.string(), error: z.literal("concept_ambiguous"), candidates: z.array(ConceptRef) }),
  z.object({ input: z.string(), error: z.literal("concept_unknown"), candidates: z.array(ConceptRef) }),
  z.object({ input: z.string(), error: z.literal("concept_dropped"), reason: TagDropReason }),
]);
export type ConceptInputError = z.infer<typeof ConceptInputError>;

/**
 * The 422 of a write naming concepts, all or nothing: every input at fault,
 * in the order of the request; `error` is the first one's code. Its
 * candidates are `ConceptRef`s (`POST /concepts/resolve` still answers whole
 * `Concept`s; it moves to `ConceptRef` at the cut-over). `POST` and `PATCH
 * /concepts` answer a label on the stop list with this body too.
 */
export const ConceptWriteRefusal = z.object({
  error: z.enum(["concept_ambiguous", "concept_unknown", "concept_dropped"]),
  message: z.string().optional(),
  errors: z.array(ConceptInputError).min(1),
});
export type ConceptWriteRefusal = z.infer<typeof ConceptWriteRefusal>;

/** The 422 of setting a question's concepts: these ids are missing, or merged. */
export const ConceptNotFound = z.object({
  error: z.literal("concept_not_found"),
  message: z.string().optional(),
  ids: z.array(z.uuid()).min(1),
});
export type ConceptNotFound = z.infer<typeof ConceptNotFound>;
