/**
 * A concept as a question shows it (`ConceptRef`, ADR-081 third addendum) —
 * its label with the qualifier quieter, alone or as a question's list — and
 * the concepts a typed `#word` of the search designates.
 */
import type { Concept, ConceptRef } from "@quiz/contracts";
import { filterIds, resolveConceptLabel } from "@quiz/domain";

import { useT } from "../i18n";
import { cx } from "../ui";
import { resolvable } from "./ranking";

/** `Adresse (mémoire)`, the qualifier in a quieter ink: wherever a concept is named in a list. */
export function ConceptLabel({ concept }: { concept: Pick<ConceptRef, "label" | "qualifier"> }) {
  return (
    <>
      {concept.label}
      {concept.qualifier ? <span className="font-normal text-fg-faint"> ({concept.qualifier})</span> : null}
    </>
  );
}

/**
 * The concepts of a question, inline and quiet: on a row of the pool's
 * table, a card. A `proposed` concept is not the vocabulary's yet: dashed
 * underneath, as its chip in the picker is dashed around, and said so to a
 * screen reader.
 */
export function ConceptNames({ concepts, className }: { concepts: readonly ConceptRef[]; className?: string }) {
  const t = useT();
  return (
    // A label may hold several words: a dot between two concepts says where one ends.
    <span className={cx("flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs text-fg-muted", className)}>
      {concepts.map((c, i) => (
        <span key={c.id} className="inline-flex items-baseline gap-x-1.5">
          {i > 0 ? (
            <span aria-hidden className="text-fg-faint">
              ·
            </span>
          ) : null}
          <span
            data-status={c.status}
            className={cx(c.status === "proposed" && "border-b border-dashed border-fg-faint")}
          >
            <ConceptLabel concept={c} />
            {c.status === "proposed" ? <span className="sr-only">, {t("concepts.picker.proposed")}</span> : null}
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * The ids a typed word of the search filters on (third addendum §7), by the
 * server's rule for a filter (`filterIds`): the concept it names, or every
 * homonym it names alike — in either language, with its qualifier or not.
 * Never a merely close one: empty when it names none.
 */
export const conceptIdsOf = (word: string, vocabulary: readonly Concept[]): string[] =>
  filterIds(resolveConceptLabel(word, vocabulary.map(resolvable)));
