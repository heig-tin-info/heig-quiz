/**
 * The pure rules of a WRITE that names concepts (ADR-081, addendum §2 as
 * amended by the third addendum §4): what each typed input of a question
 * write, a picker or an MCP tool becomes — an existing concept, a new
 * `proposed` one, or a refusal — and which label of a concept a reader sees.
 *
 * Creation is explicit: without `create`, an input that resolves to nothing
 * is refused. With it, an input that matches nothing, or only close
 * concepts, becomes a new concept — unless its key is the key of a tag the
 * admin dropped in the sorting (the stop list), so that `c01`,
 * `lecture-de-code` or `prog-c` are never recreated. An existing concept
 * always resolves, the stop list notwithstanding. Several exact matches are
 * always refused: creation never settles an ambiguity.
 */
import {
  CONCEPT_LABEL_MAX,
  CONCEPT_LABEL_PATTERN,
  CONCEPT_QUALIFIER_MAX,
  cleanConceptLabel,
  cleanConceptQualifier,
  conceptKey,
  qualifiedConceptKey,
  resolveConceptLabel,
  splitQualifiedLabel,
  type ConceptLanguage,
  type ResolvableConcept,
} from "./concepts.js";

/** A concept to create, from an input: its cleaned label and qualifier, and their key. */
export interface ConceptToCreate {
  label: string;
  qualifier: string;
  key: string;
}

/** What one input of a write becomes: an existing concept, or the n-th concept to create. */
export type ConceptWriteTarget =
  { kind: "existing"; id: string } | { kind: "new"; index: number };

/** Why one input is refused; candidates are concept ids, best first. */
export type ConceptWriteError<R> =
  | { input: string; error: "concept_ambiguous"; candidates: string[] }
  | { input: string; error: "concept_unknown"; candidates: string[] }
  | { input: string; error: "concept_dropped"; reason: R };

/**
 * The plan of a batch: all its inputs resolved (one target per input, in
 * order, and the concepts to create, each once), or refused as a whole with
 * the error of every input at fault.
 */
export type ConceptWritePlan<R> =
  | { kind: "ok"; targets: ConceptWriteTarget[]; creates: ConceptToCreate[] }
  | { kind: "refused"; errors: ConceptWriteError<R>[] };

/**
 * The concept an input would create: the label and the qualifier it was
 * written with (`adresse (postale)`), cleaned. Null when no valid label
 * comes out of it (no letter nor digit, or too long).
 */
export function conceptToCreate(input: string): ConceptToCreate | null {
  const split = splitQualifiedLabel(input);
  const label = cleanConceptLabel(split?.label ?? input);
  const qualifier = cleanConceptQualifier(split?.qualifier ?? "");
  if (!CONCEPT_LABEL_PATTERN.test(label) || label.length > CONCEPT_LABEL_MAX)
    return null;
  if (qualifier.length > CONCEPT_QUALIFIER_MAX) return null;
  return { label, qualifier, key: qualifiedConceptKey(label, qualifier) };
}

/**
 * Plans a write naming concepts (addendum §2, third addendum §4), all or
 * nothing:
 *
 * - an id, a qualified label or one exact match resolves (a merged id to its
 *   final concept), whatever `create` says;
 * - several exact matches: `concept_ambiguous` with them;
 * - close matches only, or nothing: `concept_unknown` with the close ones,
 *   unless `create` — then a new concept, but `concept_dropped` with the
 *   reason when its bare label is on the stop list ({@link droppedReason}).
 *
 * Inputs that would create concepts with one key create ONE. An input from
 * which no valid label comes out is `concept_unknown`.
 */
export function planConceptWrite<R>(
  inputs: readonly string[],
  concepts: readonly ResolvableConcept[],
  options: { create: boolean; dropped: ReadonlyMap<string, R> },
): ConceptWritePlan<R> {
  const targets: ConceptWriteTarget[] = [];
  const creates: ConceptToCreate[] = [];
  const errors: ConceptWriteError<R>[] = [];
  for (const input of inputs) {
    const outcome = resolveConceptLabel(input, concepts);
    if (outcome.kind === "resolved") {
      targets.push({ kind: "existing", id: outcome.id });
      continue;
    }
    if (outcome.kind === "ambiguous") {
      errors.push({
        input,
        error: "concept_ambiguous",
        candidates: outcome.candidates,
      });
      continue;
    }
    const fresh = options.create ? conceptToCreate(input) : null;
    if (!fresh) {
      errors.push({
        input,
        error: "concept_unknown",
        candidates: outcome.candidates,
      });
      continue;
    }
    const reason = droppedReason(fresh.label, options.dropped);
    if (reason !== null) {
      errors.push({ input, error: "concept_dropped", reason });
      continue;
    }
    let index = creates.findIndex((c) => c.key === fresh.key);
    if (index < 0) index = creates.push(fresh) - 1;
    targets.push({ kind: "new", index });
  }
  return errors.length > 0
    ? { kind: "refused", errors }
    : { kind: "ok", targets, creates };
}

/**
 * The stop list (third addendum §4), the one rule of every write that names
 * a label — a write resolving concepts, `POST /concepts`, a rename: the drop
 * reason when the key of the BARE label (no qualifier) is the `conceptKey`
 * of a tag the admin dropped, else null.
 */
export function droppedReason<R>(
  label: string,
  dropped: ReadonlyMap<string, R>,
): R | null {
  return dropped.get(conceptKey(label)) ?? null;
}

/**
 * The label a reader sees: the one of their language, with its qualifier,
 * else the other language's (a `proposed` concept may have one language
 * only). A concept always has at least one label.
 */
export function conceptLabelIn(
  sides: Record<ConceptLanguage, { label: string | null; qualifier: string }>,
  lang: ConceptLanguage,
): { label: string; qualifier: string } {
  const other: ConceptLanguage = lang === "fr" ? "en" : "fr";
  const side = sides[lang].label !== null ? sides[lang] : sides[other];
  return { label: side.label ?? "", qualifier: side.qualifier };
}
