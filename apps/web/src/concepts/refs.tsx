/**
 * A concept as a question shows it (`ConceptRef`, ADR-081 third addendum) —
 * its label with the qualifier quieter, alone or as a question's list — and
 * the concepts a typed `#word` of the search designates, and the path above
 * a concept in the hierarchy.
 */
import type { Concept, ConceptRef } from "@quiz/contracts";
import { filterIds, resolveConceptLabel } from "@quiz/domain";

import { useT, type Locale } from "../i18n";
import { cx } from "../ui";
import { broaderTrail } from "./names";
import { resolvable } from "./ranking";

/**
 * The path above a concept, `Programming › C` (`broaderTrail`, the picker's
 * rule, ADR-081 sixth addendum §5), quiet and read-only; nothing for a
 * concept with no broader one. With `others`, `+n` counts the broader
 * concepts the path does not follow (the sheet's Relations list them all).
 * `className` replaces the muted ink (the picker's active option has its own).
 */
export function BroaderPath({
  concept,
  byId,
  locale,
  others = false,
  className = "text-fg-muted",
}: {
  concept: Concept;
  byId: ReadonlyMap<string, Concept>;
  locale: Locale;
  others?: boolean;
  className?: string;
}) {
  const t = useT();
  const trail = broaderTrail(concept, byId, locale);
  if (trail.length === 0) return null;
  const more = others ? concept.broader.filter((id) => byId.has(id)).length - 1 : 0;
  return (
    <p className={cx("text-xs", className)}>
      <span className="sr-only">{t("concepts.picker.within")} </span>
      {trail.join(" › ")}
      {more > 0 ? (
        <span className="text-fg-faint">
          {" "}
          {more === 1 ? t("admin.concepts.path.moreOne") : t("admin.concepts.path.more", { n: more })}
        </span>
      ) : null}
    </p>
  );
}

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
