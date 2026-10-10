/**
 * `concept` route schemas: the instance-wide vocabulary of concepts that
 * classifies the questions since the cut-over from tags (ADR-081, third
 * addendum 2026-10-08).
 *
 * A concept has a label, a qualifier and a description per language; a
 * `proposed` concept may have one language only. Its identity is its id; a
 * merged concept keeps its row and names, in `mergedInto`, the concept it
 * was merged into.
 */
import { z } from "zod";

import {
  CONCEPT_DESCRIPTION_MAX,
  CONCEPT_LABEL_MAX,
  CONCEPT_LABEL_PATTERN,
  CONCEPT_QUALIFIER_MAX,
} from "@quiz/domain";

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

export const ConceptList = z.object({ concepts: z.array(Concept) });
export type ConceptList = z.infer<typeof ConceptList>;

/**
 * `GET /admin/concepts` (ADR-081 fifth addendum): the curation queue. The
 * default order is `proposed` first, then by label; `status` narrows it and
 * `q` searches the labels of both languages (accents and plurals folded, as
 * the keys are). Paged: `limit` concepts from `offset`.
 */
export const ADMIN_CONCEPT_PAGE = 100;
export const AdminConceptQuery = z.object({
  status: z.enum(["proposed", "validated"]).optional(),
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(ADMIN_CONCEPT_PAGE),
  offset: z.coerce.number().int().min(0).default(0),
});
export type AdminConceptQuery = z.infer<typeof AdminConceptQuery>;

/**
 * A concept as the curation queue shows it. `questionCount` is the number of
 * live (not deleted) questions of the whole instance that use it: a number
 * only, never a pool name or a statement (ADR-054 amended). `deletable` is
 * the database's answer to `DELETE`: no question link at all (a deleted
 * question keeps its link) and no concept merged into it.
 */
export const AdminConcept = Concept.extend({
  questionCount: z.number().int().min(0),
  deletable: z.boolean(),
  /** The proposer's name, or null once their account is gone. */
  creator: z.string().nullable(),
});
export type AdminConcept = z.infer<typeof AdminConcept>;

/** `total` counts what matches the filters; `proposed` counts every proposed concept, whatever the filters. */
export const AdminConceptList = z.object({
  concepts: z.array(AdminConcept),
  total: z.number().int().min(0),
  proposed: z.number().int().min(0),
});
export type AdminConceptList = z.infer<typeof AdminConceptList>;

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

/**
 * `GET /concepts/resolve?input=a&input=b`: what was typed, an id or a label
 * (with its qualifier or not), one `input` parameter each. A read, so that a
 * read-only client (the teacher assistant) may resolve too. Never split on
 * commas: a label may hold one.
 */
export const ConceptResolveQuery = z.object({
  input: z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .pipe(z.array(z.string().trim().min(1).max(120)).min(1).max(32)),
});
export type ConceptResolveQuery = z.infer<typeof ConceptResolveQuery>;

/** Why a tag is dropped: an organisational label, a kind of task, or noise (a typo, a test). */
export const TAG_DROP_REASONS = ["organisational", "task_kind", "noise"] as const;
export const TagDropReason = z.enum(TAG_DROP_REASONS);
export type TagDropReason = z.infer<typeof TagDropReason>;

/**
 * What one typed label designates (ADR-081 addendum §2): one concept;
 * several (homonyms, or an alias two concepts share); or none, with the
 * close "did you mean" candidates when there are some; or the key of a
 * dropped tag. Candidates best first,
 * labelled in the reader's language (`ConceptRef`, defined below).
 */
export const ConceptResolution = z.discriminatedUnion("kind", [
  z.object({ input: z.string(), kind: z.literal("resolved"), concept: ConceptRef }),
  z.object({ input: z.string(), kind: z.literal("ambiguous"), candidates: z.array(ConceptRef) }),
  z.object({ input: z.string(), kind: z.literal("unknown"), candidates: z.array(ConceptRef) }),
  /** No concept, and the key of a tag the admin dropped: a write refuses it even with creation asked (third addendum §4). */
  z.object({ input: z.string(), kind: z.literal("dropped"), reason: TagDropReason }),
]);
export type ConceptResolution = z.infer<typeof ConceptResolution>;

/** One resolution per input, in the order of the request. */
export const ConceptResolveResponse = z.object({ results: z.array(ConceptResolution) });
export type ConceptResolveResponse = z.infer<typeof ConceptResolveResponse>;

// ---------------------------------------------------------------------------
// Links between questions and concepts (ADR-081, third addendum 2026-10-08):
// a write that names concepts, and a concept as a question shows it.
// ---------------------------------------------------------------------------

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
 * candidates are `ConceptRef`s, as those of `GET /concepts/resolve`.
 * `POST` and `PATCH /concepts` answer a label on the stop list with this
 * body too.
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

/**
 * The 409 of `POST` and `PATCH /concepts`: the key asked for is taken, and
 * `concept` is the one holding it, so a picker can pick it instead.
 */
export const ConceptExists = z.object({
  error: z.literal("concept_exists"),
  message: z.string().optional(),
  concept: Concept,
});
export type ConceptExists = z.infer<typeof ConceptExists>;
